import { AlibabaKmsSource } from "./AlibabaKmsSource";
import { Config } from "../Config";

const mockGetSecretValue = jest.fn();
const mockClientConstructor = jest.fn();
const mockOpenApiConfig = jest.fn();

jest.mock("@alicloud/kms20160120", () => {
  class Kms20160120 {
    constructor(config: unknown) {
      mockClientConstructor(config);
    }
    getSecretValueWithOptions(...args: unknown[]) {
      return mockGetSecretValue(...args);
    }
  }
  class GetSecretValueRequest {
    secretName: string | undefined;
    constructor(props?: { secretName?: string }) {
      this.secretName = props?.secretName;
    }
  }
  return { __esModule: true, default: Kms20160120, GetSecretValueRequest };
});

jest.mock("@alicloud/openapi-client", () => ({
  Config: class {
    constructor(props?: unknown) {
      mockOpenApiConfig(props);
    }
  },
}));

jest.mock("@alicloud/tea-util", () => ({
  RuntimeOptions: class {
    constructor(public props?: unknown) {
      void this.props;
    }
  },
}));

describe("AlibabaKmsSource", () => {
  let config: Config;
  let source: AlibabaKmsSource;
  let mockSleep: jest.SpyInstance;

  beforeEach(() => {
    config = new Config();
    config.ALIBABA_KMS_REGION = "cn-hangzhou";
    config.ALIBABA_KMS_ACCESS_KEY_ID = "key-id";
    config.ALIBABA_KMS_ACCESS_KEY_SECRET = "key-secret";
    source = new AlibabaKmsSource(config);
    mockGetSecretValue.mockReset();
    mockClientConstructor.mockClear();
    (source as unknown as { client: unknown }).client = {
      getSecretValueWithOptions: mockGetSecretValue,
    };
    mockSleep = jest
      .spyOn(source as unknown as { sleep: (ms: number) => Promise<void> }, "sleep")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockSleep.mockRestore();
  });

  describe("init", () => {
    it("constructs the client with the region and endpoint", async () => {
      await source.init();

      expect(mockOpenApiConfig).toHaveBeenCalledWith({
        accessKeyId: "key-id",
        accessKeySecret: "key-secret",
        regionId: "cn-hangzhou",
        endpoint: "kms.cn-hangzhou.aliyuncs.com",
      });
      expect(mockClientConstructor).toHaveBeenCalledWith(expect.anything());
    });

    it("stores the constructed client", async () => {
      const fresh = new AlibabaKmsSource(config);
      mockGetSecretValue.mockResolvedValue({
        body: { secretDataType: "text", secretData: '{"A":"1"}' },
      });

      await fresh.init();
      const result = await fresh.fetchSecret("after-init");

      expect(result.data).toEqual({ A: "1" });
    });

    it("logs a warning and constructs no client when unconfigured", async () => {
      config.ALIBABA_KMS_ACCESS_KEY_ID = "";

      await source.init();

      expect(mockClientConstructor).not.toHaveBeenCalled();
    });
  });

  it("rejects a fetch before init", async () => {
    const uninitialized = new AlibabaKmsSource(config);

    await expect(uninitialized.fetchSecret("any")).rejects.toThrow(
      "Alibaba KMS client not initialized",
    );
  });

  it("parses a JSON text secret", async () => {
    mockGetSecretValue.mockResolvedValue({
      body: { secretDataType: "text", secretData: '{"A":"1","B":2}' },
    });

    const result = await source.fetchSecret("my-secret");

    expect(result).toEqual({
      provider: "alibaba-kms",
      secretName: "my-secret",
      data: { A: "1", B: "2" },
    });
  });

  it("rejects invalid JSON text secrets with a cause", async () => {
    mockGetSecretValue.mockResolvedValue({
      body: { secretDataType: "text", secretData: "not-json" },
    });

    const error = await source.fetchSecret("bad-json").catch((err) => err);

    expect(error.message).toContain("is not valid JSON");
    expect(error.cause).toBeDefined();
  });

  it("rejects a JSON array payload", async () => {
    mockGetSecretValue.mockResolvedValue({
      body: { secretDataType: "text", secretData: "[1,2,3]" },
    });

    await expect(source.fetchSecret("array")).rejects.toThrow(
      "must be a JSON object",
    );
  });

  it.each(["42", "null", "true", '"x"'])(
    "rejects the JSON scalar %p",
    async (secretData) => {
      mockGetSecretValue.mockResolvedValue({
        body: { secretDataType: "text", secretData },
      });

      await expect(source.fetchSecret("scalar")).rejects.toThrow(
        "must be a JSON object",
      );
    },
  );

  it("accepts an empty JSON object with zero data keys", async () => {
    mockGetSecretValue.mockResolvedValue({
      body: { secretDataType: "text", secretData: "{}" },
    });

    const result = await source.fetchSecret("empty-object");

    expect(result.data).toEqual({});
  });

  it("matches the binary data type case-insensitively and keeps the payload", async () => {
    mockGetSecretValue.mockResolvedValue({
      body: { secretDataType: "BINARY", secretData: "AAECAwQ=" },
    });

    const result = await source.fetchSecret("binary-upper");

    expect(result.data).toEqual({ binary: "AAECAwQ=" });
  });

  it("rejects a nested object payload", async () => {
    mockGetSecretValue.mockResolvedValue({
      body: { secretDataType: "text", secretData: '{"a":{"b":1}}' },
    });

    await expect(source.fetchSecret("nested")).rejects.toThrow("non-scalar");
  });

  it("surfaces binary secrets as base64 under the binary key without parsing", async () => {
    mockGetSecretValue.mockResolvedValue({
      body: { secretDataType: "binary", secretData: "AAECAwQ=" },
    });

    const result = await source.fetchSecret("binary-secret");

    expect(result).toEqual({
      provider: "alibaba-kms",
      secretName: "binary-secret",
      data: { binary: "AAECAwQ=" },
    });
  });

  it("throws when no secret data is returned", async () => {
    mockGetSecretValue.mockResolvedValue({ body: {} });

    await expect(source.fetchSecret("empty")).rejects.toThrow(
      "No secret data returned for secret: empty",
    );
  });

  it("retries transient errors and succeeds", async () => {
    mockGetSecretValue
      .mockRejectedValueOnce(
        Object.assign(new Error("Throttling.User"), { code: "Throttling.User" }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("ServiceUnavailable"), {
          code: "ServiceUnavailable",
        }),
      )
      .mockResolvedValueOnce({
        body: { secretDataType: "text", secretData: '{"A":"1"}' },
      });

    const result = await source.fetchSecret("flaky");

    expect(result.data).toEqual({ A: "1" });
    expect(mockGetSecretValue).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it("retries an HTTP-status transient error", async () => {
    mockGetSecretValue
      .mockRejectedValueOnce(
        Object.assign(new Error("service unavailable"), { statusCode: 503 }),
      )
      .mockResolvedValueOnce({
        body: { secretDataType: "text", secretData: '{"A":"1"}' },
      });

    const result = await source.fetchSecret("status-503");

    expect(result.data).toEqual({ A: "1" });
    expect(mockGetSecretValue).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-retryable errors", async () => {
    mockGetSecretValue.mockRejectedValue(
      Object.assign(new Error("Forbidden"), {
        code: "Forbidden",
        statusCode: 403,
      }),
    );

    await expect(source.fetchSecret("denied")).rejects.toThrow("Forbidden");
    expect(mockGetSecretValue).toHaveBeenCalledTimes(1);
  });

  it("throws the last error after exhausting retries", async () => {
    mockGetSecretValue.mockRejectedValue(
      Object.assign(new Error("InternalError"), { code: "InternalError" }),
    );

    await expect(source.fetchSecret("broken")).rejects.toThrow("InternalError");
    expect(mockGetSecretValue).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it("is available only when fully configured", () => {
    expect(source.isAvailable()).toBe(true);
    config.ALIBABA_KMS_ACCESS_KEY_SECRET = "";
    expect(source.isAvailable()).toBe(false);
  });
});
