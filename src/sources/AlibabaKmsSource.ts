import Kms20160120, { GetSecretValueRequest } from "@alicloud/kms20160120";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";
import { BaseSecretSource } from "./SecretSource";
import { Config } from "../Config";
import { OTelLogger } from "../OTelContext";
import { SecretFetchResult } from "../types";

const logger = OTelLogger().createModuleLogger("alibaba-kms-source");

/**
 * Alibaba Cloud KMS secret source implementation.
 *
 * Fetches secrets from Alibaba Cloud KMS using the GetSecretValue API.
 * The secret payload is expected to be a JSON object with string key-value pairs.
 *
 * Annotation key: secrets.cloudsync.devopsplaybook.io/alibaba-kms
 * Annotation value: comma-separated list of KMS secret names
 */
export class AlibabaKmsSource extends BaseSecretSource {
  readonly providerName = "alibaba-kms";
  private client: Kms20160120 | null = null;
  private readonly config: Config;

  constructor(config: Config) {
    super();
    this.config = config;
  }

  async init(): Promise<void> {
    if (!this.isAvailable()) {
      logger.warn(
        "Alibaba KMS source not configured. Required: ALIBABA_KMS_REGION, ALIBABA_KMS_ACCESS_KEY_ID, ALIBABA_KMS_ACCESS_KEY_SECRET",
      );
      return;
    }

    const openApiConfig = new OpenApiConfig({
      accessKeyId: this.config.ALIBABA_KMS_ACCESS_KEY_ID,
      accessKeySecret: this.config.ALIBABA_KMS_ACCESS_KEY_SECRET,
      regionId: this.config.ALIBABA_KMS_REGION,
      endpoint: `kms.${this.config.ALIBABA_KMS_REGION}.aliyuncs.com`,
    });

    this.client = new Kms20160120(openApiConfig);
    logger.info(
      `Alibaba KMS client initialized (region: ${this.config.ALIBABA_KMS_REGION})`,
    );
  }

  async fetchSecret(secretName: string): Promise<SecretFetchResult> {
    if (!this.client) {
      throw new Error("Alibaba KMS client not initialized");
    }

    const request = new GetSecretValueRequest({
      secretName,
    });

    const runtime = new RuntimeOptions({
      readTimeout: 10000,
      connectTimeout: 10000,
    });

    logger.info(`Fetching secret: ${secretName}`);
    const response = await this.client.getSecretValueWithOptions(
      request,
      runtime,
    );

    if (!response.body?.secretData) {
      throw new Error(`No secret data returned for secret: ${secretName}`);
    }

    // Parse the JSON secret data
    const raw = JSON.parse(response.body.secretData) as Record<string, unknown>;
    logger.info(
      `Secret fetched: ${secretName} (${Object.keys(raw).length} keys)`,
    );

    return this.buildResult(secretName, raw);
  }

  isAvailable(): boolean {
    return !!(
      this.config.ALIBABA_KMS_REGION &&
      this.config.ALIBABA_KMS_ACCESS_KEY_ID &&
      this.config.ALIBABA_KMS_ACCESS_KEY_SECRET
    );
  }
}
