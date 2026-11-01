import { jobExitCode, main } from "./App";
import { SyncRunResult } from "./types";

jest.mock("node-cron", () => {
  const schedule = jest.fn(() => ({ destroy: jest.fn(async () => undefined) }));
  const validate = jest.fn();
  return {
    __esModule: true,
    default: { schedule, validate },
    __schedule: schedule,
    __validate: validate,
  };
});

jest.mock("fs-extra", () => ({ watchFile: jest.fn() }));

jest.mock("./Api", () => {
  const statusInstance = {
    markRunStarted: jest.fn(),
    markRunSucceeded: jest.fn(),
    markRunFailed: jest.fn(),
    setScheduler: jest.fn(),
    setConfigIssues: jest.fn(),
    snapshot: jest.fn(),
  };
  const server = {
    listen: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
  };
  return {
    SyncStatus: jest.fn(() => statusInstance),
    createApiServer: jest.fn(() => server),
    __statusInstance: statusInstance,
    __apiServer: server,
  };
});

jest.mock("@devopsplaybook.io/otel-utils", () => ({
  StandardTracer: jest.fn(() => ({
    shutdown: jest.fn(async () => undefined),
  })),
  StandardMeter: jest.fn(() => ({
    shutdown: jest.fn(async () => undefined),
  })),
}));

jest.mock("./OTelContext", () => {
  const moduleLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const standardLogger = {
    initOTel: jest.fn(),
    shutdown: jest.fn(async () => undefined),
    createModuleLogger: jest.fn(() => moduleLogger),
  };
  return {
    OTelLogger: jest.fn(() => standardLogger),
    OTelSetTracer: jest.fn(),
    OTelTracer: jest.fn(),
    toError: (value: unknown) =>
      value instanceof Error ? value : new Error(String(value)),
    __moduleLogger: moduleLogger,
    __standardLogger: standardLogger,
  };
});

jest.mock("./Config", () => {
  const instance = {
    CONFIG_FILE: "config.json",
    SYNC_CRON_SCHEDULE: "*/5 * * * *",
    JOB_MODE: false,
    SYNC_ALLOWED_PARTIAL_FAILURES: 0,
    API_PORT: 8080,
    API_HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    ANNOTATION_PREFIX: "secrets.cloudsync.devopsplaybook.io",
    SECRET_NAME_PREFIX: "cloudsync-",
    ALIBABA_KMS_REGION: "",
    ALIBABA_KMS_ACCESS_KEY_ID: "",
    ALIBABA_KMS_ACCESS_KEY_SECRET: "",
    AWS_SECRETSMANAGER_REGION: "",
    AWS_SECRETSMANAGER_ACCESS_KEY_ID: "",
    AWS_SECRETSMANAGER_SECRET_ACCESS_KEY: "",
    OPENTELEMETRY_COLLECTOR_HTTP_TRACES: "",
    OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "",
    OPENTELEMETRY_COLLECTOR_HTTP_LOGS: "",
    OPENTELEMETRY_COLLECTOR_AWS: false,
    OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS: 60,
    OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS: 60,
    OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: "",
    reload: jest.fn(async () => undefined),
  };
  return {
    Config: jest.fn(() => instance),
    __configInstance: instance,
  };
});

jest.mock("./KubernetesClient", () => ({
  KubernetesClient: jest.fn(() => ({})),
}));

jest.mock("./SecretSync", () => {
  const instance = { runSync: jest.fn() };
  return {
    SecretSync: jest.fn(() => instance),
    __secretSyncInstance: instance,
  };
});

jest.mock("./sources/AlibabaKmsSource", () => {
  const instance = {
    providerName: "alibaba-kms",
    init: jest.fn(async () => undefined),
    isAvailable: jest.fn(() => false),
  };
  return {
    AlibabaKmsSource: jest.fn(() => instance),
    __alibabaSource: instance,
  };
});

jest.mock("./sources/AwsSecretsManagerSource", () => ({
  AwsSecretsManagerSource: jest.fn(() => ({
    providerName: "aws-secretsmanager",
    init: jest.fn(async () => undefined),
    isAvailable: jest.fn(() => false),
  })),
}));

