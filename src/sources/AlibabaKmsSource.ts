import Kms20160120, { GetSecretValueRequest } from "@alicloud/kms20160120";
import { Config as OpenApiConfig } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";
import { BaseSecretSource } from "./SecretSource";
import { Config } from "../Config";
import { OTelLogger } from "../OTelContext";
import { SecretFetchResult } from "../types";

const logger = OTelLogger().createModuleLogger("alibaba-kms-source");

const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 200;
const RETRYABLE_NETWORK_CODES = [
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EPIPE",
];
const RETRYABLE_HTTP_STATUS = [429, 500, 502, 503, 504];
const RETRYABLE_MESSAGE_HINTS = [
  "throttling",
  "serviceunavailable",
  "internalerror",
  "timeout",
];

/**
 * Alibaba Cloud KMS secret source implementation.
 *
 * Fetches secrets from Alibaba Cloud KMS using the GetSecretValue API.
 * Text secrets are expected to be a JSON object with key-value pairs.
 * Binary secrets (`secretDataType=binary`) are surfaced, base64-encoded, under
 * the `binary` data key. Transient failures are retried a bounded number of
 * times with exponential backoff and jitter.
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
    const response = await this.callWithRetry(request, runtime, secretName);

    if (!response.body?.secretData) {
      throw new Error(`No secret data returned for secret: ${secretName}`);
    }

    if (response.body.secretDataType?.toLowerCase() === "binary") {
      // Alibaba returns binary secret data base64-encoded; keep it as-is.
      logger.info(`Secret fetched: ${secretName} (binary payload)`);
      return this.buildResult(secretName, { binary: response.body.secretData });
    }

    // Parse the JSON secret data
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(response.body.secretData) as Record<string, unknown>;
    } catch (err) {
      const error = new Error(
        `Secret ${secretName} data is not valid JSON: ${err}`,
      );
      (error as Error & { cause?: unknown }).cause = err;
      throw error;
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Secret ${secretName} data must be a JSON object`);
    }
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

  private async callWithRetry(
    request: GetSecretValueRequest,
    runtime: RuntimeOptions,
    secretName: string,
  ): Promise<Awaited<ReturnType<Kms20160120["getSecretValueWithOptions"]>>> {
    const client = this.client;
    if (!client) {
      throw new Error("Alibaba KMS client not initialized");
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.getSecretValueWithOptions(request, runtime);
      } catch (error: unknown) {
        if (attempt >= MAX_ATTEMPTS || !this.isRetryable(error)) {
          throw error;
        }
        const delay = Math.round(
          BASE_RETRY_DELAY_MS *
            Math.pow(2, attempt - 1) *
            (0.5 + Math.random() / 2),
        );
        logger.warn(
          `Transient Alibaba KMS error for secret ${secretName} (${this.describeError(error)}); retry ${attempt + 1}/${MAX_ATTEMPTS} in ${delay}ms`,
        );
        await this.sleep(delay);
      }
    }
  }

  private isRetryable(error: unknown): boolean {
    const err = error as {
      code?: string | number;
      statusCode?: number;
      message?: string;
      response?: { statusCode?: number };
    };
    const code = typeof err?.code === "string" ? err.code : "";
    const statusCode =
      (typeof err?.statusCode === "number" ? err.statusCode : undefined) ??
      (typeof err?.code === "number" ? err.code : undefined) ??
      err?.response?.statusCode;

    if (statusCode !== undefined && RETRYABLE_HTTP_STATUS.includes(statusCode)) {
      return true;
    }
    if (RETRYABLE_NETWORK_CODES.includes(code.toUpperCase())) {
      return true;
    }
    const text = `${code} ${err?.message ?? ""}`.toLowerCase();
    return RETRYABLE_MESSAGE_HINTS.some((hint) => text.includes(hint));
  }

  private describeError(error: unknown): string {
    const err = error as {
      code?: string | number;
      statusCode?: number;
      message?: string;
    };
    return String(
      err?.code ?? err?.statusCode ?? err?.message ?? "unknown error",
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
