import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { watchFile } from "fs-extra";
import cron from "node-cron";
import { Config } from "./Config";
import { KubernetesClient } from "./KubernetesClient";
import { AlibabaKmsSource } from "./sources/AlibabaKmsSource";
import { AwsSecretsManagerSource } from "./sources/AwsSecretsManagerSource";
import { ResticSource } from "./sources/ResticSource";
import { SecretSync } from "./SecretSync";
import { SingleFlightRunner } from "./SyncRunner";
import {
  OTelLogger,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";

const logger = OTelLogger().createModuleLogger("app");

export async function main(): Promise<void> {
  logger.info("====== Starting kubernetes-secrets-cloud-sync Server ======");

  const config = new Config();
  await config.reload();
  watchFile(config.CONFIG_FILE, () => {
    logger.info(`Config updated: ${config.CONFIG_FILE}`);
    config.reload().catch((error) => {
      logger.error(`Failed to reload config: ${error}`);
    });
  });

  OTelSetTracer(new StandardTracer(config));
  OTelSetMeter(new StandardMeter(config));
  OTelLogger().initOTel(config);

  const span = OTelTracer().startSpan("init");
  span.end();

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
        `Failed to initialize secret source ${source.providerName}: ${error}`,
      );
    }
  }

  // Initialize Kubernetes client
  const k8sClient = new KubernetesClient(config);

  // Initialize the sync orchestrator
  const secretSync = new SecretSync(k8sClient, sources, config);
  const runner = new SingleFlightRunner(() => secretSync.runSync());

  // Check if running in job mode (run once and exit)
  const jobModeValue = config.JOB_MODE as string | boolean;
  const jobMode =
    jobModeValue === true || jobModeValue === "true" || jobModeValue === "1";
  if (jobMode) {
    logger.info("Job mode enabled. Running a single sync...");
    try {
      await runner.run();
    } catch (error) {
      logger.error(`Sync failed: ${error}`);
    }
    logger.info("Job mode enabled. Sync complete. Exiting...");
    process.exit(0);
    return;
  }

  // Schedule periodic sync *before* the initial sync so a stalled initial
  // sync cannot prevent future cycles. `noOverlap` and the single-flight
  // runner keep a cron tick from running concurrently with a slow cycle.
  if (cron.validate(config.SYNC_CRON_SCHEDULE)) {
    cron.schedule(
      config.SYNC_CRON_SCHEDULE,
      () => {
        runner
          .run()
          .catch((error) => logger.error(`Scheduled sync failed: ${error}`));
      },
      { noOverlap: true },
    );
    logger.info(`Scheduled sync with cron: ${config.SYNC_CRON_SCHEDULE}`);
  } else {
    logger.error(`Invalid cron schedule: ${config.SYNC_CRON_SCHEDULE}`);
  }

  // Run initial sync on startup
  try {
    await runner.run();
  } catch (error) {
    logger.error(`Initial sync failed: ${error}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`Fatal error during startup: ${error}`);
    process.exit(1);
  });
}