jest.mock("./sources/ResticSource", () => ({
  ResticSource: jest.fn(() => ({
    providerName: "restic",
    init: jest.fn(async () => undefined),
    isAvailable: jest.fn(() => false),
  })),
}));

const { __configInstance: configInstance } = jest.requireMock("./Config") as {
  __configInstance: Record<string, any>;
};
const { __secretSyncInstance: secretSyncInstance } = jest.requireMock(
  "./SecretSync",
) as { __secretSyncInstance: { runSync: jest.Mock } };
const { __alibabaSource: alibabaSource } = jest.requireMock(
  "./sources/AlibabaKmsSource",
) as { __alibabaSource: { init: jest.Mock } };
const { __schedule: mockSchedule, __validate: mockValidate } = jest.requireMock(
  "node-cron",
) as { __schedule: jest.Mock; __validate: jest.Mock };
const { watchFile: mockWatchFile } = jest.requireMock("fs-extra") as {
  watchFile: jest.Mock;
};
const { __moduleLogger: appLogger, __standardLogger: standardLogger } =
  jest.requireMock("./OTelContext") as {
    __moduleLogger: {
      info: jest.Mock;
      warn: jest.Mock;
      error: jest.Mock;
    };
    __standardLogger: {
      initOTel: jest.Mock;
      shutdown: jest.Mock;
      createModuleLogger: jest.Mock;
    };
  };
const { StandardTracer, StandardMeter } = jest.requireMock(
  "@devopsplaybook.io/otel-utils",
) as { StandardTracer: jest.Mock; StandardMeter: jest.Mock };
const {
  __statusInstance: statusInstance,
  __apiServer: apiServer,
  createApiServer: mockCreateApiServer,
} = jest.requireMock("./Api") as {
  __statusInstance: {
    markRunStarted: jest.Mock;
    markRunSucceeded: jest.Mock;
    markRunFailed: jest.Mock;
    setScheduler: jest.Mock;
    setConfigIssues: jest.Mock;
  };
  __apiServer: { listen: jest.Mock; close: jest.Mock };
  createApiServer: jest.Mock;
};

