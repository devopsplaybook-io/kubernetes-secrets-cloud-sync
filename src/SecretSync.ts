import { SecretSource } from "./sources/SecretSource";
import { KubernetesClient } from "./KubernetesClient";
import { OTelLogger } from "./OTelContext";
import { NamespaceSyncRequest, SecretFetchResult } from "./types";

const logger = OTelLogger().createModuleLogger("secret-sync");

/**
 * Orchestrates the secret sync process.
 * Scans Kubernetes namespaces for annotations, fetches secrets from cloud providers,
 * and creates/updates Kubernetes secrets.
 */
export class SecretSync {
  private readonly k8sClient: KubernetesClient;
  private readonly sources: Map<string, SecretSource> = new Map<
    string,
    SecretSource
  >();

  constructor(k8sClient: KubernetesClient, sources: SecretSource[]) {
    this.k8sClient = k8sClient;
    for (const source of sources) {
      this.sources.set(source.providerName, source);
    }
  }

  /**
   * Run a full sync cycle.
   * 1. List namespaces with sync annotations
   * 2. For each namespace, fetch secrets from cloud providers
   * 3. Create/update Kubernetes secrets in each namespace
   */
  async runSync(): Promise<void> {
    logger.info("Starting sync cycle");

    let namespacesSynced = 0;
    let secretsSynced = 0;
    let errors = 0;

    try {
      const requests = await this.k8sClient.getNamespaceSyncRequests();
      logger.info(
        `Found ${requests.length} namespace(s) with sync annotations`,
      );

      for (const request of requests) {
        try {
          const fetchResults = await this.fetchSecretsForNamespace(request);

          for (const result of fetchResults) {
            try {
              await this.k8sClient.upsertSecret(
                request.namespace,
                result.secretName,
                result.data,
              );
              secretsSynced++;
            } catch (error) {
              errors++;
              logger.error(
                `Failed to upsert secret ${result.secretName} in namespace ${request.namespace}: ${error}`,
              );
            }
          }
          namespacesSynced++;
        } catch (error) {
          errors++;
          logger.error(
            `Failed to process namespace ${request.namespace}: ${error}`,
          );
        }
      }
    } catch (error) {
      errors++;
      logger.error(`Failed to list namespaces: ${error}`);
    }

    logger.info(
      `Sync cycle complete: ${namespacesSynced} namespace(s), ${secretsSynced} secret(s), ${errors} error(s)`,
    );
  }

  /**
   * Fetch all secrets required by a namespace based on its annotations.
   */
  private async fetchSecretsForNamespace(
    request: NamespaceSyncRequest,
  ): Promise<SecretFetchResult[]> {
    const results: SecretFetchResult[] = [];

    for (const annotation of request.annotations) {
      const source = this.sources.get(annotation.provider);
      if (!source) {
        logger.warn(
          `No secret source registered for provider: ${annotation.provider} (namespace: ${request.namespace})`,
        );
        continue;
      }

      if (!source.isAvailable()) {
        logger.warn(
          `Secret source not available: ${annotation.provider} (namespace: ${request.namespace})`,
        );
        continue;
      }

      for (const secretName of annotation.secretNames) {
        try {
          const result = await source.fetchSecret(secretName);
          results.push(result);
        } catch (error) {
          logger.error(
            `Failed to fetch secret ${secretName} from ${annotation.provider}: ${error}`,
          );
        }
      }
    }

    return results;
  }
}
