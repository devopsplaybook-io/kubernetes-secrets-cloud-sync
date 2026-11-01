import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { FastifyInstance } from "fastify";
import {
  SyncStatus,
  assertSafeApiBinding,
  createApiServer,
  isPrivateBindHost,
} from "./Api";
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
    unknownProviders: [],
    unavailableProviders: [],
    cleanupAborted: false,
    deadlineExceeded: false,
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

const tracer = {} as StandardTracer;

let app: FastifyInstance | undefined;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    SERVICE_ID: "kubernetes-secrets-cloud-sync",
    VERSION: "0.10.0",
    API_HOST: "127.0.0.1",
    API_AUTH_TOKEN: "",
    API_SYNC_MIN_INTERVAL_SECONDS: 0,
    ...overrides,
  } as unknown as Config;
}

function build(
  task: () => Promise<SyncRunResult> = async () => syncResult(),
  configOverrides: Partial<Config> = {},
) {
  const runner = new SingleFlightRunner(task);
  const status = new SyncStatus();
  const moduleLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const logger = {
    createModuleLogger: jest.fn(() => moduleLogger),
  } as unknown as StandardLogger;
  const config = makeConfig(configOverrides);

  app = createApiServer({ config, runner, status, tracer, logger });
  return { app, runner, status, moduleLogger, logger, config };
}

async function getStatus() {
  return app!.inject({ method: "GET", url: "/api/status" });
}

