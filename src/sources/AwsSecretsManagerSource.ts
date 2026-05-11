import {
  GetSecretValueCommand,
  SecretsManagerClient,
  SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";
import { BaseSecretSource } from "./SecretSource";
import { Config } from "../Config";
import { OTelLogger } from "../OTelContext";
import { SecretFetchResult } from "../types";

const logger = OTelLogger().createModuleLogger("aws-secretsmanager-source");

/**
 * AWS Secrets Manager secret source implementation.
 *
 * Fetches secrets from AWS Secrets Manager using the GetSecretValue API.
 * The secret payload is expected to be a JSON object with string key-value
 * pairs. If the payload is not valid JSON, it is stored under the `value` key.
 *
 * Annotation key: secrets.cloudsync.devopsplaybook.io/aws-secretsmanager
 * Annotation value: comma-separated list of AWS Secrets Manager secret names
 * (or ARNs).
 *
 * Credentials are resolved in the following order:
 * 1. Explicit AWS_SECRETSMANAGER_ACCESS_KEY_ID / AWS_SECRETSMANAGER_SECRET_ACCESS_KEY
 * 2. AWS SDK default credential provider chain (env vars, IRSA, instance profile, ...)
 */
export class AwsSecretsManagerSource extends BaseSecretSource {
  readonly providerName = "aws-secretsmanager";
  private client: SecretsManagerClient | null = null;
  private readonly config: Config;

  constructor(config: Config) {
    super();
    this.config = config;
  }

  async init(): Promise<void> {
    if (!this.isAvailable()) {
      logger.warn(
        "AWS Secrets Manager source not configured. Required: AWS_SECRETSMANAGER_REGION",
      );
      return;
    }

    const clientConfig: SecretsManagerClientConfig = {
      region: this.config.AWS_SECRETSMANAGER_REGION,
    };

    if (
      this.config.AWS_SECRETSMANAGER_ACCESS_KEY_ID &&
      this.config.AWS_SECRETSMANAGER_SECRET_ACCESS_KEY
    ) {
      clientConfig.credentials = {
        accessKeyId: this.config.AWS_SECRETSMANAGER_ACCESS_KEY_ID,
        secretAccessKey: this.config.AWS_SECRETSMANAGER_SECRET_ACCESS_KEY,
      };
      logger.info(
        `AWS Secrets Manager client initialized with static credentials (region: ${this.config.AWS_SECRETSMANAGER_REGION})`,
      );
    } else {
      logger.info(
        `AWS Secrets Manager client initialized with default credential chain (region: ${this.config.AWS_SECRETSMANAGER_REGION})`,
      );
    }

    this.client = new SecretsManagerClient(clientConfig);
  }

  async fetchSecret(secretName: string): Promise<SecretFetchResult> {
    if (!this.client) {
      throw new Error("AWS Secrets Manager client not initialized");
    }

    logger.info(`Fetching secret: ${secretName}`);
    const response = await this.client.send(
      new GetSecretValueCommand({ SecretId: secretName }),
    );

    let payload: string | undefined = response.SecretString;
    if (!payload && response.SecretBinary) {
      payload = Buffer.from(response.SecretBinary).toString("utf-8");
    }

    if (!payload) {
      throw new Error(`No secret data returned for secret: ${secretName}`);
    }

    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      } else {
        raw = { value: payload };
      }
    } catch {
      raw = { value: payload };
    }

    logger.info(
      `Secret fetched: ${secretName} (${Object.keys(raw).length} keys)`,
    );

    return this.buildResult(secretName, raw);
  }

  isAvailable(): boolean {
    return !!this.config.AWS_SECRETSMANAGER_REGION;
  }
}
