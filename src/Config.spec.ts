import { Config, parseBoundedInt } from "./Config";

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
    delete process.env.DELETE_ORPHANED_SECRETS;
    delete process.env.ORPHAN_CLEANUP_DRY_RUN;
    delete process.env.ORPHAN_CLEANUP_MAX_DELETIONS;
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
      expect(config.ANNOTATION_PREFIX).toBe(
        "secrets.cloudsync.devopsplaybook.io",
      );
      expect(config.SECRET_NAME_PREFIX).toBe("cloudsync-");
      expect(config.DELETE_ORPHANED_SECRETS).toBe(false);
      expect(config.ORPHAN_CLEANUP_DRY_RUN).toBe(false);
      expect(config.ORPHAN_CLEANUP_MAX_DELETIONS).toBe(50);
      expect(config.RESTIC_TIMEOUT_SECONDS).toBe(120);
      expect(config.RESTIC_RETRIES).toBe(2);
      expect(config.SYNC_FETCH_CONCURRENCY).toBe(4);
      expect(config.SYNC_WRITE_CONCURRENCY).toBe(4);
    });
  });

  describe("parseBoundedInt", () => {
    it("returns the fallback for missing or non-numeric values", () => {
      expect(parseBoundedInt(undefined, 7, 1, 10)).toBe(7);
      expect(parseBoundedInt(null, 7, 1, 10)).toBe(7);
      expect(parseBoundedInt("", 7, 1, 10)).toBe(7);
      expect(parseBoundedInt("garbage", 7, 1, 10)).toBe(7);
      expect(parseBoundedInt("4.5", 7, 1, 10)).toBe(7);
    });

    it("returns the fallback when the value is below the minimum", () => {
      expect(parseBoundedInt("0", 4, 1, 32)).toBe(4);
      expect(parseBoundedInt(-3, 4, 1, 32)).toBe(4);
    });

    it("clamps values above the maximum", () => {
      expect(parseBoundedInt("999", 4, 1, 32)).toBe(32);
    });

    it("accepts values inside the range", () => {
      expect(parseBoundedInt("6", 4, 1, 32)).toBe(6);
      expect(parseBoundedInt(8, 4, 1, 32)).toBe(8);
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

    it("should load orphan cleanup settings from config.json", async () => {
      mockReadJson.mockResolvedValue({
        ORPHAN_CLEANUP_DRY_RUN: true,
        ORPHAN_CLEANUP_MAX_DELETIONS: 10,
      });

      const config = new Config();
      await config.reload();
      expect(config.ORPHAN_CLEANUP_DRY_RUN).toBe(true);
      expect(config.ORPHAN_CLEANUP_MAX_DELETIONS).toBe(10);
    });

    it("should load restic and sync concurrency settings from config.json", async () => {
      mockReadJson.mockResolvedValue({
        RESTIC_TIMEOUT_SECONDS: 30,
        RESTIC_RETRIES: 0,
        SYNC_FETCH_CONCURRENCY: 8,
        SYNC_WRITE_CONCURRENCY: 6,
      });

      const config = new Config();
      await config.reload();

      expect(config.RESTIC_TIMEOUT_SECONDS).toBe(30);
      expect(config.RESTIC_RETRIES).toBe(0);
      expect(config.SYNC_FETCH_CONCURRENCY).toBe(8);
      expect(config.SYNC_WRITE_CONCURRENCY).toBe(6);
    });

    it("should let environment variables override restic and concurrency settings", async () => {
      process.env.RESTIC_TIMEOUT_SECONDS = "45";
      process.env.RESTIC_RETRIES = "3";
      process.env.SYNC_FETCH_CONCURRENCY = "2";
      process.env.SYNC_WRITE_CONCURRENCY = "5";
      mockReadJson.mockResolvedValue({
        RESTIC_TIMEOUT_SECONDS: 30,
        RESTIC_RETRIES: 0,
        SYNC_FETCH_CONCURRENCY: 8,
        SYNC_WRITE_CONCURRENCY: 6,
      });

      const config = new Config();
      await config.reload();

      expect(config.RESTIC_TIMEOUT_SECONDS).toBe(45);
      expect(config.RESTIC_RETRIES).toBe(3);
      expect(config.SYNC_FETCH_CONCURRENCY).toBe(2);
      expect(config.SYNC_WRITE_CONCURRENCY).toBe(5);
    });

    it("should fall back to defaults for invalid concurrency values", async () => {
      process.env.SYNC_FETCH_CONCURRENCY = "0";
      process.env.SYNC_WRITE_CONCURRENCY = "garbage";
      process.env.RESTIC_TIMEOUT_SECONDS = "9999";
      mockReadJson.mockResolvedValue({});

      const config = new Config();
      await config.reload();

      expect(config.SYNC_FETCH_CONCURRENCY).toBe(4);
      expect(config.SYNC_WRITE_CONCURRENCY).toBe(4);
      expect(config.RESTIC_TIMEOUT_SECONDS).toBe(3600);
    });

    it("should let environment variables override orphan cleanup settings", async () => {
      process.env.ORPHAN_CLEANUP_DRY_RUN = "true";
      process.env.ORPHAN_CLEANUP_MAX_DELETIONS = "7";
      mockReadJson.mockResolvedValue({
        ORPHAN_CLEANUP_DRY_RUN: false,
        ORPHAN_CLEANUP_MAX_DELETIONS: 10,
      });

      const config = new Config();
      await config.reload();
      expect(config.ORPHAN_CLEANUP_DRY_RUN).toBe("true");
      expect(config.ORPHAN_CLEANUP_MAX_DELETIONS).toBe("7");
    });
  });
});
