import * as k8s from "@kubernetes/client-node";
import type { Span } from "@opentelemetry/api";
import { createHash } from "crypto";
import { OTelEndSpan, OTelLogger, OTelStartSpan, OTelWithSpan } from "./OTelContext";
import { Config } from "./Config";
import { AnnotationEntry, NamespaceSyncRequest } from "./types";
import {
  ADOPT_ANNOTATION,
  DATA_HASH_ANNOTATION,
  INSTANCE_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  SECRET_NAME_LABEL,
  SOURCE_NAME_ANNOTATION,
  instanceIdForPrefix,
  isValidLabelValue,
  normalizeSecretName,
} from "./SecretName";

const logger = OTelLogger().createModuleLogger("kubernetes-client");

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_MAX_DELAY_MS = 5_000;
const RETRY_AFTER_MAX_MS = 30_000;

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Raised when a single Kubernetes request exceeds K8S_REQUEST_TIMEOUT_MS. */
export class KubernetesRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** A Secret managed by this controller instance. */
export interface ManagedSecret {
  namespace: string;
  name: string;
  sourceName?: string;
}

/** Outcome of an upsert: whether the API was written to. */
export type UpsertResult = "created" | "updated" | "unchanged";

/** Outcome of the ownership check before overwriting an existing Secret. */
type Ownership = "owned" | "adopted";

type PatchOperation =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "test"; path: string; value: unknown };

