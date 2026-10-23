import { SecretData, SecretFetchResult } from "../types";

/** Kubernetes Secret data keys must match this pattern. */
export const K8S_SECRET_KEY_PATTERN = /^[-._a-zA-Z0-9]+$/;
/** Kubernetes Secrets are limited to 1 MiB of data. */
export const MAX_SECRET_DATA_BYTES = 1024 * 1024;

/**
 * Generic interface for cloud secret providers.
 * Implementations fetch secrets from specific cloud KMS/vault services.
 */
export interface SecretSource {
  /**
   * The provider identifier used in namespace annotations.
   * For example: "alibaba-kms", "aws-secretsmanager", "azure-keyvault"
   */
  readonly providerName: string;

  /**
   * Initialize the secret source (e.g., authenticate with the cloud provider).
   * Called once at startup.
   */
  init(): Promise<void>;

  /**
   * Fetch a secret by name from the cloud provider.
   * @param secretName - The name/identifier of the secret in the cloud provider
   * @returns The secret data as key-value pairs
   */
  fetchSecret(secretName: string): Promise<SecretFetchResult>;

  /**
   * Check if the secret source is properly configured and available.
   * @returns true if the source is ready to fetch secrets
   */
  isAvailable(): boolean;
}

/**
 * Abstract base class providing common functionality for secret sources.
 */
export abstract class BaseSecretSource implements SecretSource {
  abstract readonly providerName: string;

  abstract init(): Promise<void>;
  abstract fetchSecret(secretName: string): Promise<SecretFetchResult>;
  abstract isAvailable(): boolean;

  /**
   * Validate and normalize secret data into Kubernetes Secret entries.
   *
   * Scalar values (string/number/boolean) are stringified. `null`/`undefined`
   * values are skipped. Nested objects and arrays are rejected: converting
   * them implicitly would store `[object Object]` or a comma-joined list.
   * Invalid keys and payloads above the 1 MiB Secret limit fail the secret.
   */
  protected validateSecretData(
    secretName: string,
    raw: Record<string, unknown>,
  ): SecretData {
    const data: SecretData = {};
    const invalidKeys: string[] = [];
    const nonScalarKeys: string[] = [];

    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === undefined) {
        continue;
      }
      if (!K8S_SECRET_KEY_PATTERN.test(key)) {
        invalidKeys.push(key);
        continue;
      }
      if (typeof value === "object") {
        nonScalarKeys.push(key);
        continue;
      }
      data[key] = String(value);
    }

    if (invalidKeys.length > 0) {
      throw new Error(
        `Secret "${secretName}" has invalid Kubernetes data key(s): ${invalidKeys.join(", ")}. Keys must match [-._a-zA-Z0-9]+`,
      );
    }
    if (nonScalarKeys.length > 0) {
      throw new Error(
        `Secret "${secretName}" has non-scalar value(s) for key(s): ${nonScalarKeys.join(", ")}; nested objects/arrays are not supported, store JSON as a string`,
      );
    }

    const encodedBytes = Object.entries(data).reduce(
      (total, [key, value]) =>
        total +
        Buffer.byteLength(key) +
        Math.ceil(Buffer.byteLength(value) / 3) * 4,
      0,
    );
    if (encodedBytes > MAX_SECRET_DATA_BYTES) {
      throw new Error(
        `Secret "${secretName}" exceeds the 1 MiB Kubernetes Secret limit (~${encodedBytes} bytes after base64 encoding)`,
      );
    }

    return data;
  }

  /**
   * Build a SecretFetchResult from raw secret data.
   */
  protected buildResult(
    secretName: string,
    raw: Record<string, unknown>,
  ): SecretFetchResult {
    return {
      provider: this.providerName,
      secretName,
      data: this.validateSecretData(secretName, raw),
    };
  }
}
