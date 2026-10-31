import * as k8s from "@kubernetes/client-node";
import type { Span } from "@opentelemetry/api";
import { createHash } from "crypto";
import { OTelEndSpan, OTelLogger, OTelStartSpan } from "./OTelContext";
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

/** A Secret managed by this controller instance. */
export interface ManagedSecret {
  namespace: string;
  name: string;
  sourceName?: string;
}

/** Outcome of an upsert: whether the API was written to. */
export type UpsertResult = "created" | "updated" | "unchanged";

/** SHA-256 of the canonical (sorted-key) plaintext payload. */
export function hashSecretData(data: Record<string, string>): string {
  const canonical = Object.keys(data)
    .sort()
    .map((key) => [key, data[key]]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function mapsEqual(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  const a = left ?? {};
  const b = right ?? {};
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  return aKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key],
  );
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

interface PatchOperation {
  op: "add";
  path: string;
  value: unknown;
}

/**
 * Kubernetes API client for namespace and secret operations.
 */
export class KubernetesClient {
  private k8sApi: any;
  private readonly annotationPrefix: string;
  public readonly secretNamePrefix: string;
  public readonly instanceId: string;
  public static readonly MANAGED_BY_LABEL = MANAGED_BY_LABEL;
  public static readonly MANAGED_BY_VALUE = MANAGED_BY_VALUE;

  constructor(config: Config) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
    this.annotationPrefix = config.ANNOTATION_PREFIX;
    this.secretNamePrefix = config.SECRET_NAME_PREFIX;
    this.instanceId = instanceIdForPrefix(config.ANNOTATION_PREFIX);
  }

  /**
   * List all namespaces and extract sync annotations.
   * Returns only namespaces that have at least one matching annotation.
   */
  async getNamespaceSyncRequests(
    parentSpan?: Span,
  ): Promise<NamespaceSyncRequest[]> {
    const span = OTelStartSpan("k8s-list-namespaces", undefined, parentSpan);
    try {
      const nsList = await this.k8sApi.listNamespace();
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
   * unless they carry the explicit adoption annotation.
   */
  async upsertSecret(
    namespace: string,
    secretName: string,
    data: Record<string, string>,
    parentSpan?: Span,
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

    const existing = await this.getSecret(namespace, k8sSecretName, parentSpan);
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
    );
  }

  /**
   * List every secret across the cluster that was created/managed by this
   * controller instance (identified by the managed-by and instance labels).
   */
  async listManagedSecrets(parentSpan?: Span): Promise<ManagedSecret[]> {
    const span = OTelStartSpan("k8s-list-secrets", undefined, parentSpan);
    try {
      const labelSelector = `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${INSTANCE_LABEL}=${this.instanceId}`;
      const result = await this.k8sApi.listSecretForAllNamespaces({
        labelSelector,
      });

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
  ): Promise<void> {
    const span = OTelStartSpan(
      "k8s-delete-secret",
      { "k8s.namespace": namespace, "k8s.secret_name": name },
      parentSpan,
    );
    try {
      await this.k8sApi.deleteNamespacedSecret({ namespace, name });
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
  ): Promise<UpsertResult> {
    this.assertOwnership(namespace, k8sSecretName, sourceName, existing);

    try {
      return await this.applyPatch(
        namespace,
        k8sSecretName,
        sourceName,
        existing,
        encodedData,
        hash,
        keyCount,
        parentSpan,
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
        );
        logger.info(
          `Created secret: ${namespace}/${k8sSecretName} (source "${sourceName}", ${keyCount} keys)`,
        );
        return "created";
      }
      if (statusCode !== 409) {
        throw error;
      }

      // Conflict (concurrent update): retry once with fresh metadata.
      const fresh = await this.getSecret(namespace, k8sSecretName, parentSpan);
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
        );
        logger.info(
          `Created secret: ${namespace}/${k8sSecretName} (source "${sourceName}", ${keyCount} keys)`,
        );
        return "created";
      }
      this.assertOwnership(namespace, k8sSecretName, sourceName, fresh);
      return await this.applyPatch(
        namespace,
        k8sSecretName,
        sourceName,
        fresh,
        encodedData,
        hash,
        keyCount,
        parentSpan,
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
    parentSpan?: Span,
  ): Promise<UpsertResult> {
    const ops = this.buildUpdateOps(existing, sourceName, encodedData, hash);
    if (ops.length === 0) {
      return "unchanged";
    }
    await this.patchSecret(
      namespace,
      k8sSecretName,
      ops,
      parentSpan,
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
  ): PatchOperation[] {
    // RFC 6902 JSON Patch: `add` replaces an existing member, so foreign
    // labels/annotations are preserved while our fields and data are replaced.
    const labels: Record<string, string> = {
      ...existing.metadata?.labels,
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [INSTANCE_LABEL]: this.instanceId,
    };
    if (isValidLabelValue(sourceName)) {
      labels[SECRET_NAME_LABEL] = sourceName;
    } else {
      delete labels[SECRET_NAME_LABEL];
    }

    const annotations: Record<string, string> = {
      ...existing.metadata?.annotations,
      [SOURCE_NAME_ANNOTATION]: sourceName,
      [DATA_HASH_ANNOTATION]: hash,
    };

    const ops: PatchOperation[] = [];
    if (!mapsEqual(existing.metadata?.labels, labels)) {
      ops.push({ op: "add", path: "/metadata/labels", value: labels });
    }
    if (!mapsEqual(existing.metadata?.annotations, annotations)) {
      ops.push({ op: "add", path: "/metadata/annotations", value: annotations });
    }
    if (!secretDataEquals(existing.data, encodedData)) {
      ops.push({ op: "add", path: "/data", value: encodedData });
    }
    return ops;
  }

  private async createSecret(
    namespace: string,
    body: k8s.V1Secret,
    k8sSecretName: string,
    parentSpan?: Span,
  ): Promise<void> {
    const span = OTelStartSpan(
      "k8s-create-secret",
      { "k8s.namespace": namespace, "k8s.secret_name": k8sSecretName },
      parentSpan,
    );
    try {
      await this.k8sApi.createNamespacedSecret({ namespace, body });
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
  ): Promise<void> {
    const span = OTelStartSpan(
      "k8s-patch-secret",
      { "k8s.namespace": namespace, "k8s.secret_name": k8sSecretName },
      parentSpan,
    );
    try {
      await this.k8sApi.patchNamespacedSecret({
        name: k8sSecretName,
        namespace,
        body,
        fieldManager: MANAGED_BY_VALUE,
      });
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
  ): void {
    const managedBy = existing.metadata?.labels?.[MANAGED_BY_LABEL];
    if (managedBy === MANAGED_BY_VALUE) {
      return;
    }

    if (existing.metadata?.annotations?.[ADOPT_ANNOTATION] === "true") {
      logger.info(
        `Adopting secret: ${namespace}/${k8sSecretName} (source "${sourceName}")`,
      );
      return;
    }

    throw new Error(
      `Refusing to overwrite unmanaged Secret "${namespace}/${k8sSecretName}" for cloud secret "${sourceName}": add annotation ${ADOPT_ANNOTATION}="true" to adopt it`,
    );
  }

  private async getSecret(
    namespace: string,
    name: string,
    parentSpan?: Span,
  ): Promise<k8s.V1Secret | null> {
    const span = OTelStartSpan(
      "k8s-get-secret",
      { "k8s.namespace": namespace, "k8s.secret_name": name },
      parentSpan,
    );
    try {
      const secret = await this.k8sApi.readNamespacedSecret({
        name,
        namespace,
      });
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
