import {
  StandardLogger,
  StandardMeter,
  StandardTracer,
} from "@devopsplaybook.io/otel-utils";
import { watchFile } from "fs-extra";
import { FastifyInstance } from "fastify";
import cron, { ScheduledTask } from "node-cron";
import { SyncStatus, createApiServer } from "./Api";
import { Config } from "./Config";
import { KubernetesClient } from "./KubernetesClient";
import { AlibabaKmsSource } from "./sources/AlibabaKmsSource";
import { AwsSecretsManagerSource } from "./sources/AwsSecretsManagerSource";
import { ResticSource } from "./sources/ResticSource";
import { SecretSync } from "./SecretSync";
import { SingleFlightRunner } from "./SyncRunner";
import { OTelLogger, OTelSetTracer, toError } from "./OTelContext";
import { SyncRunResult } from "./types";

const logger = OTelLogger().createModuleLogger("app");

const CONFIG_WATCH_INTERVAL_MS = 10_000;
const CONFIG_RELOAD_DEBOUNCE_MS = 1_000;

/**
 * Settings copied into the sources, Kubernetes client, scheduler or OTel SDK
 * at construction time. Reloading them only logs a warning; a restart applies
 * them. Everything else (cron expression, orphan cleanup, concurrency,
 * restic options) is read at use time and applies on the next cycle.
 */
const RESTART_ONLY_FIELDS: string[] = [
  "JOB_MODE",
  "ANNOTATION_PREFIX",
  "SECRET_NAME_PREFIX",
  "ALIBABA_KMS_REGION",
  "ALIBABA_KMS_ACCESS_KEY_ID",
  "ALIBABA_KMS_ACCESS_KEY_SECRET",
  "AWS_SECRETSMANAGER_REGION",
  "AWS_SECRETSMANAGER_ACCESS_KEY_ID",
  "AWS_SECRETSMANAGER_SECRET_ACCESS_KEY",
  "OPENTELEMETRY_COLLECTOR_HTTP_TRACES",
  "OPENTELEMETRY_COLLECTOR_HTTP_METRICS",
  "OPENTELEMETRY_COLLECTOR_HTTP_LOGS",
  "OPENTELEMETRY_COLLECTOR_AWS",
  "OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS",
  "OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS",
  "OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER",
  "LOG_LEVEL",
  "API_PORT",
  "API_HOST",
];

interface TelemetryBundle {
  logger: StandardLogger;
  tracer: StandardTracer;
  meter: StandardMeter;
  shutdownPromise?: Promise<void>;
}

let telemetry: TelemetryBundle | undefined;
let apiServer: FastifyInstance | undefined;
let cronTask: ScheduledTask | undefined;
let activeCronExpression: string | undefined;
let reloadDebounceTimer: NodeJS.Timeout | undefined;
let reloadChain: Promise<void> = Promise.resolve();
let shuttingDown = false;
let registeredSignalHandlers: Array<[NodeJS.Signals, () => void]> = [];

/**
 * Exit-code policy for job mode: a run fails when the namespace listing
 * failed, when errors exceed the allowed threshold, or when nothing that was
 * requested could be fetched.
 */
export function jobExitCode(
  result: SyncRunResult,
  allowedPartialFailures: number,
): 0 | 1 {
  if (!result.namespaceListSucceeded) {
    return 1;
  }
  const allowed =
    Number.isFinite(allowedPartialFailures) && allowedPartialFailures >= 0
      ? allowedPartialFailures
      : 0;
  if (result.errors > allowed) {
    return 1;
  }
  if (result.secrets > 0 && result.succeededSecrets === 0) {
    return 1;
  }
  return 0;
}

function isJobMode(config: Config): boolean {
  const value = config.JOB_MODE as string | boolean;
  return value === true || value === "true" || value === "1";
}

function initTelemetry(config: Config): TelemetryBundle {
  const standardLogger = OTelLogger();
  const tracer = new StandardTracer(config);
  const meter = new StandardMeter(config);
  standardLogger.initOTel(config);
  OTelSetTracer(tracer);
  telemetry = { logger: standardLogger, tracer, meter };
  return telemetry;
}

