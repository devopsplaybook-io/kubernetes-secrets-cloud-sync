import { AlibabaKmsSource } from "./AlibabaKmsSource";
import { Config } from "../Config";

describe("AlibabaKmsSource", () => {
  let config: Config;
  let source: AlibabaKmsSource;
  let mockGetSecretValue: jest.Mock;
  let mockSleep: jest.SpyInstance;

  beforeEach(() => {
    config = new Config();
    config.ALIBABA_KMS_REGION = "cn-hangzhou";
    config.ALIBABA_KMS_ACCESS_KEY_ID = "key-id";
    config.ALIBABA_KMS_ACCESS_KEY_SECRET = "key-secret";
    source = new AlibabaKmsSource(config);
    mockGetSecretValue = jest.fn();
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
