import * as k8s from "@kubernetes/client-node";
import { OTelLogger } from "./OTelContext";
import { Config } from "./Config";
import { AnnotationEntry, NamespaceSyncRequest } from "./types";

const logger = OTelLogger().createModuleLogger("kubernetes-client");

/**
 * Kubernetes API client for namespace and secret operations.
 */
export class KubernetesClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private k8sApi: any;
  private readonly annotationPrefix: string;
  private readonly secretNamePrefix: string;

  constructor(config: Config) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
    this.annotationPrefix = config.ANNOTATION_PREFIX;
    this.secretNamePrefix = config.SECRET_NAME_PREFIX;
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
   * The secret name is prefixed with the configured prefix.
   * Each key from the secret data becomes a separate data entry (base64 encoded by K8s client).
   */
  async upsertSecret(
    namespace: string,
    secretName: string,
    data: Record<string, string>,
  ): Promise<void> {
    const k8sSecretName = `${this.secretNamePrefix}${secretName}`;

    // Encode all values to base64 for Kubernetes secret data field
    const encodedData: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      encodedData[key] = Buffer.from(value).toString("base64");
    }

    const secretBody: k8s.V1Secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: k8sSecretName,
        labels: {
          "app.kubernetes.io/managed-by": "kubernetes-secrets-cloud-sync",
          "cloudsync.devopsplaybook.io/secret-name": secretName,
        },
      },
      type: "Opaque",
      data: encodedData,
    };

    try {
      // Try to replace the existing secret first
      await this.k8sApi.replaceNamespacedSecret({
        name: k8sSecretName,
        namespace: namespace,
        body: secretBody,
      });
      logger.info(
        `Updated secret: ${namespace}/${k8sSecretName} (${Object.keys(data).length} keys)`,
      );
    } catch (error: unknown) {
      const statusCode =
        (error as { response?: { statusCode?: number } })?.response
          ?.statusCode || (error as { statusCode?: number })?.statusCode;
      if (statusCode === 404) {
        // Secret doesn't exist yet, create it
        await this.k8sApi.createNamespacedSecret({
          namespace: namespace,
          body: secretBody,
        });
        logger.info(
          `Created secret: ${namespace}/${k8sSecretName} (${Object.keys(data).length} keys)`,
        );
      } else {
        throw error;
      }
    }
  }
}
