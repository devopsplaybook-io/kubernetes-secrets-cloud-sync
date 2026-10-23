import { Config } from "./Config";
import { SecretSource } from "./sources/SecretSource";
import { KubernetesClient, ManagedSecret } from "./KubernetesClient";
import { OTelLogger } from "./OTelContext";
import { normalizeSecretName } from "./SecretName";
import { NamespaceSyncRequest, SecretFetchResult } from "./types";

const logger = OTelLogger().createModuleLogger("secret-sync");

const DEFAULT_MAX_ORPHAN_DELETIONS = 50;
const PREVIEW_LIMIT = 20;

/**
 * Orchestrates the secret sync process.
 * Scans Kubernetes namespaces for annotations, fetches secrets from cloud providers,
 * and creates/updates Kubernetes secrets.
 */
export class SecretSync {
  private readonly k8sClient: KubernetesClient;
  private readonly config: Config;
  private readonly sources: Map<string, SecretSource> = new Map<
    string,
    SecretSource
  >();

  constructor(
    k8sClient: KubernetesClient,
    sources: SecretSource[],
    config: Config,
  ) {
    this.k8sClient = k8sClient;
    this.config = config;
    for (const source of sources) {
      this.sources.set(source.providerName, source);
    }
  }

  /**
   * Run a full sync cycle.
   * 1. List namespaces with sync annotations
   * 2. For each namespace, fetch secrets from cloud providers
   * 3. Create/update Kubernetes secrets in each namespace
   * 4. Optionally delete managed secrets that no longer match any annotation
   */
  async runSync(): Promise<void> {
    logger.info("Starting sync cycle");

    let namespacesSynced = 0;
    let secretsSynced = 0;
    let errors = 0;
    let namespaceListSucceeded = false;
    const expected = new Set<string>();
    const identityByKey = new Map<string, string>();
    const collisionKeys = new Set<string>();

    try {
      const requests = await this.k8sClient.getNamespaceSyncRequests();
      namespaceListSucceeded = true;
      logger.info(
        `Found ${requests.length} namespace(s) with sync annotations`,
      );

      // Build the expected set from annotations regardless of fetch outcome.
      for (const request of requests) {
        for (const annotation of request.annotations) {
          for (const secretName of annotation.secretNames) {
            const k8sSecretName = normalizeSecretName(
              secretName,
              this.k8sClient.secretNamePrefix,
            );
            const key = `${request.namespace}/${k8sSecretName}`;
            const identity = `${annotation.provider}\0${secretName}`;
            const existingIdentity = identityByKey.get(key);

            if (existingIdentity === undefined) {
              identityByKey.set(key, identity);
            } else if (
              existingIdentity !== identity &&
              !collisionKeys.has(key)
            ) {
              collisionKeys.add(key);
              const [existingProvider, existingSecret] =
                existingIdentity.split("\0");
              logger.error(
                `Secret name collision in namespace ${request.namespace}: "${existingSecret}" (${existingProvider}) and "${secretName}" (${annotation.provider}) both map to "${k8sSecretName}"; skipping both`,
              );
            }
            expected.add(key);
          }
        }
      }

      for (const request of requests) {
        try {
          const fetchResults = await this.fetchSecretsForNamespace(request);

          for (const result of fetchResults) {
            const k8sSecretName = normalizeSecretName(
              result.secretName,
              this.k8sClient.secretNamePrefix,
            );
            const key = `${request.namespace}/${k8sSecretName}`;
            if (collisionKeys.has(key)) {
              errors++;
              logger.error(
                `Skipping secret ${result.secretName} in namespace ${request.namespace}: its Kubernetes name "${k8sSecretName}" collides with another secret`,
              );
              continue;
            }
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

    const deleteOrphans = this.isTruthy(
      this.config.DELETE_ORPHANED_SECRETS as string | boolean,
    );
    const dryRun = this.isTruthy(
      this.config.ORPHAN_CLEANUP_DRY_RUN as string | boolean,
    );
    const maxDeletions = this.parseMaxDeletions(
      this.config.ORPHAN_CLEANUP_MAX_DELETIONS,
    );

    let orphansDeleted = 0;
    if (deleteOrphans) {
      if (!namespaceListSucceeded) {
        logger.warn(
          "Skipping orphan cleanup: namespace listing failed, expected set is unreliable",
        );
      } else {
        try {
          orphansDeleted = await this.pruneOrphanedSecrets(
            expected,
            dryRun,
            maxDeletions,
          );
        } catch (error) {
          errors++;
          logger.error(`Failed to prune orphaned secrets: ${error}`);
        }
      }
    }

    const cleanupMode = deleteOrphans
      ? dryRun
        ? "dry-run"
        : "enabled"
      : "disabled";
    logger.info(
      `Sync cycle complete (instance ${this.k8sClient.instanceId ?? "unknown"}, orphan cleanup ${cleanupMode}): ${namespacesSynced} namespace(s), ${secretsSynced} secret(s), ${orphansDeleted} orphan(s) deleted, ${errors} error(s)`,
    );
  }

  private isTruthy(value: string | boolean | undefined): boolean {
    return value === true || value === "true" || value === "1";
  }

  private parseMaxDeletions(value: number | string | undefined): number {
    const parsed =
      typeof value === "number"
        ? value
        : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return DEFAULT_MAX_ORPHAN_DELETIONS;
    }
    return parsed;
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

  /**
   * Delete every managed secret of this instance that is no longer referenced
   * by any namespace annotation. Honors the dry-run flag and the maximum
   * deletions threshold (fail-safe: nothing is deleted above it).
   */
  private async pruneOrphanedSecrets(
    expected: Set<string>,
    dryRun: boolean,
    maxDeletions: number,
  ): Promise<number> {
    const managed = await this.k8sClient.listManagedSecrets();
    const orphans: ManagedSecret[] = [];
    for (const secret of managed) {
      const key = `${secret.namespace}/${secret.name}`;
      if (expected.has(key)) {
        continue;
      }
      if (secret.sourceName) {
        const normalized = normalizeSecretName(
          secret.sourceName,
          this.k8sClient.secretNamePrefix,
        );
        if (expected.has(`${secret.namespace}/${normalized}`)) {
          continue;
        }
      }
      orphans.push(secret);
    }

    const preview = orphans
      .slice(0, PREVIEW_LIMIT)
      .map(
        (secret) =>
          `${secret.namespace}/${secret.name}${secret.sourceName ? ` (source "${secret.sourceName}")` : ""}`,
      )
      .join(", ");
    const more =
      orphans.length > PREVIEW_LIMIT
        ? ` (+${orphans.length - PREVIEW_LIMIT} more)`
        : "";
    logger.info(
      `Orphan cleanup preview: ${orphans.length} secret(s)${orphans.length > 0 ? ` [${preview}${more}]` : ""}`,
    );

    if (dryRun) {
      logger.info("Orphan cleanup dry run: no secret deleted");
      return 0;
    }

    if (orphans.length > maxDeletions) {
      logger.error(
        `Orphan cleanup aborted: ${orphans.length} orphan(s) exceed ORPHAN_CLEANUP_MAX_DELETIONS=${maxDeletions}; nothing deleted`,
      );
      return 0;
    }

    let deleted = 0;
    for (const { namespace, name } of orphans) {
      try {
        await this.k8sClient.deleteSecret(namespace, name);
        deleted++;
      } catch (error) {
        logger.error(
          `Failed to delete orphaned secret ${namespace}/${name}: ${error}`,
        );
      }
    }
    if (deleted > 0) {
      logger.info(`Orphan cleanup deleted ${deleted} secret(s)`);
    }
    return deleted;
  }
}
