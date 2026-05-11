import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { watchFile } from "fs-extra";
import cron from "node-cron";
import { Config } from "./Config";
import { KubernetesClient } from "./KubernetesClient";
import { AlibabaKmsSource } from "./sources/AlibabaKmsSource";
import { AwsSecretsManagerSource } from "./sources/AwsSecretsManagerSource";
import { ResticSource } from "./sources/ResticSource";
import { SecretSync } from "./SecretSync";
import {
  OTelLogger,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";

const logger = OTelLogger().createModuleLogger("app");

logger.info("====== Starting kubernetes-secrets-cloud-sync Server ======");

Promise.resolve().then(async () => {
  //
  const config = new Config();
  await config.reload();
  watchFile(config.CONFIG_FILE, () => {
    logger.info(`Config updated: ${config.CONFIG_FILE}`);
    config.reload();
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
  const secretSync = new SecretSync(k8sClient, sources);

  // Run initial sync on startup
  try {
    await secretSync.runSync();
  } catch (error) {
    logger.error(`Initial sync failed: ${error}`);
  }

  // Check if running in job mode (run once and exit)
  const jobModeValue = config.JOB_MODE as string | boolean;
  const jobMode =
    jobModeValue === true || jobModeValue === "true" || jobModeValue === "1";
  if (jobMode) {
    logger.info("Job mode enabled. Sync complete. Exiting...");
    process.exit(0);
  }

  // Schedule periodic sync
  if (cron.validate(config.SYNC_CRON_SCHEDULE)) {
    cron.schedule(config.SYNC_CRON_SCHEDULE, async () => {
      try {
        await secretSync.runSync();
      } catch (error) {
        logger.error(`Scheduled sync failed: ${error}`);
      }
    });
    logger.info(`Scheduled sync with cron: ${config.SYNC_CRON_SCHEDULE}`);
  } else {
    logger.error(`Invalid cron schedule: ${config.SYNC_CRON_SCHEDULE}`);
  }
});
