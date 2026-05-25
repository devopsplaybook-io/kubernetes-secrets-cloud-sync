import { BaseSecretSource } from "./SecretSource";
import { SecretFetchResult } from "./types";

class TestSecretSource extends BaseSecretSource {
  readonly providerName = "test-provider";

  async init(): Promise<void> {
    // no-op for testing
  }

  async fetchSecret(secretName: string): Promise<SecretFetchResult> {
    return this.buildResult(secretName, { key1: "value1" });
  }

  isAvailable(): boolean {
    return true;
  }
}

describe("BaseSecretSource", () => {
  let source: TestSecretSource;

  beforeEach(() => {
    source = new TestSecretSource();
  });

  describe("validateSecretData", () => {
    it("should filter out null and undefined values", () => {
      const raw = {
        a: "hello",
        b: null,
        c: undefined,
        d: "world",
      };
      const result = (source as unknown as { validateSecretData(secretName: string, raw: Record<string, unknown>): Record<string, string> }).validateSecretData("test", raw);
      expect(result).toEqual({ a: "hello", d: "world" });
    });

    it("should convert non-string values to strings", () => {
      const raw = {
        num: 123,
        bool: true,
      };
      const result = (source as unknown as { validateSecretData(secretName: string, raw: Record<string, unknown>): Record<string, string> }).validateSecretData("test", raw);
      expect(result).toEqual({
        num: "123",
        bool: "true",
      });
    });

    it("should handle empty input", () => {
      const result = (source as unknown as { validateSecretData(secretName: string, raw: Record<string, unknown>): Record<string, string> }).validateSecretData("test", {});
      expect(result).toEqual({});
    });
  });

  describe("buildResult", () => {
    it("should build a SecretFetchResult with provider name and valid data", async () => {
      const result = await source.fetchSecret("my-secret");
      expect(result).toEqual({
        provider: "test-provider",
        secretName: "my-secret",
        data: { key1: "value1" },
      });
    });
  });
});
