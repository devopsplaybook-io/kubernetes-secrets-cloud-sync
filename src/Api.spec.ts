import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { FastifyInstance } from "fastify";
import { SyncStatus, createApiServer } from "./Api";
import { Config } from "./Config";
import { SingleFlightRunner } from "./SyncRunner";
import { SyncRunResult } from "./types";

jest.mock("@devopsplaybook.io/otel-utils-fastify", () => ({
  StandardTracerFastifyRegisterHooks: jest.fn(),
}));

const { StandardTracerFastifyRegisterHooks: mockRegisterHooks } =
  jest.requireMock("@devopsplaybook.io/otel-utils-fastify") as {
    StandardTracerFastifyRegisterHooks: jest.Mock;
  };

function syncResult(overrides: Partial<SyncRunResult> = {}): SyncRunResult {
  return {
    namespaces: 1,
    secrets: 2,
    succeededSecrets: 2,
    errors: 0,
    failedNamespaces: [],
    namespaceListSucceeded: true,
    durationMs: 5,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const config = {
  SERVICE_ID: "kubernetes-secrets-cloud-sync",
  VERSION: "0.10.0",
} as unknown as Config;
const tracer = {} as StandardTracer;

let app: FastifyInstance | undefined;

function build(
  task: () => Promise<SyncRunResult> = async () => syncResult(),
) {
  const runner = new SingleFlightRunner(task);
  const status = new SyncStatus();
  const moduleLogger = { error: jest.fn() };
  const logger = {
    createModuleLogger: jest.fn(() => moduleLogger),
  } as unknown as StandardLogger;

  app = createApiServer({ config, runner, status, tracer, logger });
  return { app, runner, status, moduleLogger, logger };
}

async function getStatus() {
  return app!.inject({ method: "GET", url: "/api/status" });
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  jest.clearAllMocks();
});

describe("createApiServer", () => {
  it("registers the OTel hooks once, without a meter and without tracing probes", () => {
    const { logger } = build();

    expect(mockRegisterHooks).toHaveBeenCalledTimes(1);
    const [fastify, tracerArg, loggerArg, options] = mockRegisterHooks.mock
      .calls[0];
    expect(fastify).toBe(app);
    expect(tracerArg).toBe(tracer);
    expect(loggerArg).toBe(logger);
    expect(options).toEqual({
      rootApiPath: "/api",
      ignoreList: ["GET-/api/status"],
      unmatchedRouteSpanName: "method",
    });
    expect(options).not.toHaveProperty("standardMeter");
  });

  it("reports a healthy initial status", async () => {
    build();

    const response = await getStatus();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      status: "ok",
      service: "kubernetes-secrets-cloud-sync",
      version: "0.10.0",
      mode: "deployment",
      running: true,
      config: { valid: true, issues: [] },
      scheduler: { cron: null },
      sync: {
        inFlight: false,
        lastStart: null,
        lastEnd: null,
        lastOutcome: null,
        lastError: null,
        lastResult: null,
      },
    });
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  it("reports an in-flight sync", async () => {
    const gate = deferred<SyncRunResult>();
    const { runner } = build(() => gate.promise);

    const running = runner.run();
    const response = await getStatus();
    expect(response.json().sync.inFlight).toBe(true);

    gate.resolve(syncResult());
    await running;
  });

  it("derives the outcome from a clean run", async () => {
    const { status } = build();

    status.markRunStarted();
    status.markRunSucceeded(syncResult());

    const body = (await getStatus()).json();
    expect(body.sync.lastOutcome).toBe("success");
    expect(body.sync.lastError).toBeNull();
    expect(body.sync.lastResult).toMatchObject({
      namespaces: 1,
      secrets: 2,
      succeededSecrets: 2,
      errors: 0,
    });
    expect(body.sync.lastEnd).not.toBeNull();
  });

  it("derives a partial outcome when some operations failed", async () => {
    const { status } = build();

    status.markRunSucceeded(
      syncResult({ secrets: 2, succeededSecrets: 1, errors: 1 }),
    );

    expect((await getStatus()).json().sync.lastOutcome).toBe("partial");
  });

  it("derives a failure when nothing requested could be fetched", async () => {
    const { status } = build();

    status.markRunSucceeded(
      syncResult({ secrets: 2, succeededSecrets: 0, errors: 2 }),
    );

    expect((await getStatus()).json().sync.lastOutcome).toBe("failure");
  });

  it("derives a failure when the namespace listing failed", async () => {
    const { status } = build();

    status.markRunSucceeded(
      syncResult({ namespaces: 0, namespaceListSucceeded: false }),
    );

    expect((await getStatus()).json().sync.lastOutcome).toBe("failure");
  });

  it("reports a failed run with its error message", async () => {
    const { status } = build();

    status.markRunStarted();
    status.markRunFailed(new Error("cloud unreachable"));

    const body = (await getStatus()).json();
    expect(body.sync.lastOutcome).toBe("failure");
    expect(body.sync.lastError).toBe("cloud unreachable");
    expect(body.sync.lastResult).toBeNull();
  });

  it("returns 503 and the issues when the configuration is invalid", async () => {
    const { status } = build();

    status.setConfigIssues(['Invalid SYNC_CRON_SCHEDULE: "bad"']);

    const response = await getStatus();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      config: {
        valid: false,
        issues: ['Invalid SYNC_CRON_SCHEDULE: "bad"'],
      },
    });
  });

  it("reports the active scheduler expression", async () => {
    const { status } = build();

    status.setScheduler("*/5 * * * *");

    expect((await getStatus()).json().scheduler).toEqual({ cron: "*/5 * * * *" });
  });

  it("accepts a manual sync with 202 and runs it once", async () => {
    const gate = deferred<SyncRunResult>();
    const task = jest.fn(() => gate.promise);
    const { runner } = build(task);

    const response = await app!.inject({ method: "POST", url: "/api/sync" });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(task).toHaveBeenCalledTimes(1);
    expect((await getStatus()).json().sync.inFlight).toBe(true);

    gate.resolve(syncResult());
    await runner.whenIdle();
    expect(runner.isRunning()).toBe(false);
  });

  it("rejects a manual sync with 409 while a run is in progress", async () => {
    const gate = deferred<SyncRunResult>();
    const task = jest.fn(() => gate.promise);
    const { runner } = build(task);

    const running = runner.run();
    const response = await app!.inject({ method: "POST", url: "/api/sync" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      status: "already_running",
      message: "A sync is already in progress",
    });
    expect(task).toHaveBeenCalledTimes(1);

    gate.resolve(syncResult());
    await running;
  });

  it("accepts a new manual sync after the previous one completed", async () => {
    const task = jest.fn(async () => syncResult());
    const { runner } = build(task);

    const first = await app!.inject({ method: "POST", url: "/api/sync" });
    expect(first.statusCode).toBe(202);
    await runner.whenIdle();

    const second = await app!.inject({ method: "POST", url: "/api/sync" });
    expect(second.statusCode).toBe(202);
    await runner.whenIdle();

    expect(task).toHaveBeenCalledTimes(2);
  });

  it("logs a rejected manual sync without leaking an unhandled rejection", async () => {
    const task = jest.fn(async () => {
      throw new Error("boom");
    });
    const { runner, moduleLogger } = build(task);

    const response = await app!.inject({ method: "POST", url: "/api/sync" });
    expect(response.statusCode).toBe(202);

    await runner.whenIdle();
    expect(moduleLogger.error).toHaveBeenCalledWith(
      "Manual sync failed",
      expect.any(Error),
    );
  });

  it("returns 404 for unknown routes", async () => {
    build();

    const response = await app!.inject({ method: "GET", url: "/api/unknown" });

    expect(response.statusCode).toBe(404);
  });

  it("hides internal error details behind a generic 500", async () => {
    build();
    app!.get("/api/__boom", async () => {
      throw new Error("internal detail");
    });

    const response = await app!.inject({ method: "GET", url: "/api/__boom" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      status: "error",
      message: "Internal Server Error",
    });
    expect(response.payload).not.toContain("internal detail");
  });
});
