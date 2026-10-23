import { main } from "./App";

jest.mock("node-cron", () => {
  const schedule = jest.fn();
  const validate = jest.fn();
  return {
    __esModule: true,
    default: { schedule, validate },
    __schedule: schedule,
    __validate: validate,
  };
});

jest.mock("fs-extra", () => ({ watchFile: jest.fn() }));

jest.mock("@devopsplaybook.io/otel-utils", () => ({
  StandardTracer: jest.fn(),
  StandardMeter: jest.fn(),
}));

jest.mock("./OTelContext", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    initOTel: jest.fn(),
  };
  return {
    OTelLogger: jest.fn(() => ({
      createModuleLogger: jest.fn(() => logger),
      initOTel: jest.fn(),
    })),
    OTelSetTracer: jest.fn(),
    OTelSetMeter: jest.fn(),
    OTelTracer: jest.fn(() => ({
      startSpan: jest.fn(() => ({ end: jest.fn() })),
    })),
  };
});

jest.mock("./Config", () => {
  const instance = {
    CONFIG_FILE: "config.json",
    SYNC_CRON_SCHEDULE: "*/5 * * * *",
    JOB_MODE: false,
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
  const instance = { runSync: jest.fn(async () => undefined) };
  return {
    SecretSync: jest.fn(() => instance),
    __secretSyncInstance: instance,
  };
});

jest.mock("./sources/AlibabaKmsSource", () => ({
  AlibabaKmsSource: jest.fn(() => ({
    providerName: "alibaba-kms",
    init: jest.fn(async () => undefined),
    isAvailable: jest.fn(() => false),
  })),
}));

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
const { __schedule: mockSchedule, __validate: mockValidate } = jest.requireMock(
  "node-cron",
) as { __schedule: jest.Mock; __validate: jest.Mock };

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition not met before timeout");
}

describe("App main", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configInstance.SYNC_CRON_SCHEDULE = "*/5 * * * *";
    configInstance.JOB_MODE = false;
    secretSyncInstance.runSync.mockReset();
    secretSyncInstance.runSync.mockResolvedValue(undefined);
    mockValidate.mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
  });

  it("runs once and exits in job mode without scheduling", async () => {
    configInstance.JOB_MODE = "true";
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);

    await expect(main()).rejects.toThrow("process.exit(0)");

    expect(secretSyncInstance.runSync).toHaveBeenCalledTimes(1);
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("still runs the initial sync when the cron expression is invalid", async () => {
    mockValidate.mockReturnValue(false);

    await main();

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(secretSyncInstance.runSync).toHaveBeenCalledTimes(1);
  });

  it("does not start a second sync when a cron tick fires during a run", async () => {
    let resolveRun!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    secretSyncInstance.runSync.mockReturnValueOnce(pending);

    const running = main();
    await waitFor(() => secretSyncInstance.runSync.mock.calls.length === 1);

    const scheduledTask = mockSchedule.mock.calls[0][1] as () => void;
    scheduledTask();
    await waitFor(() => true);

    expect(secretSyncInstance.runSync).toHaveBeenCalledTimes(1);

    resolveRun();
    await running;
    expect(secretSyncInstance.runSync).toHaveBeenCalledTimes(1);
  });
});
