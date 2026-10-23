import * as k8s from "@kubernetes/client-node";
import { OTelLogger } from "./OTelContext";
import { Config } from "./Config";
import { AnnotationEntry, NamespaceSyncRequest } from "./types";
import {
  ADOPT_ANNOTATION,
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
  async getNamespaceSyncRequests(): Promise<NamespaceSyncRequest[]> {
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

      logger.info(
        `Namespace ${namespaceName}: found ${annotationEntries.length} sync annotation(s)`,
      );
      requests.push({
        namespace: namespaceName,
        annotations: annotationEntries,
      });
    }

    return requests;
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
  ): Promise<void> {
    const k8sSecretName = normalizeSecretName(
      secretName,
      this.secretNamePrefix,
    );
    const keyCount = Object.keys(data).length;

    // Encode all values to base64 for Kubernetes secret data field
    const encodedData: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      encodedData[key] = Buffer.from(value).toString("base64");
    }

    const existing = await this.getSecret(namespace, k8sSecretName);
    if (!existing) {
      try {
        await this.k8sApi.createNamespacedSecret({
          namespace,
          body: this.buildSecretBody(k8sSecretName, secretName, encodedData),
        });
        logger.info(
          `Created secret: ${namespace}/${k8sSecretName} (source "${secretName}", ${keyCount} keys)`,
        );
        return;
      } catch (error: unknown) {
        if (this.getErrorStatusCode(error) !== 409) {
          throw error;
        }
        // A concurrent create won the race: fall through to the update path.
        const raced = await this.getSecret(namespace, k8sSecretName);
        if (!raced) {
          throw error;
        }
        await this.updateExistingSecret(
          namespace,
          k8sSecretName,
          secretName,
          raced,
          encodedData,
          keyCount,
        );
        return;
      }
    }

    await this.updateExistingSecret(
      namespace,
      k8sSecretName,
      secretName,
      existing,
      encodedData,
      keyCount,
    );
  }

  /**
   * List every secret across the cluster that was created/managed by this
   * controller instance (identified by the managed-by and instance labels).
   */
  async listManagedSecrets(): Promise<ManagedSecret[]> {
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
    return managed;
  }

  /**
   * Delete a Kubernetes secret.
   */
  async deleteSecret(namespace: string, name: string): Promise<void> {
    try {
      await this.k8sApi.deleteNamespacedSecret({ namespace, name });
      logger.info(`Deleted orphaned secret: ${namespace}/${name}`);
    } catch (error: unknown) {
      if (this.getErrorStatusCode(error) === 404) {
        logger.info(
          `Secret already gone, skipping delete: ${namespace}/${name}`,
        );
        return;
      }
      throw error;
    }
  }

  private buildSecretBody(
    k8sSecretName: string,
    sourceName: string,
    encodedData: Record<string, string>,
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
        annotations: { [SOURCE_NAME_ANNOTATION]: sourceName },
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
    keyCount: number,
  ): Promise<void> {
    this.assertOwnership(namespace, k8sSecretName, sourceName, existing);

    try {
      await this.patchSecret(
        namespace,
        k8sSecretName,
        sourceName,
        existing,
        encodedData,
      );
      logger.info(
        `Updated secret: ${namespace}/${k8sSecretName} (source "${sourceName}", ${keyCount} keys)`,
      );
    } catch (error: unknown) {
      const statusCode = this.getErrorStatusCode(error);
      if (statusCode === 404) {
        // Deleted between GET and PATCH: recreate it.
        await this.k8sApi.createNamespacedSecret({
          namespace,
          body: this.buildSecretBody(k8sSecretName, sourceName, encodedData),
        });
        logger.info(
          `Created secret: ${namespace}/${k8sSecretName} (source "${sourceName}", ${keyCount} keys)`,
        );
        return;
      }
      if (statusCode !== 409) {
        throw error;
      }

      // Conflict (concurrent update): retry once with fresh metadata.
      const fresh = await this.getSecret(namespace, k8sSecretName);
      if (!fresh) {
        await this.k8sApi.createNamespacedSecret({
          namespace,
          body: this.buildSecretBody(k8sSecretName, sourceName, encodedData),
        });
        logger.info(
          `Created secret: ${namespace}/${k8sSecretName} (source "${sourceName}", ${keyCount} keys)`,
        );
        return;
      }
      this.assertOwnership(namespace, k8sSecretName, sourceName, fresh);
      await this.patchSecret(
        namespace,
        k8sSecretName,
        sourceName,
        fresh,
        encodedData,
      );
      logger.info(
        `Updated secret: ${namespace}/${k8sSecretName} (source "${sourceName}", ${keyCount} keys)`,
      );
    }
  }

  private async patchSecret(
    namespace: string,
    k8sSecretName: string,
    sourceName: string,
    existing: k8s.V1Secret,
    encodedData: Record<string, string>,
  ): Promise<void> {
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
    };

    const body = [
      { op: "add", path: "/metadata/labels", value: labels },
      { op: "add", path: "/metadata/annotations", value: annotations },
      { op: "add", path: "/data", value: encodedData },
    ];

    await this.k8sApi.patchNamespacedSecret({
      name: k8sSecretName,
      namespace,
      body,
      fieldManager: MANAGED_BY_VALUE,
    });
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
  ): Promise<k8s.V1Secret | null> {
    try {
      return await this.k8sApi.getNamespacedSecret({ name, namespace });
    } catch (error: unknown) {
      if (this.getErrorStatusCode(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  private getErrorStatusCode(error: unknown): number | undefined {
    return (
      (error as { code?: number })?.code ||
      (error as { response?: { statusCode?: number } })?.response?.statusCode ||
      (error as { statusCode?: number })?.statusCode
    );
  }
}
