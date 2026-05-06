import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { StandardTracerFastifyRegisterHooks } from "@devopsplaybook.io/otel-utils-fastify";
import Fastify from "fastify";
import { watchFile } from "fs-extra";
import cron from "node-cron";
import { Config } from "./Config";
import { KubernetesClient } from "./KubernetesClient";
import { AlibabaKmsSource } from "./sources/AlibabaKmsSource";
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
  const sources = [new AlibabaKmsSource(config)];

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

  // API
  const fastify = Fastify({
    logger: config.LOG_LEVEL === process.env.FASTIFY_LOG_LEVEL,
  });

  StandardTracerFastifyRegisterHooks(fastify, OTelTracer(), OTelLogger(), {
    ignoreList: ["GET-/api/status"],
  });

  fastify.get("/api/status", async () => {
    return { started: true };
  });

  fastify.post("/api/sync", async (_request, reply) => {
    try {
      await secretSync.runSync();
      reply.status(200).send({ status: "ok" });
    } catch {
      reply.status(500).send({ error: "Sync failed" });
    }
  });

  fastify.listen({ port: config.API_PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
      logger.error("Error Starting API", err);
      process.exit(1);
    }
    logger.info("API Listening");
  });
});
