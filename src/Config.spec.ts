import { Config, parseBoundedInt } from "./Config";

// Mock fs-extra module
const mockReadJsonSync = jest.fn();
const mockReadJson = jest.fn();

jest.mock("fs-extra", () => ({
  readJsonSync: (...args: unknown[]) => mockReadJsonSync(...args),
  readJson: (...args: unknown[]) => mockReadJson(...args),
}));

function captureConsole() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  const spies = [
    jest.spyOn(console, "log").mockImplementation(record),
    jest.spyOn(console, "warn").mockImplementation(record),
    jest.spyOn(console, "error").mockImplementation(record),
  ];
  return {
    lines,
    text: () => lines.join("\n"),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

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
    delete process.env.SYNC_ALLOWED_PARTIAL_FAILURES;
    delete process.env.RESTIC_REPOSITORY;
    delete process.env.RESTIC_PASSWORD;
    delete process.env.RESTIC_OPTIONS;
    delete process.env.RESTIC_HOST;
    delete process.env.RESTIC_TAG;
    delete process.env.RESTIC_SNAPSHOT_PATH;
    delete process.env.RESTIC_MAX_SNAPSHOT_AGE_SECONDS;
    delete process.env.RESTIC_MAX_OUTPUT_BYTES;
    delete process.env.SYNC_MAX_SECRETS_PER_ANNOTATION;
    delete process.env.API_PORT;
    delete process.env.API_HOST;
    delete process.env.API_AUTH_TOKEN;
    delete process.env.API_SYNC_MIN_INTERVAL_SECONDS;
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
      expect(config.RESTIC_HOST).toBe("");
      expect(config.RESTIC_TAG).toBe("");
      expect(config.RESTIC_SNAPSHOT_PATH).toBe("");
      expect(config.RESTIC_MAX_SNAPSHOT_AGE_SECONDS).toBe(172800);
      expect(config.RESTIC_MAX_OUTPUT_BYTES).toBe(8388608);
      expect(config.SYNC_FETCH_CONCURRENCY).toBe(4);
      expect(config.SYNC_WRITE_CONCURRENCY).toBe(4);
      expect(config.SYNC_ALLOWED_PARTIAL_FAILURES).toBe(0);
      expect(config.SYNC_MAX_SECRETS_PER_ANNOTATION).toBe(100);
      expect(config.API_PORT).toBe(8080);
      expect(config.API_HOST).toBe("127.0.0.1");
      expect(config.API_AUTH_TOKEN).toBe("");
      expect(config.API_SYNC_MIN_INTERVAL_SECONDS).toBe(10);
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

    it("never logs configured secret values in plain text", async () => {
      const secrets = {
        alibabaKeyId: "alibaba-key-id-PLACEHOLDER",
        alibabaKeySecret: "alibaba-key-secret-PLACEHOLDER",
        awsKeyId: "aws-key-id-PLACEHOLDER",
        awsSecret: "aws-secret-access-PLACEHOLDER",
        resticUser: "restic-user-PLACEHOLDER",
        resticUserPass: "restic-user-pass-PLACEHOLDER",
        resticPassword: "restic-password-PLACEHOLDER",
        resticOptionSecret: "option-password-PLACEHOLDER",
        apiToken: "api-token-PLACEHOLDER",
        configToken: "config-token-PLACEHOLDER",
      };
      process.env.API_AUTH_TOKEN = secrets.apiToken;
      mockReadJson.mockResolvedValue({
        ALIBABA_KMS_ACCESS_KEY_ID: secrets.alibabaKeyId,
        ALIBABA_KMS_ACCESS_KEY_SECRET: secrets.alibabaKeySecret,
        AWS_SECRETSMANAGER_ACCESS_KEY_ID: secrets.awsKeyId,
        AWS_SECRETSMANAGER_SECRET_ACCESS_KEY: secrets.awsSecret,
        RESTIC_REPOSITORY: `s3:https://${secrets.resticUser}:${secrets.resticUserPass}@example.com/repo`,
        RESTIC_PASSWORD: secrets.resticPassword,
        RESTIC_OPTIONS: `--sftp.password=${secrets.resticOptionSecret}`,
        API_AUTH_TOKEN: secrets.configToken,
      });

      const capture = captureConsole();
      let config: Config;
      try {
        config = new Config();
        await config.reload();
      } finally {
        capture.restore();
      }

      const output = capture.text();
      for (const secret of Object.values(secrets)) {
        expect(output).not.toContain(secret);
      }
      expect(output).toContain("RESTIC_REPOSITORY: ********************");
      expect(output).toContain("RESTIC_PASSWORD: ********************");
      expect(output).toContain("RESTIC_OPTIONS: ********************");
      expect(output).toContain(
        "API_AUTH_TOKEN: ******************** (from environment)",
      );
      expect(output).toContain(
        "API_AUTH_TOKEN must be set from the environment; the config.json value is ignored",
      );
      // The token is read from the environment only, never from config.json.
      expect(config!.API_AUTH_TOKEN).toBe(secrets.apiToken);
      expect(config!.RESTIC_OPTIONS).toBe(
        `--sftp.password=${secrets.resticOptionSecret}`,
      );
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

    it("should load restic snapshot filter settings from config.json", async () => {
      mockReadJson.mockResolvedValue({
        RESTIC_HOST: "backup-host",
        RESTIC_TAG: "daily",
        RESTIC_SNAPSHOT_PATH: "/srv/secrets",
      });

      const config = new Config();
      await config.reload();

      expect(config.RESTIC_HOST).toBe("backup-host");
      expect(config.RESTIC_TAG).toBe("daily");
      expect(config.RESTIC_SNAPSHOT_PATH).toBe("/srv/secrets");
    });

    it("should let environment variables override restic snapshot filter settings", async () => {
      process.env.RESTIC_HOST = "env-host";
      process.env.RESTIC_TAG = "env-tag";
      process.env.RESTIC_SNAPSHOT_PATH = "/env/path";
      mockReadJson.mockResolvedValue({
        RESTIC_HOST: "config-host",
        RESTIC_TAG: "config-tag",
        RESTIC_SNAPSHOT_PATH: "/config/path",
      });

      const config = new Config();
      await config.reload();

      expect(config.RESTIC_HOST).toBe("env-host");
      expect(config.RESTIC_TAG).toBe("env-tag");
      expect(config.RESTIC_SNAPSHOT_PATH).toBe("/env/path");
    });

    it("should accept 0 for the snapshot maximum age and clamp above the maximum", async () => {
      mockReadJson.mockResolvedValue({ RESTIC_MAX_SNAPSHOT_AGE_SECONDS: 0 });
      const config = new Config();
      await config.reload();
      expect(config.RESTIC_MAX_SNAPSHOT_AGE_SECONDS).toBe(0);

      process.env.RESTIC_MAX_SNAPSHOT_AGE_SECONDS = "31536001";
      await config.reload();
      expect(config.RESTIC_MAX_SNAPSHOT_AGE_SECONDS).toBe(31536000);
    });

    it("should bound the restic output limit and fall back on invalid values", async () => {
      mockReadJson.mockResolvedValue({ RESTIC_MAX_OUTPUT_BYTES: 1024 });
      const config = new Config();
      await config.reload();
      expect(config.RESTIC_MAX_OUTPUT_BYTES).toBe(8388608);

      process.env.RESTIC_MAX_OUTPUT_BYTES = "999999999";
      await config.reload();
      expect(config.RESTIC_MAX_OUTPUT_BYTES).toBe(268435456);

      process.env.RESTIC_MAX_OUTPUT_BYTES = "garbage";
      await config.reload();
      expect(config.RESTIC_MAX_OUTPUT_BYTES).toBe(8388608);
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

    it("should load SYNC_ALLOWED_PARTIAL_FAILURES with a zero default", async () => {
      mockReadJson.mockResolvedValue({});
      const config = new Config();
      await config.reload();
      expect(config.SYNC_ALLOWED_PARTIAL_FAILURES).toBe(0);
    });

    it("should parse and clamp SYNC_ALLOWED_PARTIAL_FAILURES", async () => {
      mockReadJson.mockResolvedValue({ SYNC_ALLOWED_PARTIAL_FAILURES: 3 });
      const config = new Config();
      await config.reload();
      expect(config.SYNC_ALLOWED_PARTIAL_FAILURES).toBe(3);

      process.env.SYNC_ALLOWED_PARTIAL_FAILURES = "20000";
      await config.reload();
      expect(config.SYNC_ALLOWED_PARTIAL_FAILURES).toBe(10000);

      process.env.SYNC_ALLOWED_PARTIAL_FAILURES = "-1";
      await config.reload();
      expect(config.SYNC_ALLOWED_PARTIAL_FAILURES).toBe(0);
    });

    it("should load API settings from config.json and environment", async () => {
      mockReadJson.mockResolvedValue({
        API_PORT: 9090,
        API_HOST: "127.0.0.1",
      });

      const config = new Config();
      await config.reload();
      expect(config.API_PORT).toBe(9090);
      expect(config.API_HOST).toBe("127.0.0.1");

      process.env.API_PORT = "3000";
      process.env.API_HOST = " 10.0.0.1 ";
      await config.reload();
      expect(config.API_PORT).toBe(3000);
      expect(config.API_HOST).toBe("10.0.0.1");
    });

    it("should fall back for invalid API settings", async () => {
      mockReadJson.mockResolvedValue({
        API_PORT: 0,
        API_HOST: "   ",
      });

      const config = new Config();
      await config.reload();
      expect(config.API_PORT).toBe(8080);
      expect(config.API_HOST).toBe("127.0.0.1");
    });

    it("should clamp API_PORT above the maximum port", async () => {
      process.env.API_PORT = "70000";
      mockReadJson.mockResolvedValue({});

      const config = new Config();
      await config.reload();
      expect(config.API_PORT).toBe(65535);
    });

    it("reads API_AUTH_TOKEN from the environment only", async () => {
      const capture = captureConsole();
      process.env.API_AUTH_TOKEN = "env-token-PLACEHOLDER";
      mockReadJson.mockResolvedValue({
        API_AUTH_TOKEN: "config-token-PLACEHOLDER",
      });

      let config: Config;
      try {
        config = new Config();
        await config.reload();
      } finally {
        capture.restore();
      }

      expect(config!.API_AUTH_TOKEN).toBe("env-token-PLACEHOLDER");
      expect(capture.text()).not.toContain("env-token-PLACEHOLDER");
      expect(capture.text()).not.toContain("config-token-PLACEHOLDER");
    });

    it("logs that API_AUTH_TOKEN is not set when empty", async () => {
      const capture = captureConsole();
      try {
        const config = new Config();
        await config.reload();
        expect(config.API_AUTH_TOKEN).toBe("");
      } finally {
        capture.restore();
      }

      expect(capture.text()).toContain("API_AUTH_TOKEN: (not set)");
    });

    it("bounds API_SYNC_MIN_INTERVAL_SECONDS", async () => {
      mockReadJson.mockResolvedValue({ API_SYNC_MIN_INTERVAL_SECONDS: 0 });
      const config = new Config();
      await config.reload();
      expect(config.API_SYNC_MIN_INTERVAL_SECONDS).toBe(0);

      process.env.API_SYNC_MIN_INTERVAL_SECONDS = "9999";
      await config.reload();
      expect(config.API_SYNC_MIN_INTERVAL_SECONDS).toBe(3600);

      process.env.API_SYNC_MIN_INTERVAL_SECONDS = "-1";
      await config.reload();
      expect(config.API_SYNC_MIN_INTERVAL_SECONDS).toBe(10);

      mockReadJson.mockResolvedValue({ API_SYNC_MIN_INTERVAL_SECONDS: 5 });
      process.env.API_SYNC_MIN_INTERVAL_SECONDS = "30";
      await config.reload();
      expect(config.API_SYNC_MIN_INTERVAL_SECONDS).toBe(30);
    });

    it("bounds SYNC_MAX_SECRETS_PER_ANNOTATION", async () => {
      mockReadJson.mockResolvedValue({ SYNC_MAX_SECRETS_PER_ANNOTATION: 500 });
      const config = new Config();
      await config.reload();
      expect(config.SYNC_MAX_SECRETS_PER_ANNOTATION).toBe(500);

      process.env.SYNC_MAX_SECRETS_PER_ANNOTATION = "5000";
      await config.reload();
      expect(config.SYNC_MAX_SECRETS_PER_ANNOTATION).toBe(1000);

      process.env.SYNC_MAX_SECRETS_PER_ANNOTATION = "0";
      await config.reload();
      expect(config.SYNC_MAX_SECRETS_PER_ANNOTATION).toBe(100);

      process.env.SYNC_MAX_SECRETS_PER_ANNOTATION = "garbage";
      await config.reload();
      expect(config.SYNC_MAX_SECRETS_PER_ANNOTATION).toBe(100);
    });

    it("should mask RESTIC_REPOSITORY in the configuration log", async () => {
      const capture = captureConsole();
      mockReadJson.mockResolvedValue({
        RESTIC_REPOSITORY: "s3:https://user:secret@example.com/repo",
      });

      try {
        const config = new Config();
        await config.reload();

        expect(config.RESTIC_REPOSITORY).toBe(
          "s3:https://user:secret@example.com/repo",
        );
      } finally {
        capture.restore();
      }

      const logs = capture.lines;
      expect(
        logs.some((line) =>
          line.includes("RESTIC_REPOSITORY: ********************"),
        ),
      ).toBe(true);
      expect(logs.some((line) => line.includes("user:secret"))).toBe(false);
    });
  });
});
