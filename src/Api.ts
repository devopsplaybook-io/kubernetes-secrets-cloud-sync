import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { StandardTracerFastifyRegisterHooks } from "@devopsplaybook.io/otel-utils-fastify";
import { createHash, timingSafeEqual } from "crypto";
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
 * Only loopback addresses are considered private. Everything else — including
 * `0.0.0.0`, `::`, RFC1918 addresses, pod IPs and hostnames — requires a token.
 */
export function isPrivateBindHost(host: string): boolean {
  const value = String(host ?? "").trim().toLowerCase();
  if (
    value === "localhost" ||
    value === "::1" ||
    value === "[::1]" ||
    value === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  const octets = value.split(".");
  if (octets.length !== 4 || octets[0] !== "127") {
    return false;
  }
  return octets.every(
    (octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255,
  );
}

/**
 * Refuse to start the API on a non-loopback address without a bearer token.
 * Error messages never include the token value.
 */
export function assertSafeApiBinding(config: Config): void {
  const host = String(config.API_HOST ?? "").trim();
  if (host === "") {
    throw new Error(
      "API_HOST must be set: bind API_HOST to 127.0.0.1 or configure API_AUTH_TOKEN for a non-loopback bind",
    );
  }
  const token = String(config.API_AUTH_TOKEN ?? "").trim();
  if (!isPrivateBindHost(host) && token === "") {
    throw new Error(
      `Refusing to start the HTTP API on non-loopback host "${host}" without API_AUTH_TOKEN; bind API_HOST to 127.0.0.1 or configure a bearer token`,
    );
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time bearer token check; hashing first avoids a length leak. */
function hasValidBearerToken(
  header: string | undefined,
  expected: string,
): boolean {
  if (!header) {
    return false;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (!match) {
    return false;
  }
  return timingSafeEqual(digest(match[1]), digest(expected));
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
  // Fail fast so an unsafe server can never be constructed.
  assertSafeApiBinding(config);
  const authToken = String(config.API_AUTH_TOKEN ?? "").trim();
  const moduleLogger = logger.createModuleLogger("api");
  if (authToken !== "") {
    moduleLogger.info("API bearer authentication enabled");
  } else {
    moduleLogger.info(
      "API bearer authentication disabled (loopback-only bind)",
    );
  }
  const app = Fastify({ logger: false, forceCloseConnections: true });
  let lastManualSyncAt: number | undefined;

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

  app.post(
    "/api/sync",
    {
      preHandler: async (request, reply) => {
        if (
          authToken !== "" &&
          !hasValidBearerToken(request.headers.authorization, authToken)
        ) {
          return reply
            .code(401)
            .header(
              "WWW-Authenticate",
              'Bearer realm="kubernetes-secrets-cloud-sync"',
            )
            .send({
              status: "unauthorized",
              message: "A valid bearer token is required",
            });
        }
      },
    },
    async (_request, reply) => {
      // 409 wins over the cooldown so callers can tell a run is in flight.
      if (runner.isRunning()) {
        return reply.code(409).send({
          status: "already_running",
          message: "A sync is already in progress",
        });
      }
      // Read per request so a config reload applies without a restart.
      const configuredInterval = Number(config.API_SYNC_MIN_INTERVAL_SECONDS);
      const cooldownMs =
        Number.isFinite(configuredInterval) && configuredInterval > 0
          ? configuredInterval * 1000
          : 0;
      const now = Date.now();
      if (cooldownMs > 0 && lastManualSyncAt !== undefined) {
        const elapsedMs = now - lastManualSyncAt;
        if (elapsedMs < cooldownMs) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((cooldownMs - elapsedMs) / 1000),
          );
          return reply
            .code(429)
            .header("Retry-After", String(retryAfterSeconds))
            .send({
              status: "rate_limited",
              message: "A manual sync was requested recently; retry later",
            });
        }
      }
      lastManualSyncAt = now;
      runner
        .run()
        .catch((error) =>
          moduleLogger.error("Manual sync failed", toError(error)),
        );
      return reply.code(202).send({ status: "accepted" });
    },
  );

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
