import { AwsSecretsManagerSource } from "./AwsSecretsManagerSource";
import { Config } from "../Config";

let mockSend = jest.fn();
const mockClientConstructor = jest.fn();

jest.mock("@aws-sdk/client-secrets-manager", () => {
  class SecretsManagerClient {
    constructor(config: unknown) {
      mockClientConstructor(config);
    }
    send(...args: unknown[]) {
      return mockSend(...args);
    }
  }
  class GetSecretValueCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { SecretsManagerClient, GetSecretValueCommand };
});

const {
  SecretsManagerClient: MockSecretsManagerClient,
  GetSecretValueCommand: MockGetSecretValueCommand,
} = jest.requireMock("@aws-sdk/client-secrets-manager") as {
  SecretsManagerClient: new (config: unknown) => unknown;
  GetSecretValueCommand: new (input: unknown) => { input: unknown };
};

describe("AwsSecretsManagerSource", () => {
  let config: Config;
  let source: AwsSecretsManagerSource;

  beforeEach(() => {
    config = new Config();
    config.AWS_SECRETSMANAGER_REGION = "eu-west-1";
    config.AWS_SECRETSMANAGER_ACCESS_KEY_ID = "";
    config.AWS_SECRETSMANAGER_SECRET_ACCESS_KEY = "";
    source = new AwsSecretsManagerSource(config);
    mockSend = jest.fn();
    (source as unknown as { client: unknown }).client = { send: mockSend };
    mockClientConstructor.mockClear();
  });

  describe("init", () => {
    it("constructs the client with the region and the default credential chain", async () => {
      await source.init();

      expect(mockClientConstructor).toHaveBeenCalledWith({
        region: "eu-west-1",
      });
    });

    it("passes static credentials when configured", async () => {
      config.AWS_SECRETSMANAGER_ACCESS_KEY_ID = "access-key";
      config.AWS_SECRETSMANAGER_SECRET_ACCESS_KEY = "secret-key";

      await source.init();

      expect(mockClientConstructor).toHaveBeenCalledWith({
        region: "eu-west-1",
        credentials: {
          accessKeyId: "access-key",
          secretAccessKey: "secret-key",
        },
      });
    });

    it("stores the constructed client", async () => {
      const fresh = new AwsSecretsManagerSource(config);

      await fresh.init();

      expect((fresh as unknown as { client: unknown }).client).toBeInstanceOf(
        MockSecretsManagerClient,
      );
    });

    it("logs a warning and constructs no client when unconfigured", async () => {
      config.AWS_SECRETSMANAGER_REGION = "";

      await source.init();

      expect(mockClientConstructor).not.toHaveBeenCalled();
    });
  });

  it("parses a JSON object SecretString", async () => {
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({ username: "admin", password: "s3cret" }),
    });

    const result = await source.fetchSecret("prod/my-app/database");

    expect(result).toEqual({
      provider: "aws-secretsmanager",
      secretName: "prod/my-app/database",
      data: { username: "admin", password: "s3cret" },
    });
  });

  it("stores a non-JSON SecretString under the value key", async () => {
    mockSend.mockResolvedValue({ SecretString: "just-a-plain-value" });

    const result = await source.fetchSecret("plain");

    expect(result.data).toEqual({ value: "just-a-plain-value" });
  });

  it("stores a JSON array SecretString under the value key", async () => {
    mockSend.mockResolvedValue({ SecretString: "[1,2,3]" });

    const result = await source.fetchSecret("array");

    expect(result.data).toEqual({ value: "[1,2,3]" });
  });

  it("rejects a nested object payload", async () => {
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({ a: { b: 1 } }),
    });

    await expect(source.fetchSecret("nested")).rejects.toThrow("non-scalar");
  });

  it("surfaces SecretBinary as base64 under the binary key", async () => {
    const binary = new Uint8Array([0x00, 0xff, 0x10, 0x20]);
    mockSend.mockResolvedValue({ SecretBinary: binary });

    const result = await source.fetchSecret("binary-secret");

    expect(result.data).toEqual({
      binary: Buffer.from(binary).toString("base64"),
    });
  });

  it("throws when no secret data is returned", async () => {
    mockSend.mockResolvedValue({});

    await expect(source.fetchSecret("empty")).rejects.toThrow(
      "No secret data returned for secret: empty",
    );
  });

  it("propagates SDK errors from send", async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error("AccessDeniedException"), {
        name: "AccessDeniedException",
      }),
    );

    await expect(source.fetchSecret("denied")).rejects.toThrow(
      "AccessDeniedException",
    );
  });

  it("throws when the client is not initialized", async () => {
    const uninitialized = new AwsSecretsManagerSource(config);

    await expect(uninitialized.fetchSecret("any")).rejects.toThrow(
      "AWS Secrets Manager client not initialized",
    );
  });

  it("sends a GetSecretValueCommand with the secret id", async () => {
    mockSend.mockResolvedValue({ SecretString: '{"k":"v"}' });

    await source.fetchSecret("my-secret");

    const command = mockSend.mock.calls[0][0] as { input: unknown };
    expect(command.input).toEqual({ SecretId: "my-secret" });
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(MockGetSecretValueCommand);
  });

  it("is available only when a region is configured", () => {
    expect(source.isAvailable()).toBe(true);
    config.AWS_SECRETSMANAGER_REGION = "";
    expect(source.isAvailable()).toBe(false);
  });
});
