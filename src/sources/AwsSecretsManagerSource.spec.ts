import { AwsSecretsManagerSource } from "./AwsSecretsManagerSource";
import { Config } from "../Config";

describe("AwsSecretsManagerSource", () => {
  let config: Config;
  let source: AwsSecretsManagerSource;
  let mockSend: jest.Mock;

  beforeEach(() => {
    config = new Config();
    config.AWS_SECRETSMANAGER_REGION = "eu-west-1";
    source = new AwsSecretsManagerSource(config);
    mockSend = jest.fn();
    (source as unknown as { client: unknown }).client = { send: mockSend };
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

  it("is available only when a region is configured", () => {
    expect(source.isAvailable()).toBe(true);
    config.AWS_SECRETSMANAGER_REGION = "";
    expect(source.isAvailable()).toBe(false);
  });
});