/** SHA-256 of the canonical (sorted-key) plaintext payload. */
export function hashSecretData(data: Record<string, string>): string {
  const canonical = Object.keys(data)
    .sort()
    .map((key) => [key, data[key]]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Escape a map key for use as a single JSON Pointer reference token (RFC 6901). */
export function escapeJsonPointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Compare existing Secret data with the base64 payload we would write.
 * `@kubernetes/client-node` may hand back either base64 strings or Buffers.
 */
function secretDataEquals(
  existingData: Record<string, unknown> | undefined,
  encodedData: Record<string, string>,
): boolean {
  const existing = existingData ?? {};
  const keys = Object.keys(existing);
  if (keys.length !== Object.keys(encodedData).length) {
    return false;
  }
  return keys.every((key) => {
    if (!Object.prototype.hasOwnProperty.call(encodedData, key)) {
      return false;
    }
    const value = existing[key];
    const asBase64 = Buffer.isBuffer(value)
      ? value.toString("base64")
      : String(value);
    return asBase64 === encodedData[key];
  });
}

/**
 * Kubernetes API client for namespace and secret operations.
 */
export class KubernetesClient {
  private k8sApi: any;
  private readonly annotationPrefix: string;
  public readonly secretNamePrefix: string;
  public readonly instanceId: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetryAttempts: number;
  public static readonly MANAGED_BY_LABEL = MANAGED_BY_LABEL;
  public static readonly MANAGED_BY_VALUE = MANAGED_BY_VALUE;

  constructor(config: Config) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
    this.annotationPrefix = config.ANNOTATION_PREFIX;
    this.secretNamePrefix = config.SECRET_NAME_PREFIX;
    this.instanceId = instanceIdForPrefix(config.ANNOTATION_PREFIX);

    const requestTimeoutMs = Number(config.K8S_REQUEST_TIMEOUT_MS);
    this.requestTimeoutMs =
      Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
        ? requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;

    const maxRetryAttempts = Number(config.K8S_RETRY_MAX_ATTEMPTS);
    this.maxRetryAttempts =
      Number.isFinite(maxRetryAttempts) && maxRetryAttempts >= 1
        ? Math.floor(maxRetryAttempts)
        : DEFAULT_MAX_RETRY_ATTEMPTS;
  }

  /**
   * List all namespaces and extract sync annotations.
   * Returns only namespaces that have at least one matching annotation.
   */
  async getNamespaceSyncRequests(
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<NamespaceSyncRequest[]> {
    const span = OTelStartSpan("k8s-list-namespaces", undefined, parentSpan);
    try {
      const nsList = await OTelWithSpan(span, () =>
        this.withRetry<k8s.V1NamespaceList>(
          "list namespaces",
          signal,
          this.maxRetryAttempts,
          (requestSignal) =>
            this.k8sApi.listNamespace({}, this.buildRequestOptions(requestSignal)),
        ),
      );
      const requests: NamespaceSyncRequest[] = [];

      for (const ns of nsList.items) {
        const namespaceName = ns.metadata?.name;
        if (!namespaceName) {
          continue;
        }

        const annotations = ns.metadata?.annotations;
        if (!annotations) {
          continue;
        }

        const annotationEntries = this.parseAnnotations(annotations);
        if (annotationEntries.length === 0) {
          continue;
        }

        requests.push({
          namespace: namespaceName,
          annotations: annotationEntries,
        });
      }

      OTelEndSpan(span);
      return requests;
    } catch (error) {
      OTelEndSpan(span, error);
      throw error;
    }
  }

  /**
   * Parse namespace annotations to find cloud sync entries.
   * Looks for annotations with the configured prefix.
   */
  private parseAnnotations(
    annotations: Record<string, string>,
  ): AnnotationEntry[] {
    const entries: AnnotationEntry[] = [];

    for (const [key, value] of Object.entries(annotations)) {
      if (!key.startsWith(this.annotationPrefix + "/")) {
        continue;
      }

      const provider = key.substring(this.annotationPrefix.length + 1);
      if (!provider) {
        continue;
      }

      const secretNames = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      if (secretNames.length > 0) {
        entries.push({ provider, secretNames });
      }
    }

    return entries;
  }

  /**
   * Create or update a Kubernetes secret in the specified namespace.
   *
   * The cloud identifier is normalized into a valid Kubernetes Secret name and
   * stored in the `cloudsync.devopsplaybook.io/source-name` annotation. Existing
   * Secrets that are not managed by this controller are never overwritten
   * unless they carry the explicit adoption annotation. Secrets managed by a
   * different controller instance require the same adoption annotation.
   *
   * Updates are sent as RFC 6902 JSON Patch operations guarded by a
   * `test /metadata/resourceVersion`, so unrelated labels/annotations survive
   * and a concurrent writer causes a conflict that is retried, not overwritten.
   */
  async upsertSecret(
    namespace: string,
    secretName: string,
    data: Record<string, string>,
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<UpsertResult> {
    const k8sSecretName = normalizeSecretName(
      secretName,
      this.secretNamePrefix,
    );
    const keyCount = Object.keys(data).length;
    const hash = hashSecretData(data);

    // Encode all values to base64 for Kubernetes secret data field
    const encodedData: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      encodedData[key] = Buffer.from(value).toString("base64");
    }

    const existing = await this.getSecret(
      namespace,
      k8sSecretName,
      parentSpan,
      signal,
    );
    if (!existing) {
      try {
        await this.createSecret(
          namespace,
          this.buildSecretBody(
            k8sSecretName,
            secretName,
            encodedData,
            hash,
          ),
          k8sSecretName,
          parentSpan,
          signal,
        );
        logger.info(
          `Created secret: ${namespace}/${k8sSecretName} (source "${secretName}", ${keyCount} keys)`,
        );
        return "created";
      } catch (error: unknown) {
        if (this.getErrorStatusCode(error) !== 409) {
          throw error;
        }
        // A concurrent create won the race: fall through to the update path.
        const raced = await this.getSecret(
          namespace,
          k8sSecretName,
          parentSpan,
          signal,
        );
        if (!raced) {
          throw error;
        }
        return await this.updateExistingSecret(
          namespace,
          k8sSecretName,
          secretName,
          raced,
          encodedData,
          hash,
          keyCount,
          parentSpan,
          signal,
        );
      }
    }

    return await this.updateExistingSecret(
      namespace,
      k8sSecretName,
      secretName,
      existing,
      encodedData,
      hash,
      keyCount,
      parentSpan,
      signal,
    );
  }

  /**
   * List every secret across the cluster that was created/managed by this
   * controller instance (identified by the managed-by and instance labels).
   */
  async listManagedSecrets(
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<ManagedSecret[]> {
    const span = OTelStartSpan("k8s-list-secrets", undefined, parentSpan);
    try {
      const labelSelector = `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${INSTANCE_LABEL}=${this.instanceId}`;
      const result = await OTelWithSpan(span, () =>
        this.withRetry<k8s.V1SecretList>(
          "list secrets",
          signal,
          this.maxRetryAttempts,
          (requestSignal) =>
            this.k8sApi.listSecretForAllNamespaces(
              { labelSelector },
              this.buildRequestOptions(requestSignal),
            ),
        ),
      );

      const managed: ManagedSecret[] = [];
      for (const secret of result.items ?? []) {
        const ns = secret.metadata?.namespace;
        const name = secret.metadata?.name;
        if (ns && name) {
          managed.push({
            namespace: ns,
            name,
            sourceName: secret.metadata?.annotations?.[SOURCE_NAME_ANNOTATION],
          });
        }
      }
      OTelEndSpan(span);
      return managed;
    } catch (error) {
      OTelEndSpan(span, error);
      throw error;
    }
  }

  /**
   * Delete a Kubernetes secret.
   */
  async deleteSecret(
    namespace: string,
    name: string,
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<void> {
    const span = OTelStartSpan(
      "k8s-delete-secret",
      { "k8s.namespace": namespace, "k8s.secret_name": name },
      parentSpan,
    );
    try {
      await OTelWithSpan(span, () =>
        this.withRetry(
          "delete secret",
          signal,
          this.maxRetryAttempts,
          (requestSignal) =>
            this.k8sApi.deleteNamespacedSecret(
              { namespace, name },
              this.buildRequestOptions(requestSignal),
            ),
        ),
      );
      OTelEndSpan(span);
      logger.info(`Deleted orphaned secret: ${namespace}/${name}`);
    } catch (error: unknown) {
      if (this.getErrorStatusCode(error) === 404) {
        OTelEndSpan(span);
        logger.info(
          `Secret already gone, skipping delete: ${namespace}/${name}`,
        );
        return;
      }
      OTelEndSpan(span, error);
      throw error;
    }
  }

  private buildSecretBody(
    k8sSecretName: string,
    sourceName: string,
    encodedData: Record<string, string>,
    hash: string,
  ): k8s.V1Secret {
    const labels: Record<string, string> = {
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [INSTANCE_LABEL]: this.instanceId,
    };
    if (isValidLabelValue(sourceName)) {
      labels[SECRET_NAME_LABEL] = sourceName;
    }

    return {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: k8sSecretName,
        labels,
        annotations: {
          [SOURCE_NAME_ANNOTATION]: sourceName,
          [DATA_HASH_ANNOTATION]: hash,
        },
      },
      type: "Opaque",
      data: encodedData,
    };
  }

  private async updateExistingSecret(
    namespace: string,
    k8sSecretName: string,
    sourceName: string,
    existing: k8s.V1Secret,
    encodedData: Record<string, string>,
    hash: string,
    keyCount: number,
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<UpsertResult> {
    const ownership = this.assertOwnership(
      namespace,
      k8sSecretName,
      sourceName,
      existing,
    );

    try {
      return await this.applyPatch(
        namespace,
        k8sSecretName,
        sourceName,
        existing,
        encodedData,
        hash,
        keyCount,
        ownership === "adopted",
        parentSpan,
        signal,
      );
    } catch (error: unknown) {
      const statusCode = this.getErrorStatusCode(error);
      if (statusCode === 404) {
        // Deleted between GET and PATCH: recreate it.
        await this.createSecret(
          namespace,
          this.buildSecretBody(
            k8sSecretName,
            sourceName,
            encodedData,
            hash,
          ),
          k8sSecretName,
          parentSpan,
          signal,
        );
        logger.info(
          `Created secret: ${namespace}/${k8sSecretName} (source "${sourceName}", ${keyCount} keys)`,
        );
        return "created";
      }
      if (statusCode !== 409) {
        throw error;
      }

      // Conflict (concurrent update): re-read and retry once with fresh
      // metadata. The resourceVersion test in the patch prevents overwriting
      // changes made by other writers between reads.
      logger.warn(
        `Conflict updating secret ${namespace}/${k8sSecretName}; re-reading and retrying once`,
      );
      const fresh = await this.getSecret(
        namespace,
        k8sSecretName,
        parentSpan,
        signal,
      );
      if (!fresh) {
        await this.createSecret(
          namespace,
          this.buildSecretBody(
            k8sSecretName,
            sourceName,
            encodedData,
            hash,
          ),
          k8sSecretName,
          parentSpan,
          signal,
        );
        logger.info(
          `Created secret: ${namespace}/${k8sSecretName} (source "${sourceName}", ${keyCount} keys)`,
        );
        return "created";
      }
      const retriedOwnership = this.assertOwnership(
        namespace,
        k8sSecretName,
        sourceName,
        fresh,
      );
      return await this.applyPatch(
        namespace,
        k8sSecretName,
        sourceName,
        fresh,
        encodedData,
        hash,
        keyCount,
        retriedOwnership === "adopted",
        parentSpan,
        signal,
      );
    }
  }

  private async applyPatch(
    namespace: string,
    k8sSecretName: string,
    sourceName: string,
    existing: k8s.V1Secret,
    encodedData: Record<string, string>,
    hash: string,
    keyCount: number,
    adopted: boolean,
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<UpsertResult> {
    const ops = this.buildUpdateOps(
      existing,
      sourceName,
      encodedData,
      hash,
      adopted,
    );
    if (ops.length === 0) {
      return "unchanged";
    }
    await this.patchSecret(
      namespace,
      k8sSecretName,
      ops,
      parentSpan,
      signal,
    );
    logger.info(
      `Updated secret: ${namespace}/${k8sSecretName} (source "${sourceName}", ${keyCount} keys)`,
    );
    return "updated";
  }

  private buildUpdateOps(
    existing: k8s.V1Secret,
    sourceName: string,
    encodedData: Record<string, string>,
    hash: string,
    adopted: boolean,
  ): PatchOperation[] {
    // RFC 6902 JSON Patch: per-key `add` only touches the members this
    // controller owns, so foreign labels/annotations are preserved. The
    // resourceVersion test makes a concurrent writer fail the patch instead of
    // silently losing its change.
    const ops: PatchOperation[] = [];

    const desiredLabels: Record<string, string> = {
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [INSTANCE_LABEL]: this.instanceId,
    };
    if (isValidLabelValue(sourceName)) {
      desiredLabels[SECRET_NAME_LABEL] = sourceName;
    }

    const labels = existing.metadata?.labels;
    if (labels === undefined) {
      ops.push({ op: "add", path: "/metadata/labels", value: desiredLabels });
    } else {
      for (const [key, value] of Object.entries(desiredLabels)) {
        if (labels[key] !== value) {
          ops.push({
            op: "add",
            path: `/metadata/labels/${escapeJsonPointer(key)}`,
            value,
          });
        }
      }
      if (
        labels[SECRET_NAME_LABEL] !== undefined &&
        desiredLabels[SECRET_NAME_LABEL] === undefined
      ) {
        ops.push({
          op: "remove",
          path: `/metadata/labels/${escapeJsonPointer(SECRET_NAME_LABEL)}`,
        });
      }
    }

    const desiredAnnotations: Record<string, string> = {
      [SOURCE_NAME_ANNOTATION]: sourceName,
      [DATA_HASH_ANNOTATION]: hash,
    };

    const annotations = existing.metadata?.annotations;
    if (annotations === undefined) {
      ops.push({
        op: "add",
        path: "/metadata/annotations",
        value: desiredAnnotations,
      });
    } else {
      for (const [key, value] of Object.entries(desiredAnnotations)) {
        if (annotations[key] !== value) {
          ops.push({
            op: "add",
            path: `/metadata/annotations/${escapeJsonPointer(key)}`,
            value,
          });
        }
      }
      if (adopted && annotations[ADOPT_ANNOTATION] !== undefined) {
        ops.push({
          op: "remove",
          path: `/metadata/annotations/${escapeJsonPointer(ADOPT_ANNOTATION)}`,
        });
      }
    }

    if (!secretDataEquals(existing.data, encodedData)) {
      ops.push({ op: "add", path: "/data", value: encodedData });
    }

    const resourceVersion = existing.metadata?.resourceVersion;
    if (resourceVersion && ops.length > 0) {
      ops.unshift({
        op: "test",
        path: "/metadata/resourceVersion",
        value: resourceVersion,
      });
    }
    return ops;
  }

  private async createSecret(
    namespace: string,
    body: k8s.V1Secret,
    k8sSecretName: string,
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<void> {
    const span = OTelStartSpan(
      "k8s-create-secret",
      { "k8s.namespace": namespace, "k8s.secret_name": k8sSecretName },
      parentSpan,
    );
    try {
      // Creates are not idempotent: never retried, even on 429/5xx.
      await OTelWithSpan(span, () =>
        this.withRetry("create secret", signal, 1, (requestSignal) =>
          this.k8sApi.createNamespacedSecret(
            { namespace, body },
            this.buildRequestOptions(requestSignal),
          ),
        ),
      );
      OTelEndSpan(span);
    } catch (error) {
      OTelEndSpan(span, error);
      throw error;
    }
  }

  private async patchSecret(
    namespace: string,
    k8sSecretName: string,
    body: PatchOperation[],
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<void> {
    const span = OTelStartSpan(
      "k8s-patch-secret",
      { "k8s.namespace": namespace, "k8s.secret_name": k8sSecretName },
      parentSpan,
    );
    try {
      await OTelWithSpan(span, () =>
        this.withRetry(
          "patch secret",
          signal,
          this.maxRetryAttempts,
          (requestSignal) =>
            this.k8sApi.patchNamespacedSecret(
              { name: k8sSecretName, namespace, body },
              this.buildRequestOptions(requestSignal),
            ),
        ),
      );
      OTelEndSpan(span);
    } catch (error) {
      OTelEndSpan(span, error);
      throw error;
    }
  }

  private assertOwnership(
    namespace: string,
    k8sSecretName: string,
    sourceName: string,
    existing: k8s.V1Secret,
  ): Ownership {
    const labels = existing.metadata?.labels;
    const managedBy = labels?.[MANAGED_BY_LABEL];
    if (managedBy === MANAGED_BY_VALUE) {
      const instance = labels?.[INSTANCE_LABEL];
      if (instance === undefined || instance === this.instanceId) {
        // Missing instance label: Secret written before instance tracking;
        // take it over and backfill the label.
        return "owned";
      }
      if (existing.metadata?.annotations?.[ADOPT_ANNOTATION] === "true") {
        logger.info(
          `Adopting secret managed by instance "${instance}": ${namespace}/${k8sSecretName} (source "${sourceName}")`,
        );
        return "adopted";
      }
      throw new Error(
        `Refusing to overwrite Secret "${namespace}/${k8sSecretName}" managed by another instance of ${MANAGED_BY_VALUE} (instance "${instance}", this instance "${this.instanceId}") for cloud secret "${sourceName}": add annotation ${ADOPT_ANNOTATION}="true" to adopt it`,
      );
    }

    if (existing.metadata?.annotations?.[ADOPT_ANNOTATION] === "true") {
      logger.info(
        `Adopting secret: ${namespace}/${k8sSecretName} (source "${sourceName}")`,
      );
      return "adopted";
    }

    throw new Error(
      `Refusing to overwrite unmanaged Secret "${namespace}/${k8sSecretName}" for cloud secret "${sourceName}": add annotation ${ADOPT_ANNOTATION}="true" to adopt it`,
    );
  }

  private async getSecret(
    namespace: string,
    name: string,
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<k8s.V1Secret | null> {
    const span = OTelStartSpan(
      "k8s-get-secret",
      { "k8s.namespace": namespace, "k8s.secret_name": name },
      parentSpan,
    );
    try {
      const secret = await OTelWithSpan(span, () =>
        this.withRetry<k8s.V1Secret>(
          "read secret",
          signal,
          this.maxRetryAttempts,
          (requestSignal) =>
            this.k8sApi.readNamespacedSecret(
              { name, namespace },
              this.buildRequestOptions(requestSignal),
            ),
        ),
      );
      OTelEndSpan(span);
      return secret;
    } catch (error: unknown) {
      if (this.getErrorStatusCode(error) === 404) {
        OTelEndSpan(span);
        return null;
      }
      OTelEndSpan(span, error);
      throw error;
    }
  }

  /**
   * Run an API call with a per-attempt timeout, a cycle-wide abort signal and
   * bounded, jittered retries for transient failures (429/5xx/network).
   */
  private async withRetry<T>(
    operation: string,
    signal: AbortSignal | undefined,
    maxAttempts: number,
    send: (requestSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const attempts =
      Number.isFinite(maxAttempts) && maxAttempts >= 1
        ? Math.floor(maxAttempts)
        : 1;
    let attempt = 0;

    while (true) {
      attempt += 1;
      signal?.throwIfAborted();

      const controller = new AbortController();
      const onCycleAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onCycleAbort, { once: true });
      const timer = setTimeout(() => {
        controller.abort(
          new KubernetesRequestTimeoutError(
            `Kubernetes ${operation} timed out after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);
      timer.unref?.();

      let failure: unknown;
      try {
        return await this.raceWithSignal(send(controller.signal), controller);
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onCycleAbort);
      }

      if (signal?.aborted) {
        throw signal.reason ?? failure;
      }
      const effective =
        controller.signal.aborted && controller.signal.reason
          ? controller.signal.reason
          : failure;
      if (attempt >= attempts || !this.isRetryableError(effective)) {
        throw effective;
      }

      const delay = this.retryDelayMs(effective, attempt);
      logger.warn(
        `Retrying Kubernetes ${operation} (attempt ${attempt}/${attempts}) in ${delay}ms: ${this.describeError(effective)}`,
      );
      await this.sleep(delay, signal);
    }
  }

  /**
   * Reject as soon as the attempt is aborted (timeout or cycle deadline),
   * without waiting for the underlying HTTP library to observe the signal.
   */
  private raceWithSignal<T>(
    work: Promise<T>,
    controller: AbortController,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(
          controller.signal.reason ?? new Error("Kubernetes request aborted"),
        );
      };
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          controller.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof KubernetesRequestTimeoutError) {
      return true;
    }

    const statusCode = this.getErrorStatusCode(error);
    if (statusCode !== undefined) {
      // 429 and 5xx are retryable; 400/401/403/404/409/422 are not.
      return statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
    }

    const candidate = error as {
      name?: unknown;
      code?: unknown;
      cause?: { code?: unknown; name?: unknown };
    };
    if (candidate?.name === "TimeoutError") {
      return true;
    }
    const codes = [candidate?.code, candidate?.cause?.code];
    return codes.some(
      (code) =>
        typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code),
    );
  }

  private retryDelayMs(error: unknown, attempt: number): number {
    const retryAfterMs = this.getRetryAfterMs(error);
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, RETRY_AFTER_MAX_MS);
    }
    const base = Math.min(
      RETRY_MAX_DELAY_MS,
      RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    );
    const jitter = 0.5 + Math.random() / 2;
    return Math.round(base * jitter);
  }

  private getRetryAfterMs(error: unknown): number | undefined {
    const candidate = error as {
      headers?: unknown;
      response?: { headers?: unknown };
    };
    const headers = candidate?.headers ?? candidate?.response?.headers;
    if (!headers) {
      return undefined;
    }

    let raw: string | undefined;
    const maybeGet = headers as { get?: (name: string) => string | null };
    if (typeof maybeGet.get === "function") {
      raw =
        maybeGet.get("retry-after") ??
        maybeGet.get("Retry-After") ??
        undefined;
    } else {
      const record = headers as Record<string, unknown>;
      const value = record["retry-after"] ?? record["Retry-After"];
      if (typeof value === "string") {
        raw = value;
      }
    }
    if (!raw) {
      return undefined;
    }

    const seconds = Number(raw);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
    return undefined;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Kubernetes request aborted"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("Kubernetes request aborted"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private buildRequestOptions(
    signal?: AbortSignal,
  ): k8s.ConfigurationOptions<k8s.Middleware> | undefined {
    if (!signal) {
      return undefined;
    }
    const middleware: k8s.Middleware = {
      pre: async (context: k8s.RequestContext) => {
        context.setSignal(signal);
        return context;
      },
      post: async (context: k8s.ResponseContext) => context,
    };
    // Append keeps the kubeconfig authentication middleware in place.
    return { middleware: [middleware], middlewareMergeStrategy: "append" };
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private getErrorStatusCode(error: unknown): number | undefined {
    if (error instanceof k8s.ApiException) {
      return error.code;
    }
    const fallback = error as {
      code?: unknown;
      statusCode?: unknown;
      response?: { statusCode?: unknown };
    };
    const statusCode =
      typeof fallback?.code === "number"
        ? fallback.code
        : typeof fallback?.statusCode === "number"
          ? fallback.statusCode
          : fallback?.response?.statusCode;
    return typeof statusCode === "number" ? statusCode : undefined;
  }
}
