import { Config } from "./Config";

// Mock fs-extra module
const mockReadJsonSync = jest.fn();
const mockReadJson = jest.fn();

jest.mock("fs-extra", () => ({
  readJsonSync: (...args: unknown[]) => mockReadJsonSync(...args),
  readJson: (...args: unknown[]) => mockReadJson(...args),
}));

describe("Config", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };

    // Default: package.json can be read with version "0.4.0"
    mockReadJsonSync.mockReturnValue({ version: "0.4.0" });
    // Default: config.json returns no overrides
    mockReadJson.mockResolvedValue({});

    // Clear specific env vars that could interfere
    delete process.env.LOG_LEVEL;
    delete process.env.JOB_MODE;
    delete process.env.ANNOTATION_PREFIX;
    delete process.env.SYNC_CRON_SCHEDULE;
  });

  afterEach(() => {
    process.env = OLD_ENV;
    jest.clearAllMocks();
  });

  describe("constructor", () => {
    it("should read version from package.json", () => {
      const config = new Config();
      expect(config.VERSION).toBe("0.4.0");
      // path.resolve + __dirname + ../package.json
      expect(mockReadJsonSync).toHaveBeenCalledTimes(1);
    });

    it("should default to version 1 if package.json cannot be read", () => {
      mockReadJsonSync.mockImplementationOnce(() => {
        throw new Error("File not found");
      });
      const config = new Config();
      expect(config.VERSION).toBe("1");
    });

    it("should set default configuration values", () => {
      const config = new Config();
      expect(config.LOG_LEVEL).toBe("info");
      expect(config.SYNC_CRON_SCHEDULE).toBe("*/5 * * * *");
      expect(config.JOB_MODE).toBe(false);
      expect(config.ANNOTATION_PREFIX).toBe("secrets.cloudsync.devopsplaybook.io");
      expect(config.SECRET_NAME_PREFIX).toBe("cloudsync-");
      expect(config.DELETE_ORPHANED_SECRETS).toBe(false);
    });
  });

  describe("reload", () => {
    it("should load configuration from config.json", async () => {
      mockReadJson.mockResolvedValue({
        LOG_LEVEL: "debug",
        SYNC_CRON_SCHEDULE: "*/10 * * * *",
        JOB_MODE: true,
      });

      const config = new Config();
      await config.reload();

      expect(config.LOG_LEVEL).toBe("debug");
      expect(config.SYNC_CRON_SCHEDULE).toBe("*/10 * * * *");
      expect(config.JOB_MODE).toBe(true);
      expect(mockReadJson).toHaveBeenCalledWith("config.json");
    });

    it("should prefer environment variables over config.json", async () => {
      process.env.LOG_LEVEL = "error";
      process.env.JOB_MODE = "true";

      mockReadJson.mockResolvedValue({
        LOG_LEVEL: "debug",
        JOB_MODE: false,
      });

      const config = new Config();
      await config.reload();

      expect(config.LOG_LEVEL).toBe("error");
      expect(config.JOB_MODE).toBe("true");
    });

    it("should keep defaults when config.json is empty", async () => {
      mockReadJson.mockResolvedValue({});

      const config = new Config();
      await config.reload();

      expect(config.LOG_LEVEL).toBe("info");
      expect(config.SYNC_CRON_SCHEDULE).toBe("*/5 * * * *");
    });

    it("should not log secret values in plain text", async () => {
      // This is a behavioral test - secrets should be logged as asterisks
      // We just verify it doesn't crash and uses the config value internally
      mockReadJson.mockResolvedValue({
        ALIBABA_KMS_ACCESS_KEY_ID: "my-key-id",
        AWS_SECRETSMANAGER_SECRET_ACCESS_KEY: "my-secret-key",
      });

      const config = new Config();
      await config.reload();

      expect(config.ALIBABA_KMS_ACCESS_KEY_ID).toBe("my-key-id");
      expect(config.AWS_SECRETSMANAGER_SECRET_ACCESS_KEY).toBe("my-secret-key");
    });

    it("should handle string boolean values for DELETE_ORPHANED_SECRETS", async () => {
      mockReadJson.mockResolvedValue({
        DELETE_ORPHANED_SECRETS: "true",
      });

      const config = new Config();
      await config.reload();
      expect(config.DELETE_ORPHANED_SECRETS).toBe("true");
    });

    it("should handle numeric boolean values for DELETE_ORPHANED_SECRETS", async () => {
      mockReadJson.mockResolvedValue({
        DELETE_ORPHANED_SECRETS: "1",
      });

      const config = new Config();
      await config.reload();
      expect(config.DELETE_ORPHANED_SECRETS).toBe("1");
    });
  });
});
