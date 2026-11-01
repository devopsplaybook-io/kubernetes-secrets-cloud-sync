import { Config } from "./Config";
import { mapWithConcurrency } from "./Concurrency";
import type { Span } from "@opentelemetry/api";
import { SecretSource } from "./sources/SecretSource";
import { KubernetesClient, ManagedSecret } from "./KubernetesClient";
import { OTelEndSpan, OTelLogger, OTelStartSpan, OTelWithSpan, toError } from "./OTelContext";
import { normalizeSecretName } from "./SecretName";
import { SecretFetchResult, SyncRunResult } from "./types";

const logger = OTelLogger().createModuleLogger("secret-sync");

const DEFAULT_MAX_ORPHAN_DELETIONS = 50;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_CYCLE_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_SECRET_NAMES_PER_ANNOTATION = 100;
const MAX_SECRET_NAMES_PER_ANNOTATION_LIMIT = 1000;
const PREVIEW_LIMIT = 20;

/** Raised when SYNC_CYCLE_TIMEOUT_SECONDS expires while a cycle is running. */
export class CycleDeadlineError extends Error {
  constructor(seconds: number) {
    super(`Sync cycle deadline of ${seconds}s exceeded`);
    this.name = "CycleDeadlineError";
  }
}

interface FetchRequest {
  provider: string;
  secretName: string;
  source: SecretSource;
}

interface UpsertTarget {
  namespace: string;
  provider: string;
  secretName: string;
  k8sSecretName: string;
  fetchKey: string;
}

