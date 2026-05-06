/**
 * Shared types for kubernetes-secrets-cloud-sync
 */

/** A map of secret key-value pairs (plaintext) */
export type SecretData = Record<string, string>;

/** Result of fetching a secret from a cloud provider */
export interface SecretFetchResult {
  /** The cloud provider that provided this secret */
  provider: string;
  /** The secret name in the cloud provider */
  secretName: string;
  /** Key-value pairs from the secret */
  data: SecretData;
}

/** Parsed annotation entry from a namespace */
export interface AnnotationEntry {
  /** The cloud provider identifier (e.g., "alibaba-kms") */
  provider: string;
  /** List of secret names to sync from this provider */
  secretNames: string[];
}

/** Namespace sync request derived from annotations */
export interface NamespaceSyncRequest {
  /** The namespace name */
  namespace: string;
  /** Parsed annotation entries */
  annotations: AnnotationEntry[];
}