/** Flush buffered logs, spans and metrics exactly once before exiting. */
function shutdownTelemetry(): Promise<void> {
  if (!telemetry) {
    return Promise.resolve();
  }
  if (!telemetry.shutdownPromise) {
    telemetry.shutdownPromise = Promise.allSettled([
      telemetry.logger.shutdown(),
      telemetry.tracer.shutdown(),
      telemetry.meter.shutdown(),
    ]).then(() => undefined);
  }
  return telemetry.shutdownPromise;
}

function snapshotRestartOnly(config: Config): Record<string, unknown> {
  const values = config as unknown as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const field of RESTART_ONLY_FIELDS) {
    snapshot[field] = values[field];
  }
  return snapshot;
}

function warnRestartOnlyChanges(
  config: Config,
  snapshot: Record<string, unknown>,
): void {
  const values = config as unknown as Record<string, unknown>;
  for (const field of RESTART_ONLY_FIELDS) {
    if (values[field] !== snapshot[field]) {
      logger.warn(
        `Configuration value ${field} changed; restart the pod for it to take effect`,
      );
      snapshot[field] = values[field];
    }
  }
}

async function runJobMode(
  config: Config,
  runner: SingleFlightRunner<SyncRunResult>,
): Promise<void> {
  logger.info("Job mode enabled. Running a single sync...");

  let exitCode: 0 | 1;
  try {
    const result = await runner.run();
    exitCode = jobExitCode(
      result,
      Number(config.SYNC_ALLOWED_PARTIAL_FAILURES),
    );
    const failed = result.failedNamespaces.length
      ? result.failedNamespaces.join(",")
      : "none";
    logger.info(
      `Job sync summary: ${result.namespaces} namespace(s), ${result.succeededSecrets}/${result.secrets} secret(s) synced, ${result.errors} error(s), failed namespaces: ${failed}, exit code ${exitCode}`,
    );
  } catch (error) {
    logger.error("Sync failed", toError(error));
    exitCode = 1;
  }

  logger.info("Job mode enabled. Sync complete. Exiting...");
  await shutdownTelemetry();
  process.exit(exitCode);
}

