import { SecretData, SecretFetchResult } from "../types";

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
   * Validate that the secret data is a valid JSON object with string values.
   * Converts non-string values to strings if needed.
   */
  protected validateSecretData(
    secretName: string,
    raw: Record<string, unknown>,
  ): SecretData {
    const data: SecretData = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === undefined) {
        continue;
      }
      data[key] = String(value);
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
