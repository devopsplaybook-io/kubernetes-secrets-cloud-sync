import { Config } from "./Config";
import { mapWithConcurrency } from "./Concurrency";
import { Span } from "@opentelemetry/sdk-trace-base";
import { SecretSource } from "./sources/SecretSource";
import { KubernetesClient, ManagedSecret } from "./KubernetesClient";
import { OTelEndSpan, OTelLogger, OTelStartSpan, toError } from "./OTelContext";
import { normalizeSecretName } from "./SecretName";
import { SecretFetchResult, SyncRunResult } from "./types";

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
  async runSync(): Promise<SyncRunResult> {
    const startedAt = Date.now();
    const rootSpan = OTelStartSpan("sync-run");
    logger.info("Starting sync cycle");

    let namespacesSynced = 0;
    let errors = 0;
    let namespaceListSucceeded = false;
    let uniqueFetches = 0;
    let succeededSecrets = 0;
    let duplicatesAvoided = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const expected = new Set<string>();
    const identityByKey = new Map<string, string>();
    const collisionKeys = new Set<string>();
    const requestedSecretKeys = new Set<string>();
    const failedNamespaces = new Set<string>();

    try {
      const requests =
        await this.k8sClient.getNamespaceSyncRequests(rootSpan);
      namespaceListSucceeded = true;
      namespacesSynced = requests.length;
      logger.info(
        `Found ${requests.length} namespace(s) with sync annotations`,
      );

      // Build the expected set from annotations regardless of fetch outcome.
      for (const request of requests) {
        for (const annotation of request.annotations) {
          for (const secretName of annotation.secretNames) {
            requestedSecretKeys.add(`${annotation.provider}\0${secretName}`);
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
              failedNamespaces.add(request.namespace);
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
          const beginSpan = OTelStartSpan(
            "source-begin-cycle",
            { "source.provider": provider },
            rootSpan,
          );
          try {
            await source.beginCycle([...providerNames]);
            OTelEndSpan(beginSpan);
          } catch (error) {
            errors++;
            for (const request of requests) {
              for (const annotation of request.annotations) {
                if (annotation.provider === provider) {
                  failedNamespaces.add(request.namespace);
                }
              }
            }
            OTelEndSpan(beginSpan, error);
            logger.error(
              `Secret source ${provider} beginCycle failed`,
              toError(error),
            );
          }
        }

        await mapWithConcurrency(
          [...fetchRequests.entries()],
          this.getConcurrency(this.config.SYNC_FETCH_CONCURRENCY),
          async ([fetchKey, request]) => {
            const source = this.sources.get(request.provider);
            const fetchSpan = OTelStartSpan(
              "source-fetch",
              {
                "secret.provider": request.provider,
                "secret.name": request.secretName,
              },
              rootSpan,
            );
            try {
              const result = await source.fetchSecret(request.secretName);
              fetchOutcomes.set(fetchKey, { ok: true, result });
              fetchSpan?.setAttribute("source.fetch.success", true);
              OTelEndSpan(fetchSpan);
            } catch (error) {
              fetchOutcomes.set(fetchKey, { ok: false, error });
              fetchSpan?.setAttribute("source.fetch.success", false);
              OTelEndSpan(fetchSpan, error);
            }
          },
        );

        for (const [fetchKey, outcome] of fetchOutcomes) {
          if (outcome.ok) {
            succeededSecrets++;
            continue;
          }
          errors++;
          for (const target of upsertTargets.values()) {
            if (target.fetchKey === fetchKey) {
              failedNamespaces.add(target.namespace);
            }
          }
          const [provider, secretName] = fetchKey.split("\0");
          logger.error(
            `Failed to fetch secret ${secretName} from ${provider}`,
            toError(outcome.error),
          );
        }

        await mapWithConcurrency(
          [...upsertTargets.values()],
          this.getConcurrency(this.config.SYNC_WRITE_CONCURRENCY),
          async (target) => {
            const outcome = fetchOutcomes.get(target.fetchKey);
            if (!outcome || !outcome.ok) {
              // The fetch failure was already counted once; nothing to write.
              return;
            }
            try {
              const action = await this.k8sClient.upsertSecret(
                target.namespace,
                target.secretName,
                outcome.result.data,
                rootSpan,
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
              failedNamespaces.add(target.namespace);
              logger.error(
                `Failed to upsert secret ${target.secretName} in namespace ${target.namespace}`,
                toError(error),
              );
            }
          },
        );
      } finally {
        for (const [provider, source] of startedSources) {
          const endSpan = OTelStartSpan(
            "source-end-cycle",
            { "source.provider": provider },
            rootSpan,
          );
          try {
            await source.endCycle?.();
            OTelEndSpan(endSpan);
          } catch (error) {
            OTelEndSpan(endSpan, error);
            logger.warn(
              `Secret source ${provider} endCycle failed: ${toError(error).message}`,
            );
          }
        }
      }
    } catch (error) {
      errors++;
      logger.error("Failed to list namespaces", toError(error));
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
          const orphanResult = await this.pruneOrphanedSecrets(
            expected,
            dryRun,
            maxDeletions,
            rootSpan,
          );
          orphansDeleted = orphanResult.deleted;
          errors += orphanResult.errors;
        } catch (error) {
          errors++;
          logger.error("Failed to prune orphaned secrets", toError(error));
        }
      }
    }

    const cleanupMode = deleteOrphans
      ? dryRun
        ? "dry-run"
        : "enabled"
      : "disabled";
    const durationMs = Date.now() - startedAt;
    const result: SyncRunResult = {
      namespaces: namespacesSynced,
      secrets: requestedSecretKeys.size,
      succeededSecrets,
      errors,
      failedNamespaces: [...failedNamespaces].sort(),
      namespaceListSucceeded,
      durationMs,
    };

    if (rootSpan) {
      rootSpan.setAttribute("sync.namespaces", result.namespaces);
      rootSpan.setAttribute("sync.secrets", result.secrets);
      rootSpan.setAttribute("sync.succeeded_secrets", result.succeededSecrets);
      rootSpan.setAttribute("sync.errors", result.errors);
      rootSpan.setAttribute(
        "sync.failed_namespaces",
        result.failedNamespaces.join(","),
      );
      rootSpan.setAttribute("sync.duration_ms", result.durationMs);
      rootSpan.setAttribute(
        "sync.namespace_list_succeeded",
        result.namespaceListSucceeded,
      );
    }
    const spanError = !namespaceListSucceeded
      ? new Error("Namespace listing failed")
      : errors > 0
        ? new Error(`Sync cycle completed with ${errors} error(s)`)
        : undefined;
    OTelEndSpan(rootSpan, spanError);

    logger.info(
      `Sync cycle complete (instance ${this.k8sClient.instanceId ?? "unknown"}, orphan cleanup ${cleanupMode}): ${namespacesSynced} namespace(s), ${uniqueFetches} unique fetch(es) (${duplicatesAvoided} duplicate(s) avoided), ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphansDeleted} orphan(s) deleted, ${failedNamespaces.size} failed namespace(s), ${errors} error(s), ${durationMs} ms`,
    );

    return result;
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
    parentSpan?: Span,
  ): Promise<{ deleted: number; errors: number }> {
    const managed = await this.k8sClient.listManagedSecrets(parentSpan);
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
      return { deleted: 0, errors: 0 };
    }

    if (orphans.length > maxDeletions) {
      logger.error(
        `Orphan cleanup aborted: ${orphans.length} orphan(s) exceed ORPHAN_CLEANUP_MAX_DELETIONS=${maxDeletions}; nothing deleted`,
      );
      return { deleted: 0, errors: 0 };
    }

    let deleted = 0;
    let deleteErrors = 0;
    for (const { namespace, name } of orphans) {
      try {
        await this.k8sClient.deleteSecret(namespace, name, parentSpan);
        deleted++;
      } catch (error) {
        deleteErrors++;
        logger.error(
          `Failed to delete orphaned secret ${namespace}/${name}`,
          toError(error),
        );
      }
    }
    if (deleted > 0) {
      logger.info(`Orphan cleanup deleted ${deleted} secret(s)`);
    }
    return { deleted, errors: deleteErrors };
  }
}