export async function main(): Promise<void> {
  logger.info("====== Starting kubernetes-secrets-cloud-sync Server ======");

  cronTask = undefined;
  activeCronExpression = undefined;
  reloadChain = Promise.resolve();
  shuttingDown = false;
  telemetry = undefined;
  apiServer = undefined;
  if (reloadDebounceTimer) {
    clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = undefined;
  }
  for (const [signal, handler] of registeredSignalHandlers) {
    process.removeListener(signal, handler);
  }
  registeredSignalHandlers = [];

  const config = new Config();
  await config.reload();
  const telemetryBundle = initTelemetry(config);

  const jobMode = isJobMode(config);

  // L4: an unusable schedule must fail startup instead of leaving a process
  // that never syncs. Checked before any source/client construction.
  if (!jobMode && !cron.validate(config.SYNC_CRON_SCHEDULE)) {
    throw new Error(
      `Invalid SYNC_CRON_SCHEDULE: "${config.SYNC_CRON_SCHEDULE}"`,
    );
  }

  // Initialize secret sources
  const sources = [
    new AlibabaKmsSource(config),
    new AwsSecretsManagerSource(config),
    new ResticSource(config),
  ];

  for (const source of sources) {
    try {
      await source.init();
      logger.info(
        `Secret source initialized: ${source.providerName} (available: ${source.isAvailable()})`,
      );
    } catch (error) {
      logger.error(
        `Failed to initialize secret source ${source.providerName}`,
        toError(error),
      );
    }
  }

  // Initialize Kubernetes client
  const k8sClient = new KubernetesClient(config);

  // Initialize the sync orchestrator
  const secretSync = new SecretSync(k8sClient, sources, config);
  const status = new SyncStatus();
  const runner = new SingleFlightRunner<SyncRunResult>(async () => {
    status.markRunStarted();
    try {
      const result = await secretSync.runSync();
      status.markRunSucceeded(result);
      return result;
    } catch (error) {
      status.markRunFailed(error);
      throw error;
    }
  });

  if (jobMode) {
    await runJobMode(config, runner);
    return;
  }

  const restartOnlySnapshot = snapshotRestartOnly(config);

  const schedule = async (expression: string): Promise<void> => {
    if (!cron.validate(expression)) {
      logger.error(
        `Invalid cron schedule: ${expression}; keeping the previous schedule`,
      );
      status.setConfigIssues([`Invalid SYNC_CRON_SCHEDULE: "${expression}"`]);
      return;
    }
    if (cronTask) {
      await cronTask.destroy();
    }
    cronTask = cron.schedule(
      expression,
      () => {
        runner
          .run()
          .catch((error) => logger.error("Scheduled sync failed", toError(error)));
      },
      { noOverlap: true },
    );
    activeCronExpression = expression;
    status.setScheduler(expression);
    status.setConfigIssues([]);
    logger.info(`Scheduled sync with cron: ${expression}`);
  };

  const applyReload = async (): Promise<void> => {
    await config.reload();
    logger.info(`Config updated: ${config.CONFIG_FILE}`);
    warnRestartOnlyChanges(config, restartOnlySnapshot);
    if (config.SYNC_CRON_SCHEDULE !== activeCronExpression) {
      await schedule(config.SYNC_CRON_SCHEDULE);
    } else {
      // The schedule did not change: clear any issue from an earlier reload.
      status.setConfigIssues([]);
      status.setScheduler(activeCronExpression ?? null);
    }
  };

  // Deployment only: job mode never registers the watcher.
  watchFile(
    config.CONFIG_FILE,
    { interval: CONFIG_WATCH_INTERVAL_MS },
    () => {
      if (reloadDebounceTimer) {
        clearTimeout(reloadDebounceTimer);
      }
      reloadDebounceTimer = setTimeout(() => {
        reloadDebounceTimer = undefined;
        reloadChain = reloadChain.then(applyReload).catch((error) => {
          logger.error("Failed to reload config", toError(error));
          status.setConfigIssues([
            `Config reload failed: ${toError(error).message}`,
          ]);
        });
      }, CONFIG_RELOAD_DEBOUNCE_MS);
    },
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    if (reloadDebounceTimer) {
      clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = undefined;
    }
    try {
      await cronTask?.destroy();
    } catch (error) {
      logger.error("Failed to stop the cron task", toError(error));
    }
    // Close the server before draining so no new manual run can start.
    try {
      await apiServer?.close();
    } catch (error) {
      logger.error("Failed to close the HTTP API", toError(error));
    }
    await runner.whenIdle();
    await shutdownTelemetry();
    process.exit(0);
  };

  const onSignal = (signal: NodeJS.Signals) => () => {
    shutdown(signal).catch((error) => {
      logger.error("Failed to shut down cleanly", toError(error));
      process.exitCode = 1;
    });
  };
  const onSigterm = onSignal("SIGTERM");
  const onSigint = onSignal("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  registeredSignalHandlers = [
    ["SIGTERM", onSigterm],
    ["SIGINT", onSigint],
  ];

  // Listen before the first cycle so probes succeed while it runs; a manual
  // trigger during the initial sync hits the same single-flight runner (409).
  apiServer = createApiServer({
    config,
    runner,
    status,
    tracer: telemetryBundle.tracer,
    logger: telemetryBundle.logger,
  });
  await apiServer.listen({ port: config.API_PORT, host: config.API_HOST });
  logger.info(`HTTP API listening on ${config.API_HOST}:${config.API_PORT}`);

  // Schedule periodic sync *before* the initial sync so a stalled initial
  // sync cannot prevent future cycles. `noOverlap` and the single-flight
  // runner keep a cron tick from running concurrently with a slow cycle.
  await schedule(config.SYNC_CRON_SCHEDULE);

  // Run initial sync on startup
  try {
    await runner.run();
  } catch (error) {
    logger.error("Initial sync failed", toError(error));
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    logger.error("Fatal error during startup", toError(error));
    await apiServer?.close().catch(() => undefined);
    await shutdownTelemetry();
    process.exit(1);
  });
}
