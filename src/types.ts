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

/** Structured outcome of one full sync cycle. */
export interface SyncRunResult {
  /** Annotated namespaces found (0 when listing failed) */
  namespaces: number;
  /** Unique (provider, secret) pairs requested by annotations */
  secrets: number;
  /** Unique (provider, secret) pairs fetched successfully */
  succeededSecrets: number;
  /** Failed list/fetch/write/cleanup operations */
  errors: number;
  /** Namespaces with at least one failed fetch, write or collision */
  failedNamespaces: string[];
  /** Whether the namespace listing call succeeded */
  namespaceListSucceeded: boolean;
  /** Cycle duration in milliseconds */
  durationMs: number;
}