async function postSync(headers?: Record<string, string>) {
  return app!.inject({ method: "POST", url: "/api/sync", headers });
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe("isPrivateBindHost", () => {
  it("accepts loopback addresses", () => {
    for (const host of [
      "127.0.0.1",
      "127.1.2.3",
      "localhost",
      "LOCALHOST",
      " localhost ",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
    ]) {
      expect(isPrivateBindHost(host)).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const host of [
      "0.0.0.0",
      "::",
      "10.0.0.1",
      "192.168.1.1",
      "127.0.0.256",
      "127.0.0",
      "example.com",
      "",
    ]) {
      expect(isPrivateBindHost(host)).toBe(false);
    }
  });
});

describe("assertSafeApiBinding", () => {
  it("allows a loopback bind without a token", () => {
    expect(() =>
      assertSafeApiBinding(makeConfig({ API_HOST: "127.0.0.1" })),
    ).not.toThrow();
  });

  it("rejects a blank host", () => {
    expect(() =>
      assertSafeApiBinding(makeConfig({ API_HOST: "   " })),
    ).toThrow(/API_HOST/);
  });

  it("rejects a non-private bind without a token", () => {
    expect(() =>
      assertSafeApiBinding(makeConfig({ API_HOST: "0.0.0.0" })),
    ).toThrow(/non-loopback host "0\.0\.0\.0" without API_AUTH_TOKEN/);
  });

  it("allows a non-private bind when a token is configured", () => {
    expect(() =>
      assertSafeApiBinding(
        makeConfig({ API_HOST: "0.0.0.0", API_AUTH_TOKEN: "  token  " }),
      ),
    ).not.toThrow();
  });

  it("never includes the token in the error", () => {
    const token = "do-not-print-me";
    let message = "";
    try {
      assertSafeApiBinding(
        makeConfig({ API_HOST: "", API_AUTH_TOKEN: token }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("API_HOST");
    expect(message).not.toContain(token);
  });
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

  it("throws when constructed on a non-private bind without a token", () => {
    expect(() => build(undefined, { API_HOST: "0.0.0.0" })).toThrow(
      /non-loopback host/,
    );
  });

  it("logs the authentication state without the token", async () => {
    const { moduleLogger } = build();
    expect(moduleLogger.info).toHaveBeenCalledWith(
      "API bearer authentication disabled (loopback-only bind)",
    );
    await app!.close();
    app = undefined;

    const { moduleLogger: enabledLogger } = build(undefined, {
      API_AUTH_TOKEN: "super-secret-token",
    });
    expect(enabledLogger.info).toHaveBeenCalledWith(
      "API bearer authentication enabled",
    );
    const calls = [
      ...enabledLogger.info.mock.calls,
      ...enabledLogger.warn.mock.calls,
      ...enabledLogger.error.mock.calls,
    ];
    expect(JSON.stringify(calls)).not.toContain("super-secret-token");
  });

  describe("bearer authentication", () => {
    const token = "correct-token";

    it("rejects a request without a token", async () => {
      build(async () => syncResult(), { API_AUTH_TOKEN: token });

      const response = await postSync();

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe(
        'Bearer realm="kubernetes-secrets-cloud-sync"',
      );
      expect(response.json()).toEqual({
        status: "unauthorized",
        message: "A valid bearer token is required",
      });
    });

    it("rejects a wrong token", async () => {
      const task = jest.fn(async () => syncResult());
      build(task, { API_AUTH_TOKEN: token });

      const response = await postSync({ authorization: "Bearer wrong-token" });

      expect(response.statusCode).toBe(401);
      expect(task).not.toHaveBeenCalled();
    });

    it("rejects a malformed authorization header", async () => {
      const task = jest.fn(async () => syncResult());
      build(task, { API_AUTH_TOKEN: token });

      const response = await postSync({ authorization: "Basic dXNlcjpwYXNz" });

      expect(response.statusCode).toBe(401);
      expect(task).not.toHaveBeenCalled();
    });

    it("accepts a matching token with a case-insensitive scheme", async () => {
      const task = jest.fn(async () => syncResult());
      const { runner } = build(task, { API_AUTH_TOKEN: token });

      const response = await postSync({ authorization: `bearer ${token}` });

      expect(response.statusCode).toBe(202);
      await runner.whenIdle();
      expect(task).toHaveBeenCalledTimes(1);
    });

    it("keeps GET /api/status open", async () => {
      build(async () => syncResult(), { API_AUTH_TOKEN: token });

      expect((await getStatus()).statusCode).toBe(200);
    });

    it("still returns 409 for a valid token while a run is in flight", async () => {
      const gate = deferred<SyncRunResult>();
      const task = jest.fn(() => gate.promise);
      const { runner } = build(task, { API_AUTH_TOKEN: token });
      const running = runner.run();

      const response = await postSync({ authorization: `Bearer ${token}` });

      expect(response.statusCode).toBe(409);
      expect(task).toHaveBeenCalledTimes(1);

      gate.resolve(syncResult());
      await running;
    });
  });

  describe("manual sync cooldown", () => {
    it("rejects a second request inside the interval, then accepts after it", async () => {
      let now = 1_000_000;
      jest.spyOn(Date, "now").mockImplementation(() => now);
      const task = jest.fn(async () => syncResult());
      const { runner } = build(task, { API_SYNC_MIN_INTERVAL_SECONDS: 60 });

      expect((await postSync()).statusCode).toBe(202);
      await runner.whenIdle();

      const second = await postSync();
      expect(second.statusCode).toBe(429);
      const retryAfter = Number(second.headers["retry-after"]);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(second.json()).toEqual({
        status: "rate_limited",
        message: "A manual sync was requested recently; retry later",
      });
      expect(task).toHaveBeenCalledTimes(1);

      now += 60_000;
      expect((await postSync()).statusCode).toBe(202);
      await runner.whenIdle();
      expect(task).toHaveBeenCalledTimes(2);
    });

    it("gives 409 precedence over 429 while a run is in flight", async () => {
      let now = 2_000_000;
      jest.spyOn(Date, "now").mockImplementation(() => now);
      const gate = deferred<SyncRunResult>();
      const task = jest.fn(() => gate.promise);
      const { runner } = build(task, { API_SYNC_MIN_INTERVAL_SECONDS: 60 });

      expect((await postSync()).statusCode).toBe(202);
      // The run started by the first request is still in flight.
      expect((await postSync()).statusCode).toBe(409);

      gate.resolve(syncResult());
      await runner.whenIdle();
    });

    it("does not consume the cooldown for rejected unauthenticated requests", async () => {
      jest.spyOn(Date, "now").mockImplementation(() => 3_000_000);
      const task = jest.fn(async () => syncResult());
      const { runner } = build(task, {
        API_AUTH_TOKEN: "tok",
        API_SYNC_MIN_INTERVAL_SECONDS: 60,
      });

      expect(
        (await postSync({ authorization: "Bearer wrong" })).statusCode,
      ).toBe(401);
      expect(
        (await postSync({ authorization: "Bearer tok" })).statusCode,
      ).toBe(202);

      await runner.whenIdle();
      expect(task).toHaveBeenCalledTimes(1);
    });
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

  it("derives a failure when the cycle deadline was exceeded", async () => {
    const { status } = build();

    status.markRunSucceeded(
      syncResult({ secrets: 2, succeededSecrets: 1, deadlineExceeded: true }),
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
