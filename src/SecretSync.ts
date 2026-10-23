import { Config } from "./Config";
import { mapWithConcurrency } from "./Concurrency";
import { SecretSource } from "./sources/SecretSource";
import { KubernetesClient, ManagedSecret } from "./KubernetesClient";
import { OTelLogger } from "./OTelContext";
import { normalizeSecretName } from "./SecretName";
import { SecretFetchResult } from "./types";

const logger = OTelLogger().createModuleLogger("secret-sync");

const DEFAULT_MAX_ORPHAN_DELETIONS = 50;
const DEFAULT_CONCURRENCY = 4;
const PREVIEW_LIMIT = 20;

interface FetchRequest {
  provider: string;
  secretName: string;
}

interface UpsertTarget {
  namespace: string;
  provider: string;
  secretName: string;
  k8sSecretName: string;
  fetchKey: string;
}

interface FetchOutcome {
  ok: boolean;
  result?: SecretFetchResult;
  error?: unknown;
}

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
   * 2. Pre-collect the union of requested secrets and upsert targets
   * 3. Resolve source cycles, fetch each unique secret once (bounded concurrency)
   * 4. Create/update Kubernetes secrets in each namespace (bounded concurrency)
   * 5. Optionally delete managed secrets that no longer match any annotation
   */
  async runSync(): Promise<void> {
    logger.info("Starting sync cycle");

    let namespacesSynced = 0;
    let errors = 0;
    let namespaceListSucceeded = false;
    let uniqueFetches = 0;
    let duplicatesAvoided = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const startedAt = Date.now();
    const expected = new Set<string>();
    const identityByKey = new Map<string, string>();
    const collisionKeys = new Set<string>();

    try {
      const requests = await this.k8sClient.getNamespaceSyncRequests();
      namespaceListSucceeded = true;
      namespacesSynced = requests.length;
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

      // Pre-collect the union of fetch requests and per-namespace upserts so
      // each unique (provider, secret) is fetched once per cycle.
      const collisionErrorsCounted = new Set<string>();
      const fetchRequests = new Map<string, FetchRequest>();
      const upsertTargets = new Map<string, UpsertTarget>();
      const namesByProvider = new Map<string, Set<string>>();
      let referencesRequested = 0;

      for (const request of requests) {
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
            const k8sSecretName = normalizeSecretName(
              secretName,
              this.k8sClient.secretNamePrefix,
            );
            const collisionKey = `${request.namespace}/${k8sSecretName}`;
            if (collisionKeys.has(collisionKey)) {
              if (!collisionErrorsCounted.has(collisionKey)) {
                collisionErrorsCounted.add(collisionKey);
                errors++;
              }
              continue;
            }

            referencesRequested++;
            const fetchKey = `${annotation.provider}\0${secretName}`;
            if (!fetchRequests.has(fetchKey)) {
              fetchRequests.set(fetchKey, {
                provider: annotation.provider,
                secretName,
              });
            }
            const targetKey = `${request.namespace}\0${k8sSecretName}`;
            if (!upsertTargets.has(targetKey)) {
              upsertTargets.set(targetKey, {
                namespace: request.namespace,
                provider: annotation.provider,
                secretName,
                k8sSecretName,
                fetchKey,
              });
            }

            let providerNames = namesByProvider.get(annotation.provider);
            if (!providerNames) {
              providerNames = new Set<string>();
              namesByProvider.set(annotation.provider, providerNames);
            }
            providerNames.add(secretName);
          }
        }
      }

      uniqueFetches = fetchRequests.size;
      duplicatesAvoided = referencesRequested - uniqueFetches;

      const fetchOutcomes = new Map<string, FetchOutcome>();
      const startedSources = new Map<string, SecretSource>();
      try {
        for (const [provider, providerNames] of namesByProvider) {
          const source = this.sources.get(provider);
          if (!source?.beginCycle) {
            continue;
          }
          startedSources.set(provider, source);
          try {
            await source.beginCycle([...providerNames]);
          } catch (error) {
            errors++;
            logger.error(
              `Secret source ${provider} beginCycle failed: ${error}`,
            );
          }
        }

        await mapWithConcurrency(
          [...fetchRequests.entries()],
          this.getConcurrency(this.config.SYNC_FETCH_CONCURRENCY),
          async ([fetchKey, request]) => {
            const source = this.sources.get(request.provider);
            try {
              const result = await source.fetchSecret(request.secretName);
              fetchOutcomes.set(fetchKey, { ok: true, result });
            } catch (error) {
              fetchOutcomes.set(fetchKey, { ok: false, error });
            }
          },
        );

        for (const [fetchKey, outcome] of fetchOutcomes) {
          if (outcome.ok) {
            continue;
          }
          errors++;
          const [provider, secretName] = fetchKey.split("\0");
          logger.error(
            `Failed to fetch secret ${secretName} from ${provider}: ${outcome.error}`,
          );
        }

        await mapWithConcurrency(
          [...upsertTargets.values()],
          this.getConcurrency(this.config.SYNC_WRITE_CONCURRENCY),
          async (target) => {
            const outcome = fetchOutcomes.get(target.fetchKey);
            if (!outcome || !outcome.ok) {
              errors++;
              return;
            }
            try {
              const action = await this.k8sClient.upsertSecret(
                target.namespace,
                target.secretName,
                outcome.result.data,
              );
              if (action === "created") {
                created++;
              } else if (action === "updated") {
                updated++;
              } else {
                unchanged++;
              }
            } catch (error) {
              errors++;
              logger.error(
                `Failed to upsert secret ${target.secretName} in namespace ${target.namespace}: ${error}`,
              );
            }
          },
        );
      } finally {
        for (const [provider, source] of startedSources) {
          try {
            await source.endCycle?.();
          } catch (error) {
            logger.warn(`Secret source ${provider} endCycle failed: ${error}`);
          }
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
      `Sync cycle complete (instance ${this.k8sClient.instanceId ?? "unknown"}, orphan cleanup ${cleanupMode}): ${namespacesSynced} namespace(s), ${uniqueFetches} unique fetch(es) (${duplicatesAvoided} duplicate(s) avoided), ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphansDeleted} orphan(s) deleted, ${errors} error(s), ${Date.now() - startedAt} ms`,
    );
  }

  private isTruthy(value: string | boolean | undefined): boolean {
    return value === true || value === "true" || value === "1";
  }

  private getConcurrency(value: number | string | undefined): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return DEFAULT_CONCURRENCY;
    }
    return Math.floor(parsed);
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