type FetchOutcome =
  | { ok: true; result: SecretFetchResult }
  | { ok: false; error: unknown; aborted: boolean };

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
    return OTelWithSpan(rootSpan, () => this.runCycle(startedAt, rootSpan));
  }

  private async runCycle(
    startedAt: number,
    rootSpan: Span | undefined,
  ): Promise<SyncRunResult> {
    logger.info("Starting sync cycle");

    const cycleTimeoutSeconds = this.getCycleTimeoutSeconds();
    const controller = new AbortController();
    const signal = controller.signal;
    let deadlineExceeded = false;
    const deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      controller.abort(new CycleDeadlineError(cycleTimeoutSeconds));
    }, cycleTimeoutSeconds * 1000);
    deadlineTimer.unref?.();

    let namespacesSynced = 0;
    let errors = 0;
    let namespaceListSucceeded = false;
    let uniqueFetches = 0;
    let succeededSecrets = 0;
    let duplicatesAvoided = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let cleanupAborted = false;
    let phase = "list namespaces";
    const expected = new Set<string>();
    const identityByKey = new Map<string, string>();
    const collisionKeys = new Set<string>();
    const requestedSecretKeys = new Set<string>();
    const failedNamespaces = new Set<string>();
    const unknownProviders = new Set<string>();
    const unavailableProviders = new Set<string>();

    try {
      const requests = await this.k8sClient.getNamespaceSyncRequests(
        rootSpan,
        signal,
      );
      namespaceListSucceeded = true;
      phase = "prepare sync targets";
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
            unknownProviders.add(annotation.provider);
            failedNamespaces.add(request.namespace);
            errors++;
            logger.error(
              `Secret provider not configured: ${annotation.provider} (namespace: ${request.namespace}); annotation skipped`,
            );
            continue;
          }
          if (!source.isAvailable()) {
            unavailableProviders.add(annotation.provider);
            failedNamespaces.add(request.namespace);
            errors++;
            logger.error(
              `Secret provider unavailable: ${annotation.provider} (namespace: ${request.namespace}); check its configuration, annotation skipped`,
            );
            continue;
          }

          const maxSecretNames = this.getMaxSecretNamesPerAnnotation();
          if (annotation.secretNames.length > maxSecretNames) {
            failedNamespaces.add(request.namespace);
            errors++;
            logger.error(
              `Annotation requests ${annotation.secretNames.length} secret(s) for provider ${annotation.provider} in namespace ${request.namespace}, above SYNC_MAX_SECRETS_PER_ANNOTATION=${maxSecretNames}; annotation skipped`,
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
                source,
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
      phase = "start source cycles";

      const fetchOutcomes = new Map<string, FetchOutcome>();
      const startedSources = new Map<string, SecretSource>();
      try {
        for (const [provider, providerNames] of namesByProvider) {
          const source = this.sources.get(provider);
          const beginCycle = source?.beginCycle;
          if (!source || !beginCycle) {
            continue;
          }
          startedSources.set(provider, source);
          const beginSpan = OTelStartSpan(
            "source-begin-cycle",
            { "source.provider": provider },
            rootSpan,
          );
          try {
            await OTelWithSpan(beginSpan, () =>
              beginCycle([...providerNames], { signal }),
            );
            OTelEndSpan(beginSpan);
          } catch (error) {
            OTelEndSpan(beginSpan, error);
            if (signal.aborted) {
              // The deadline is reported once after the sync phases.
              continue;
            }
            errors++;
            for (const request of requests) {
              for (const annotation of request.annotations) {
                if (annotation.provider === provider) {
                  failedNamespaces.add(request.namespace);
                }
              }
            }
            logger.error(
              `Secret source ${provider} beginCycle failed`,
              toError(error),
            );
          }
        }

        phase = "fetch secrets";
        await mapWithConcurrency(
          [...fetchRequests.entries()],
          this.getConcurrency(this.config.SYNC_FETCH_CONCURRENCY),
          async ([fetchKey, request]) => {
            const source = request.source;
            const fetchSpan = OTelStartSpan(
              "source-fetch",
              {
                "secret.provider": request.provider,
                "secret.name": request.secretName,
              },
              rootSpan,
            );
            try {
              const result = await OTelWithSpan(fetchSpan, () =>
                source.fetchSecret(request.secretName, { signal }),
              );
              fetchOutcomes.set(fetchKey, { ok: true, result });
              fetchSpan?.setAttribute("source.fetch.success", true);
              OTelEndSpan(fetchSpan);
            } catch (error) {
              fetchOutcomes.set(fetchKey, {
                ok: false,
                error,
                aborted: signal.aborted,
              });
              fetchSpan?.setAttribute("source.fetch.success", false);
              fetchSpan?.setAttribute("source.fetch.aborted", signal.aborted);
              OTelEndSpan(fetchSpan, error);
            }
          },
          signal,
        );

        for (const [fetchKey, outcome] of fetchOutcomes) {
          if (outcome.ok) {
            succeededSecrets++;
            continue;
          }
          if (outcome.aborted) {
            // Caused by the cycle deadline, which is counted once below.
            continue;
          }
          errors++;
          for (const target of upsertTargets.values()) {
            if (target.fetchKey === fetchKey) {
              failedNamespaces.add(target.namespace);
            }
          }
          const [provider, secretName] = fetchKey.split("\0");
          if (this.isNotFoundError(outcome.error)) {
            logger.error(
              `Secret not found in provider ${provider}: ${secretName}`,
              toError(outcome.error),
            );
          } else {
            logger.error(
              `Failed to fetch secret ${secretName} from ${provider}`,
              toError(outcome.error),
            );
          }
        }

        phase = "write secrets";
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
                signal,
              );
              if (action === "created") {
                created++;
              } else if (action === "updated") {
                updated++;
              } else {
                unchanged++;
              }
            } catch (error) {
              if (signal.aborted) {
                // Caused by the cycle deadline, which is counted once below.
                return;
              }
              errors++;
              failedNamespaces.add(target.namespace);
              logger.error(
                `Failed to upsert secret ${target.secretName} in namespace ${target.namespace}`,
                toError(error),
              );
            }
          },
          signal,
        );
      } finally {
        for (const [provider, source] of startedSources) {
          const endSpan = OTelStartSpan(
            "source-end-cycle",
            { "source.provider": provider },
            rootSpan,
          );
          try {
            await OTelWithSpan(endSpan, () => source.endCycle?.());
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
      logger.error(`Sync cycle failed during ${phase}`, toError(error));
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
      } else if (signal.aborted) {
        logger.warn(
          "Skipping orphan cleanup: sync cycle deadline exceeded, expected set may be stale",
        );
      } else {
        try {
          const orphanResult = await this.pruneOrphanedSecrets(
            expected,
            dryRun,
            maxDeletions,
            rootSpan,
            signal,
          );
          orphansDeleted = orphanResult.deleted;
          errors += orphanResult.errors;
          cleanupAborted = orphanResult.aborted;
        } catch (error) {
          logger.error("Failed to prune orphaned secrets", toError(error));
          if (!signal.aborted) {
            errors++;
          }
        }
      }
    }

    if (deadlineExceeded) {
      errors++;
      logger.error(
        `Sync cycle deadline of ${cycleTimeoutSeconds}s exceeded; remaining work was aborted`,
      );
    }
    clearTimeout(deadlineTimer);

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
      unknownProviders: [...unknownProviders].sort(),
      unavailableProviders: [...unavailableProviders].sort(),
      cleanupAborted,
      deadlineExceeded,
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
      rootSpan.setAttribute(
        "sync.unknown_providers",
        result.unknownProviders.join(","),
      );
      rootSpan.setAttribute(
        "sync.unavailable_providers",
        result.unavailableProviders.join(","),
      );
      rootSpan.setAttribute("sync.cleanup_aborted", result.cleanupAborted);
      rootSpan.setAttribute("sync.deadline_exceeded", result.deadlineExceeded);
      rootSpan.setAttribute("sync.duration_ms", result.durationMs);
      rootSpan.setAttribute(
        "sync.namespace_list_succeeded",
        result.namespaceListSucceeded,
      );
    }
    const spanError = result.deadlineExceeded
      ? new Error("Sync cycle deadline exceeded")
      : !namespaceListSucceeded
        ? new Error("Namespace listing failed")
        : errors > 0
          ? new Error(`Sync cycle completed with ${errors} error(s)`)
          : undefined;
    OTelEndSpan(rootSpan, spanError);

    const deadlineNote = deadlineExceeded ? ", cycle deadline exceeded" : "";
    const providerNote =
      unknownProviders.size + unavailableProviders.size > 0
        ? `, ${unknownProviders.size} unknown provider(s), ${unavailableProviders.size} unavailable provider(s)`
        : "";
    const cleanupNote = cleanupAborted
      ? ", orphan cleanup aborted (threshold exceeded)"
      : "";
    logger.info(
      `Sync cycle complete (instance ${this.k8sClient.instanceId ?? "unknown"}, orphan cleanup ${cleanupMode}): ${namespacesSynced} namespace(s), ${uniqueFetches} unique fetch(es) (${duplicatesAvoided} duplicate(s) avoided), ${created} created, ${updated} updated, ${unchanged} unchanged, ${orphansDeleted} orphan(s) deleted, ${failedNamespaces.size} failed namespace(s), ${errors} error(s)${providerNote}${cleanupNote}${deadlineNote}, ${durationMs} ms`,
    );

    return result;
  }

  private isTruthy(value: string | boolean | undefined): boolean {
    return value === true || value === "true" || value === "1";
  }

  private getCycleTimeoutSeconds(): number {
    const parsed = Number(this.config.SYNC_CYCLE_TIMEOUT_SECONDS);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return DEFAULT_CYCLE_TIMEOUT_SECONDS;
    }
    return Math.floor(parsed);
  }

  private isNotFoundError(error: unknown): boolean {
    const candidate = error as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const markers = [candidate?.name, candidate?.code]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase());
    if (
      markers.some(
        (value) =>
          value.includes("notfound") ||
          value.includes("not_found") ||
          value.includes("nosuch"),
      )
    ) {
      return true;
    }
    const message =
      typeof candidate?.message === "string"
        ? candidate.message.toLowerCase()
        : "";
    return message.includes("not found") || message.includes("no such");
  }

  private getConcurrency(value: number | string | undefined): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return DEFAULT_CONCURRENCY;
    }
    return Math.floor(parsed);
  }

  private getMaxSecretNamesPerAnnotation(): number {
    const parsed = Number(this.config.SYNC_MAX_SECRETS_PER_ANNOTATION);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return DEFAULT_MAX_SECRET_NAMES_PER_ANNOTATION;
    }
    return Math.min(Math.floor(parsed), MAX_SECRET_NAMES_PER_ANNOTATION_LIMIT);
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
    signal?: AbortSignal,
  ): Promise<{ deleted: number; errors: number; aborted: boolean }> {
    const managed = await this.k8sClient.listManagedSecrets(parentSpan, signal);
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
      return { deleted: 0, errors: 0, aborted: false };
    }

    if (orphans.length > maxDeletions) {
      logger.error(
        `Orphan cleanup aborted: ${orphans.length} orphan(s) exceed ORPHAN_CLEANUP_MAX_DELETIONS=${maxDeletions}; nothing deleted`,
      );
      return { deleted: 0, errors: 1, aborted: true };
    }

    let deleted = 0;
    let deleteErrors = 0;
    for (const { namespace, name } of orphans) {
      if (signal?.aborted) {
        return { deleted, errors: deleteErrors, aborted: true };
      }
      try {
        await this.k8sClient.deleteSecret(namespace, name, parentSpan, signal);
        deleted++;
      } catch (error) {
        if (signal?.aborted) {
          return { deleted, errors: deleteErrors, aborted: true };
        }
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
    return { deleted, errors: deleteErrors, aborted: false };
  }
}
