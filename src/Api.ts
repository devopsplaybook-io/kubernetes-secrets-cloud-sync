import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { StandardTracerFastifyRegisterHooks } from "@devopsplaybook.io/otel-utils-fastify";
import Fastify, { FastifyError, FastifyInstance } from "fastify";
import { Config } from "./Config";
import { toError } from "./OTelContext";
import { SingleFlightRunner } from "./SyncRunner";
import { SyncRunResult } from "./types";

export type SyncOutcome = "success" | "partial" | "failure";

export interface SyncStatusSnapshot {
  status: "ok" | "degraded";
  uptimeSeconds: number;
  config: { valid: boolean; issues: string[] };
  scheduler: { cron: string | null };
  sync: {
    inFlight: boolean;
    lastStart: string | null;
    lastEnd: string | null;
    lastOutcome: SyncOutcome | null;
    lastError: string | null;
    lastResult: SyncRunResult | null;
  };
}

export interface ApiStatusSnapshot extends SyncStatusSnapshot {
  service: string;
  version: string;
  mode: "deployment";
  running: true;
}

export interface CreateApiServerOptions {
  config: Config;
  runner: SingleFlightRunner<SyncRunResult>;
  status: SyncStatus;
  tracer: StandardTracer;
  logger: StandardLogger;
}

function outcomeOf(result: SyncRunResult): SyncOutcome {
  if (result.deadlineExceeded) {
    return "failure";
  }
  if (!result.namespaceListSucceeded) {
    return "failure";
  }
  if (result.secrets > 0 && result.succeededSecrets === 0) {
    return "failure";
  }
  return result.errors > 0 ? "partial" : "success";
}

/**
 * In-memory health and last-run state served by `GET /api/status`. It resets
 * on restart and is meant for readiness probes and diagnostics only.
 */
export class SyncStatus {
  private readonly startedAt = Date.now();
  private lastStart: string | null = null;
  private lastEnd: string | null = null;
  private lastOutcome: SyncOutcome | null = null;
  private lastError: string | null = null;
  private lastResult: SyncRunResult | null = null;
  private schedulerExpression: string | null = null;
  private configIssues: string[] = [];

  markRunStarted(): void {
    this.lastStart = new Date().toISOString();
  }

  markRunSucceeded(result: SyncRunResult): void {
    this.lastEnd = new Date().toISOString();
    this.lastOutcome = outcomeOf(result);
    this.lastError = null;
    this.lastResult = {
      ...result,
      failedNamespaces: [...result.failedNamespaces],
    };
  }

  markRunFailed(error: unknown): void {
    this.lastEnd = new Date().toISOString();
    this.lastOutcome = "failure";
    this.lastError = toError(error).message;
    this.lastResult = null;
  }

  setScheduler(expression: string | null): void {
    this.schedulerExpression = expression;
  }

  setConfigIssues(issues: string[]): void {
    this.configIssues = [...issues];
  }

  snapshot(inFlight: boolean): SyncStatusSnapshot {
    return {
      status: this.configIssues.length === 0 ? "ok" : "degraded",
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      config: {
        valid: this.configIssues.length === 0,
        issues: [...this.configIssues],
      },
      scheduler: { cron: this.schedulerExpression },
      sync: {
        inFlight,
        lastStart: this.lastStart,
        lastEnd: this.lastEnd,
        lastOutcome: this.lastOutcome,
        lastError: this.lastError,
        lastResult: this.lastResult,
      },
    };
  }
}

export function createApiServer(
  options: CreateApiServerOptions,
): FastifyInstance {
  const { config, runner, status, tracer, logger } = options;
  const moduleLogger = logger.createModuleLogger("api");
  const app = Fastify({ logger: false, forceCloseConnections: true });

  StandardTracerFastifyRegisterHooks(app, tracer, logger, {
    rootApiPath: "/api",
    // Probes hit this route every few seconds: tracing them would only add noise.
    ignoreList: ["GET-/api/status"],
    unmatchedRouteSpanName: "method",
    // No standardMeter: this service deliberately emits no custom metrics.
  });

  app.get("/api/status", async (_request, reply) => {
    const snapshot: ApiStatusSnapshot = {
      ...status.snapshot(runner.isRunning()),
      service: config.SERVICE_ID,
      version: config.VERSION,
      mode: "deployment",
      running: true,
    };
    return reply.code(snapshot.status === "ok" ? 200 : 503).send(snapshot);
  });

  app.post("/api/sync", async (_request, reply) => {
    if (runner.isRunning()) {
      return reply.code(409).send({
        status: "already_running",
        message: "A sync is already in progress",
      });
    }
    runner
      .run()
      .catch((error) => moduleLogger.error("Manual sync failed", toError(error)));
    return reply.code(202).send({ status: "accepted" });
  });

  // Never return internal error messages to HTTP clients: the OTel plugin has
  // already logged the error with trace context.
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    const statusCode =
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
        ? error.statusCode
        : 500;
    reply.code(statusCode).send({
      status: "error",
      message: statusCode === 500 ? "Internal Server Error" : error.message,
    });
  });

  return app;
}
