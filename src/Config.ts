import { ConfigOTelInterface } from "@devopsplaybook.io/otel-utils";
import * as fse from "fs-extra";
import { OTelLogger } from "./OTelContext";
import path from "path";

const logger = OTelLogger().createModuleLogger("config");

/**
 * Parse an integer from an env/config value and keep it inside [min, max].
 * Missing, non-numeric and below-minimum values fall back to `fallback`;
 * values above the maximum are clamped.
 */
export function parseBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return fallback;
  }
  if (parsed < min) {
    return fallback;
  }
  return Math.min(parsed, max);
}

export class Config implements ConfigOTelInterface {
  //
  public readonly CONFIG_FILE: string = "config.json";
  public readonly SERVICE_ID = "kubernetes-secrets-cloud-sync";
  public VERSION = "1";
  public LOG_LEVEL = "info";
  public OPENTELEMETRY_COLLECTOR_HTTP_TRACES = "";
  public OPENTELEMETRY_COLLECTOR_HTTP_METRICS = "";
  public OPENTELEMETRY_COLLECTOR_HTTP_LOGS = "";
  public OPENTELEMETRY_COLLECTOR_AWS = false;
  public OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS = 60;
  public OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS = 60;
  public OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER = "";

  // Sync-specific configuration
  public SYNC_CRON_SCHEDULE = "*/5 * * * *";
  public JOB_MODE = false;
  public ANNOTATION_PREFIX = "secrets.cloudsync.devopsplaybook.io";
  public SECRET_NAME_PREFIX = "cloudsync-";
  public DELETE_ORPHANED_SECRETS = false;
  public ORPHAN_CLEANUP_DRY_RUN = false;
  public ORPHAN_CLEANUP_MAX_DELETIONS: number | string = 50;
  public SYNC_FETCH_CONCURRENCY = 4;
  public SYNC_WRITE_CONCURRENCY = 4;
  public SYNC_ALLOWED_PARTIAL_FAILURES = 0;

  // Alibaba KMS configuration
  public ALIBABA_KMS_REGION = "";
  public ALIBABA_KMS_ACCESS_KEY_ID = "";
  public ALIBABA_KMS_ACCESS_KEY_SECRET = "";

  // AWS Secrets Manager configuration
  public AWS_SECRETSMANAGER_REGION = "";
  public AWS_SECRETSMANAGER_ACCESS_KEY_ID = "";
  public AWS_SECRETSMANAGER_SECRET_ACCESS_KEY = "";

  // Restic configuration
  public RESTIC_REPOSITORY = "";
  public RESTIC_PASSWORD = "";
  public RESTIC_PATH = "";
  public RESTIC_OPTIONS = "";
  public RESTIC_TIMEOUT_SECONDS = 120;
  public RESTIC_RETRIES = 2;

  constructor() {
    let version = "1";
    try {
      const pkg = fse.readJsonSync(path.resolve(__dirname, "../package.json"));
      if (pkg && pkg.version) {
        version = pkg.version;
      }
      // oxlint-disable-next-line no-unused-vars
    } catch (e) {
      // fallback to default "1"
    }
    this.VERSION = version;
  }

  public async reload(): Promise<void> {
    const content = await fse.readJson(this.CONFIG_FILE);
    const setIfSet = (field: string, displayLog = true) => {
      let fromEnv = "defaults";
      const self = this as Record<string, any>;
      if (process.env[field] !== undefined) {
        self[field] = process.env[field];
        fromEnv = "environment";
      } else if (content[field] !== undefined) {
        self[field] = content[field];
        fromEnv = "config";
      }
      if (displayLog) {
        logger.info(
          `Configuration Value: ${field}: ${self[field]} (from ${fromEnv})`,
        );
      } else {
        logger.info(
          `Configuration Value: ${field}: ******************** (from ${fromEnv})`,
        );
      }
    };
    const setBoundedIntIfSet = (
      field: string,
      fallback: number,
      min: number,
      max: number,
    ) => {
      let fromEnv = "defaults";
      let raw: unknown;
      const self = this as Record<string, any>;
      if (process.env[field] !== undefined) {
        raw = process.env[field];
        fromEnv = "environment";
      } else if (content[field] !== undefined) {
        raw = content[field];
        fromEnv = "config";
      }
      self[field] = parseBoundedInt(raw, fallback, min, max);
      logger.info(
        `Configuration Value: ${field}: ${self[field]} (from ${fromEnv})`,
      );
    };

    logger.info(`Configuration Value: CONFIG_FILE: ${this.CONFIG_FILE}`);
    logger.info(`Configuration Value: VERSION: ${this.VERSION}`);
    setIfSet("LOG_LEVEL");
    setIfSet("OPENTELEMETRY_COLLECTOR_HTTP_TRACES");
    setIfSet("OPENTELEMETRY_COLLECTOR_HTTP_METRICS");
    setIfSet("OPENTELEMETRY_COLLECTOR_HTTP_LOGS");
    setIfSet("OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS");
    setIfSet("OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS");
    setIfSet("OPENTELEMETRY_COLLECTOR_AWS");
    setIfSet("OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER", false);

    // Sync configuration
    setIfSet("SYNC_CRON_SCHEDULE");
    setIfSet("JOB_MODE");
    setIfSet("ANNOTATION_PREFIX");
    setIfSet("SECRET_NAME_PREFIX");
    setIfSet("DELETE_ORPHANED_SECRETS");
    setIfSet("ORPHAN_CLEANUP_DRY_RUN");
    setIfSet("ORPHAN_CLEANUP_MAX_DELETIONS");
    setBoundedIntIfSet("SYNC_FETCH_CONCURRENCY", 4, 1, 32);
    setBoundedIntIfSet("SYNC_WRITE_CONCURRENCY", 4, 1, 32);
    setBoundedIntIfSet("SYNC_ALLOWED_PARTIAL_FAILURES", 0, 0, 10000);

    // Alibaba KMS configuration
    setIfSet("ALIBABA_KMS_REGION");
    setIfSet("ALIBABA_KMS_ACCESS_KEY_ID", false);
    setIfSet("ALIBABA_KMS_ACCESS_KEY_SECRET", false);

    // AWS Secrets Manager configuration
    setIfSet("AWS_SECRETSMANAGER_REGION");
    setIfSet("AWS_SECRETSMANAGER_ACCESS_KEY_ID", false);
    setIfSet("AWS_SECRETSMANAGER_SECRET_ACCESS_KEY", false);

    // Restic configuration
    setIfSet("RESTIC_REPOSITORY", false);
    setIfSet("RESTIC_PASSWORD", false);
    setIfSet("RESTIC_PATH");
    setIfSet("RESTIC_OPTIONS");
    setBoundedIntIfSet("RESTIC_TIMEOUT_SECONDS", 120, 1, 3600);
    setBoundedIntIfSet("RESTIC_RETRIES", 2, 0, 10);
  }
}