function syncResult(overrides: Partial<SyncRunResult> = {}): SyncRunResult {
  return {
    namespaces: 0,
    secrets: 0,
    succeededSecrets: 0,
    errors: 0,
    failedNamespaces: [],
    namespaceListSucceeded: true,
    unknownProviders: [],
    unavailableProviders: [],
    cleanupAborted: false,
    deadlineExceeded: false,
    durationMs: 1,
    ...overrides,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition not met before timeout");
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function mockExit(): { spy: jest.SpyInstance; codes: number[] } {
  const codes: number[] = [];
  const spy = jest
    .spyOn(process, "exit")
    .mockImplementation(((code?: number) => {
      codes.push(code ?? 0);
    }) as never);
  return { spy, codes };
}

describe("jobExitCode", () => {
  it("fails when the namespace listing failed", () => {
    expect(
      jobExitCode(syncResult({ namespaceListSucceeded: false }), 0),
    ).toBe(1);
  });

  it("fails when the cycle deadline was exceeded", () => {
    expect(jobExitCode(syncResult({ deadlineExceeded: true }), 0)).toBe(1);
  });

  it("fails when errors exceed the allowed threshold", () => {
    expect(jobExitCode(syncResult({ errors: 2 }), 1)).toBe(1);
  });

  it("passes when errors are within the allowed threshold", () => {
    expect(
      jobExitCode(
        syncResult({ secrets: 2, succeededSecrets: 1, errors: 2 }),
        2,
      ),
    ).toBe(0);
  });

  it("fails when nothing requested could be fetched", () => {
    expect(jobExitCode(syncResult({ secrets: 2, succeededSecrets: 0 }), 0)).toBe(
      1,
    );
  });

  it("passes a clean run", () => {
    expect(
      jobExitCode(syncResult({ secrets: 2, succeededSecrets: 2 }), 0),
    ).toBe(0);
  });

  it("passes when nothing was requested", () => {
    expect(jobExitCode(syncResult(), 0)).toBe(0);
  });
});

describe("App main", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configInstance.SYNC_CRON_SCHEDULE = "*/5 * * * *";
    configInstance.JOB_MODE = false;
    configInstance.SYNC_ALLOWED_PARTIAL_FAILURES = 0;
    configInstance.API_PORT = 8080;
    configInstance.API_HOST = "0.0.0.0";
    configInstance.LOG_LEVEL = "info";
    configInstance.ANNOTATION_PREFIX = "secrets.cloudsync.devopsplaybook.io";
    configInstance.reload.mockResolvedValue(undefined);
    secretSyncInstance.runSync.mockReset();
    secretSyncInstance.runSync.mockResolvedValue(syncResult());
    mockValidate.mockReturnValue(true);
    mockSchedule.mockReset();
    mockSchedule.mockImplementation(() => ({
      destroy: jest.fn(async () => undefined),
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("schedules the cron before running the initial sync", async () => {
    await main();

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const [expression, , options] = mockSchedule.mock.calls[0];
    expect(expression).toBe("*/5 * * * *");
    expect(options).toEqual({ noOverlap: true });
    expect(typeof mockSchedule.mock.calls[0][1]).toBe("function");
    expect(secretSyncInstance.runSync).toHaveBeenCalledTimes(1);
    expect(mockSchedule.mock.invocationCallOrder[0]).toBeLessThan(
      secretSyncInstance.runSync.mock.invocationCallOrder[0],
    );
    expect(statusInstance.setScheduler).toHaveBeenCalledWith("*/5 * * * *");
    expect(statusInstance.setConfigIssues).toHaveBeenCalledWith([]);
  });

  it("starts the HTTP API before scheduling and the initial sync", async () => {
    await main();

    expect(mockCreateApiServer).toHaveBeenCalledTimes(1);
    const options = mockCreateApiServer.mock.calls[0][0];
    expect(options.config).toBe(configInstance);
    expect(options.status).toBe(statusInstance);
    expect(options.runner).toBeDefined();
    expect(options.tracer).toBe(StandardTracer.mock.results[0].value);
    expect(options.logger).toBe(standardLogger);
    expect(apiServer.listen).toHaveBeenCalledWith({
      port: 8080,
      host: "0.0.0.0",
    });
    expect(apiServer.listen.mock.invocationCallOrder[0]).toBeLessThan(
      mockSchedule.mock.invocationCallOrder[0],
    );
    expect(apiServer.listen.mock.invocationCallOrder[0]).toBeLessThan(
      secretSyncInstance.runSync.mock.invocationCallOrder[0],
    );
  });

  it("records sync lifecycle in the shared status tracker", async () => {
    secretSyncInstance.runSync.mockResolvedValue(syncResult({ namespaces: 1 }));

    await main();

    expect(statusInstance.markRunStarted).toHaveBeenCalledTimes(1);
    expect(statusInstance.markRunSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ namespaces: 1 }),
    );
    expect(statusInstance.markRunFailed).not.toHaveBeenCalled();
    expect(statusInstance.markRunStarted.mock.invocationCallOrder[0]).toBeLessThan(
      secretSyncInstance.runSync.mock.invocationCallOrder[0],
    );
  });

  it("records a failed initial sync in the status tracker", async () => {
    secretSyncInstance.runSync.mockRejectedValue(new Error("boom"));

    await main();

    expect(statusInstance.markRunFailed).toHaveBeenCalledWith(
      expect.any(Error),
    );
  });

  it("fails startup on an invalid cron schedule before initializing", async () => {
    mockValidate.mockReturnValue(false);

    await expect(main()).rejects.toThrow(/Invalid SYNC_CRON_SCHEDULE/);

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(secretSyncInstance.runSync).not.toHaveBeenCalled();
    expect(mockCreateApiServer).not.toHaveBeenCalled();
    expect(apiServer.listen).not.toHaveBeenCalled();
  });

  it("logs a failed source init and still starts the cron and initial sync", async () => {
    alibabaSource.init.mockRejectedValueOnce(new Error("bad credentials"));

    await main();

    expect(appLogger.error).toHaveBeenCalledWith(
      "Failed to initialize secret source alibaba-kms",
      expect.any(Error),
    );
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(secretSyncInstance.runSync).toHaveBeenCalledTimes(1);
  });

  it("does not start a second sync when a cron tick fires during a run", async () => {
    let resolveRun!: (result: SyncRunResult) => void;
    secretSyncInstance.runSync.mockReturnValueOnce(
      new Promise<SyncRunResult>((resolve) => {
        resolveRun = resolve;
      }),
    );

    const running = main();
    await waitFor(() => secretSyncInstance.runSync.mock.calls.length === 1);

    const scheduledTask = mockSchedule.mock.calls[0][1] as () => void;
    scheduledTask();
    await flushPromises();

    expect(secretSyncInstance.runSync).toHaveBeenCalledTimes(1);

    resolveRun(syncResult());
    await running;
    expect(secretSyncInstance.runSync).toHaveBeenCalledTimes(1);
  });

  describe("job mode", () => {
    beforeEach(() => {
      configInstance.JOB_MODE = "true";
    });

    it("exits 0 on a clean run and flushes telemetry first", async () => {
      secretSyncInstance.runSync.mockResolvedValue(
        syncResult({ namespaces: 1, secrets: 2, succeededSecrets: 2 }),
      );
      const { spy, codes } = mockExit();

      await main();

      expect(codes).toEqual([0]);
      expect(standardLogger.shutdown).toHaveBeenCalledTimes(1);
      expect(
        standardLogger.shutdown.mock.invocationCallOrder[0],
      ).toBeLessThan(spy.mock.invocationCallOrder[0]);
      expect(
        StandardTracer.mock.results[0].value.shutdown,
      ).toHaveBeenCalledTimes(1);
      expect(
        StandardMeter.mock.results[0].value.shutdown,
      ).toHaveBeenCalledTimes(1);
      expect(appLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Job sync summary"),
      );
      expect(appLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("2/2 secret(s)"),
      );
      expect(mockWatchFile).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockCreateApiServer).not.toHaveBeenCalled();
      expect(apiServer.listen).not.toHaveBeenCalled();
    });

    it("exits 1 when the namespace listing failed", async () => {
      secretSyncInstance.runSync.mockResolvedValue(
        syncResult({ namespaceListSucceeded: false, errors: 1 }),
      );
      const { codes } = mockExit();

      await main();

      expect(codes).toEqual([1]);
    });

    it("exits 1 when errors exceed the allowed threshold", async () => {
      configInstance.SYNC_ALLOWED_PARTIAL_FAILURES = 1;
      secretSyncInstance.runSync.mockResolvedValue(
        syncResult({ secrets: 3, succeededSecrets: 2, errors: 2 }),
      );
      const { codes } = mockExit();

      await main();

      expect(codes).toEqual([1]);
    });

    it("exits 0 when errors stay within the allowed threshold", async () => {
      configInstance.SYNC_ALLOWED_PARTIAL_FAILURES = 2;
      secretSyncInstance.runSync.mockResolvedValue(
        syncResult({ secrets: 3, succeededSecrets: 2, errors: 2 }),
      );
      const { codes } = mockExit();

      await main();

      expect(codes).toEqual([0]);
    });

    it("exits 1 when no requested secret was fetched", async () => {
      secretSyncInstance.runSync.mockResolvedValue(
        syncResult({ secrets: 2, succeededSecrets: 0 }),
      );
      const { codes } = mockExit();

      await main();

      expect(codes).toEqual([1]);
    });

    it("exits 1 and logs the Error when the run throws", async () => {
      secretSyncInstance.runSync.mockRejectedValue(new Error("boom"));
      const { codes } = mockExit();

      await main();

      expect(codes).toEqual([1]);
      expect(appLogger.error).toHaveBeenCalledWith(
        "Sync failed",
        expect.any(Error),
      );
    });
  });

  describe("config watcher and reload", () => {
    it("registers the watcher with the polling interval in deployment mode", async () => {
      await main();

      expect(mockWatchFile).toHaveBeenCalledTimes(1);
      const [file, options, listener] = mockWatchFile.mock.calls[0];
      expect(file).toBe("config.json");
      expect(options).toEqual({ interval: 10000 });
      expect(typeof listener).toBe("function");
    });

    it("debounces bursts of file events into one reload", async () => {
      await main();
      configInstance.reload.mockClear();
      const listener = mockWatchFile.mock.calls[0][2] as () => void;

      jest.useFakeTimers();
      listener();
      listener();
      jest.advanceTimersByTime(1000);
      jest.useRealTimers();
      await flushPromises();
      await flushPromises();

      expect(configInstance.reload).toHaveBeenCalledTimes(1);
    });

    it("reschedules the cron when the expression changes", async () => {
      await main();
      const firstTask = mockSchedule.mock.results[0].value;
      configInstance.SYNC_CRON_SCHEDULE = "*/10 * * * *";
      const listener = mockWatchFile.mock.calls[0][2] as () => void;

      jest.useFakeTimers();
      listener();
      jest.advanceTimersByTime(1000);
      jest.useRealTimers();
      await flushPromises();
      await flushPromises();

      expect(firstTask.destroy).toHaveBeenCalledTimes(1);
      expect(mockSchedule).toHaveBeenCalledTimes(2);
      expect(mockSchedule.mock.calls[1][0]).toBe("*/10 * * * *");
      expect(mockSchedule.mock.calls[1][2]).toEqual({ noOverlap: true });
    });

    it("keeps the previous schedule when the reloaded expression is invalid", async () => {
      await main();
      const firstTask = mockSchedule.mock.results[0].value;
      mockValidate.mockImplementation(
        (expression: string) => expression !== "not-a-cron",
      );
      configInstance.SYNC_CRON_SCHEDULE = "not-a-cron";
      const listener = mockWatchFile.mock.calls[0][2] as () => void;

      jest.useFakeTimers();
      listener();
      jest.advanceTimersByTime(1000);
      jest.useRealTimers();
      await flushPromises();
      await flushPromises();

      expect(mockSchedule).toHaveBeenCalledTimes(1);
      expect(firstTask.destroy).not.toHaveBeenCalled();
      expect(appLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid cron schedule"),
      );
      expect(statusInstance.setConfigIssues).toHaveBeenCalledWith([
        'Invalid SYNC_CRON_SCHEDULE: "not-a-cron"',
      ]);
    });

    it("reports a failed config reload in the status", async () => {
      await main();
      statusInstance.setConfigIssues.mockClear();
      configInstance.reload.mockRejectedValue(new Error("bad json"));
      const listener = mockWatchFile.mock.calls[0][2] as () => void;

      jest.useFakeTimers();
      listener();
      jest.advanceTimersByTime(1000);
      jest.useRealTimers();
      await flushPromises();
      await flushPromises();

      expect(statusInstance.setConfigIssues).toHaveBeenCalledWith([
        "Config reload failed: bad json",
      ]);
    });

    it("warns about restart-only settings without logging their values", async () => {
      await main();
      configInstance.ANNOTATION_PREFIX = "new-prefix-value";
      const listener = mockWatchFile.mock.calls[0][2] as () => void;

      jest.useFakeTimers();
      listener();
      jest.advanceTimersByTime(1000);
      jest.useRealTimers();
      await flushPromises();
      await flushPromises();

      const warning = appLogger.warn.mock.calls.find((call) =>
        String(call[0]).includes("ANNOTATION_PREFIX"),
      );
      expect(warning).toBeDefined();
      expect(String(warning![0])).not.toContain("new-prefix-value");
    });
  });

  it("drains an in-flight cycle and flushes telemetry on SIGTERM", async () => {
    let resolveRun!: (result: SyncRunResult) => void;
    secretSyncInstance.runSync.mockReturnValueOnce(
      new Promise<SyncRunResult>((resolve) => {
        resolveRun = resolve;
      }),
    );
    const { codes } = mockExit();
    const onceSpy = jest.spyOn(process, "once");

    const running = main();
    await waitFor(() => secretSyncInstance.runSync.mock.calls.length === 1);

    const signalCall = onceSpy.mock.calls.find(
      ([signal]) => signal === "SIGTERM",
    );
    expect(signalCall).toBeDefined();
    (signalCall![1] as () => void)();

    await flushPromises();
    expect(codes).toEqual([]);

    resolveRun(syncResult());
    await running;
    await waitFor(() => codes.length === 1);

    expect(codes).toEqual([0]);
    expect(mockSchedule.mock.results[0].value.destroy).toHaveBeenCalledTimes(1);
    expect(apiServer.close).toHaveBeenCalledTimes(1);
    expect(apiServer.close.mock.invocationCallOrder[0]).toBeLessThan(
      standardLogger.shutdown.mock.invocationCallOrder[0],
    );
    expect(standardLogger.shutdown).toHaveBeenCalledTimes(1);
  });
});
