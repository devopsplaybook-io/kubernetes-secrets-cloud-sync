import {
  ADOPT_ANNOTATION,
  CLOUDSYNC_DOMAIN,
  INSTANCE_LABEL,
  MAX_LABEL_VALUE_LENGTH,
  MAX_SECRET_NAME_LENGTH,
  SECRET_NAME_LABEL,
  SOURCE_NAME_ANNOTATION,
  instanceIdForPrefix,
  isValidLabelValue,
  normalizeSecretName,
} from "./SecretName";

const DNS1123_SUBDOMAIN =
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

describe("SecretName", () => {
  describe("constants", () => {
    it("uses the documented cloudsync domain", () => {
      expect(SOURCE_NAME_ANNOTATION).toBe(
        "cloudsync.devopsplaybook.io/source-name",
      );
      expect(INSTANCE_LABEL).toBe("cloudsync.devopsplaybook.io/instance");
      expect(ADOPT_ANNOTATION).toBe("cloudsync.devopsplaybook.io/adopt");
      expect(SECRET_NAME_LABEL).toBe("cloudsync.devopsplaybook.io/secret-name");
      expect(CLOUDSYNC_DOMAIN).toBe("cloudsync.devopsplaybook.io");
    });
  });

  describe("normalizeSecretName", () => {
    it("normalizes the README AWS example to a valid name", () => {
      const name = normalizeSecretName("prod/my-app/database", "cloudsync-");
      expect(name).toBe("cloudsync-prod-my-app-database");
      expect(name).toMatch(DNS1123_SUBDOMAIN);
    });

    it("normalizes the other README AWS example", () => {
      expect(normalizeSecretName("prod/my-app/api-keys", "cloudsync-")).toBe(
        "cloudsync-prod-my-app-api-keys",
      );
    });

    it("lowercases uppercase names", () => {
      expect(normalizeSecretName("PROD/My-App/DB", "cloudsync-")).toBe(
        "cloudsync-prod-my-app-db",
      );
    });

    it("maps invalid characters to dash", () => {
      expect(normalizeSecretName("my secret_v1+2=3@4", "cloudsync-")).toBe(
        "cloudsync-my-secret-v1-2-3-4",
      );
    });

    it("collapses and trims separators", () => {
      expect(normalizeSecretName("--my___secret--", "cloudsync-")).toBe(
        "cloudsync-my-secret",
      );
    });

    it("keeps dots as label separators and drops empty parts", () => {
      expect(normalizeSecretName("my..secret.", "cloudsync-")).toBe(
        "cloudsync-my.secret",
      );
    });

    it("keeps already-valid names unchanged", () => {
      expect(normalizeSecretName("my-secret", "cloudsync-")).toBe(
        "cloudsync-my-secret",
      );
      expect(normalizeSecretName("my.secret", "cloudsync-")).toBe(
        "cloudsync-my.secret",
      );
      expect(normalizeSecretName("cloudsync-my-secret", "")).toBe(
        "cloudsync-my-secret",
      );
    });

    it("supports an empty prefix", () => {
      expect(normalizeSecretName("prod/my-app/database")).toBe(
        "prod-my-app-database",
      );
    });

    it("hashes an empty or all-invalid source name", () => {
      const fromEmpty = normalizeSecretName("");
      expect(fromEmpty).toMatch(/^secret-[0-9a-f]{8}$/);
      expect(fromEmpty).toHaveLength(15);

      const fromInvalid = normalizeSecretName("///");
      expect(fromInvalid).toMatch(/^secret-[0-9a-f]{8}$/);
    });

    it("is deterministic for empty names", () => {
      expect(normalizeSecretName("")).toBe(normalizeSecretName(""));
    });

    it("truncates long names to 253 chars with a hash suffix", () => {
      const longName = "a".repeat(400);
      const name = normalizeSecretName(longName, "cloudsync-");
      expect(name.length).toBeLessThanOrEqual(MAX_SECRET_NAME_LENGTH);
      expect(name).toMatch(/-[0-9a-f]{8}$/);
      expect(name).toMatch(DNS1123_SUBDOMAIN);
      expect(normalizeSecretName(longName, "cloudsync-")).toBe(name);
    });

    it("produces different names for different long names", () => {
      const first = normalizeSecretName("a".repeat(400));
      const second = normalizeSecretName("b".repeat(400));
      expect(first).not.toBe(second);
    });

    it("produces only valid DNS-1123 subdomains", () => {
      const inputs = [
        "prod/my-app/database",
        "UPPER_CASE with spaces",
        "a+b=c@d",
        "..",
        "---",
        "x".repeat(300),
      ];
      for (const input of inputs) {
        expect(normalizeSecretName(input, "cloudsync-")).toMatch(
          DNS1123_SUBDOMAIN,
        );
      }
    });
  });

  describe("isValidLabelValue", () => {
    it("rejects names containing a slash", () => {
      expect(isValidLabelValue("prod/my-app/database")).toBe(false);
    });

    it("accepts a 63-char value and rejects 64 chars", () => {
      expect(isValidLabelValue("a".repeat(MAX_LABEL_VALUE_LENGTH))).toBe(true);
      expect(
        isValidLabelValue("a".repeat(MAX_LABEL_VALUE_LENGTH + 1)),
      ).toBe(false);
    });

    it("accepts underscores, dots and dashes inside the value", () => {
      expect(isValidLabelValue("my_app")).toBe(true);
      expect(isValidLabelValue("my.app")).toBe(true);
      expect(isValidLabelValue("my-app")).toBe(true);
    });

    it("rejects empty and boundary-separator values", () => {
      expect(isValidLabelValue("")).toBe(false);
      expect(isValidLabelValue("-start")).toBe(false);
      expect(isValidLabelValue("end-")).toBe(false);
    });
  });

  describe("instanceIdForPrefix", () => {
    it("returns an 8-char lowercase hex id", () => {
      expect(instanceIdForPrefix("secrets.cloudsync.devopsplaybook.io")).toMatch(
        /^[0-9a-f]{8}$/,
      );
    });

    it("is stable for the same prefix", () => {
      expect(instanceIdForPrefix("prefix-a")).toBe(instanceIdForPrefix("prefix-a"));
    });

    it("differs between prefixes", () => {
      expect(instanceIdForPrefix("prefix-a")).not.toBe(
        instanceIdForPrefix("prefix-b"),
      );
    });
  });
});
