import { BaseSecretSource } from "./sources/SecretSource";
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

  validate(secretName: string, raw: Record<string, unknown>) {
    return this.validateSecretData(secretName, raw);
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
      expect(source.validate("test", raw)).toEqual({ a: "hello", d: "world" });
    });

    it("should convert non-string scalar values to strings", () => {
      const raw = {
        num: 123,
        bool: true,
      };
      expect(source.validate("test", raw)).toEqual({
        num: "123",
        bool: "true",
      });
    });

    it("should handle empty input", () => {
      expect(source.validate("test", {})).toEqual({});
    });

    it("rejects nested objects naming the offending keys", () => {
      expect(() =>
        source.validate("test", {
          nested: { a: 1 },
          other: { b: 2 },
        }),
      ).toThrow(
        'Secret "test" has non-scalar value(s) for key(s): nested, other; nested objects/arrays are not supported, store JSON as a string',
      );
    });

    it("rejects arrays naming the offending keys", () => {
      expect(() =>
        source.validate("test", { list: ["a", "b"] }),
      ).toThrow('Secret "test" has non-scalar value(s) for key(s): list');
    });

    it("rejects invalid Kubernetes data keys", () => {
      expect(() =>
        source.validate("test", { "a/b": "x", "a b": "y", "": "z" }),
      ).toThrow(
        'Secret "test" has invalid Kubernetes data key(s): a/b, a b, . Keys must match [-._a-zA-Z0-9]+',
      );
    });

    it("accepts keys made of the allowed characters", () => {
      expect(
        source.validate("test", {
          "key-1": "a",
          "key_2": "b",
          "key.3": "c",
          KEY4: "d",
        }),
      ).toEqual({ "key-1": "a", "key_2": "b", "key.3": "c", KEY4: "d" });
    });

    it("rejects payloads above the 1 MiB Secret limit", () => {
      expect(() =>
        source.validate("test", { big: "a".repeat(800_000) }),
      ).toThrow(
        'Secret "test" exceeds the 1 MiB Kubernetes Secret limit',
      );
    });

    it("accepts payloads below the 1 MiB Secret limit", () => {
      const result = source.validate("test", { big: "a".repeat(700_000) });
      expect(result.big).toHaveLength(700_000);
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
