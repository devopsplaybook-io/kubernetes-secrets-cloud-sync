import { Config } from "./Config";
import { KubernetesClient } from "./KubernetesClient";
import { instanceIdForPrefix } from "./SecretName";

// Mock @kubernetes/client-node
const mockListNamespace = jest.fn();
const mockGetNamespacedSecret = jest.fn();
const mockCreateNamespacedSecret = jest.fn();
const mockPatchNamespacedSecret = jest.fn();
const mockListSecretForAllNamespaces = jest.fn();
const mockDeleteNamespacedSecret = jest.fn();

jest.mock("@kubernetes/client-node", () => {
  class MockKubeConfig {
    loadFromDefault() {
      // no-op
    }
    makeApiClient() {
      return {
        listNamespace: (...args: unknown[]) => mockListNamespace(...args),
        getNamespacedSecret: (...args: unknown[]) =>
          mockGetNamespacedSecret(...args),
        createNamespacedSecret: (...args: unknown[]) =>
          mockCreateNamespacedSecret(...args),
        patchNamespacedSecret: (...args: unknown[]) =>
          mockPatchNamespacedSecret(...args),
        listSecretForAllNamespaces: (...args: unknown[]) =>
          mockListSecretForAllNamespaces(...args),
        deleteNamespacedSecret: (...args: unknown[]) =>
          mockDeleteNamespacedSecret(...args),
      };
    }
  }
  return { KubeConfig: MockKubeConfig, CoreV1Api: {} };
});

const NOT_FOUND = Object.assign(new Error("Not Found"), { code: 404 });
const CONFLICT = Object.assign(new Error("Conflict"), { code: 409 });
const MANAGED_LABELS = {
  "app.kubernetes.io/managed-by": "kubernetes-secrets-cloud-sync",
};

function managedSecret(
  extra: {
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  } = {},
) {
  return {
    metadata: {
      name: "cloudsync-my-secret",
      namespace: "default",
      labels: { ...MANAGED_LABELS, ...extra.labels },
      annotations: extra.annotations ?? {},
    },
    type: "Opaque",
    data: {},
  };
}

describe("KubernetesClient", () => {
  let config: Config;
  let client: KubernetesClient;

  beforeEach(() => {
    jest.clearAllMocks();
    config = new Config();
    client = new KubernetesClient(config);
  });

  describe("getNamespaceSyncRequests", () => {
    it("should return empty array when no namespaces have annotations", async () => {
      mockListNamespace.mockResolvedValue({
        items: [
          { metadata: { name: "default", annotations: {} } },
          { metadata: { name: "kube-system", annotations: {} } },
        ],
      });

      const result = await client.getNamespaceSyncRequests();
      expect(result).toEqual([]);
    });

    it("should return sync requests for namespaces with matching annotations", async () => {
      mockListNamespace.mockResolvedValue({
        items: [
          {
            metadata: {
              name: "default",
              annotations: {
                "secrets.cloudsync.devopsplaybook.io/alibaba-kms":
                  "secret-a,secret-b",
              },
            },
          },
          {
            metadata: {
              name: "production",
              annotations: {
                "secrets.cloudsync.devopsplaybook.io/aws-secretsmanager":
                  "prod-db-pass",
              },
            },
          },
        ],
      });

      const result = await client.getNamespaceSyncRequests();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        namespace: "default",
        annotations: [
          { provider: "alibaba-kms", secretNames: ["secret-a", "secret-b"] },
        ],
      });
      expect(result[1]).toEqual({
        namespace: "production",
        annotations: [
          { provider: "aws-secretsmanager", secretNames: ["prod-db-pass"] },
        ],
      });
    });

    it("should skip annotations that do not match the prefix", async () => {
      mockListNamespace.mockResolvedValue({
        items: [
          {
            metadata: {
              name: "test",
              annotations: {
                "some-other-prefix/foo": "bar",
                "secrets.cloudsync.devopsplaybook.io/alibaba-kms": "my-secret",
              },
            },
          },
        ],
      });

      const result = await client.getNamespaceSyncRequests();
      expect(result).toHaveLength(1);
      expect(result[0].annotations).toHaveLength(1);
      expect(result[0].annotations[0].provider).toBe("alibaba-kms");
    });

    it("should skip namespaces without any annotations", async () => {
      mockListNamespace.mockResolvedValue({
        items: [{ metadata: { name: "default" } }],
      });

      const result = await client.getNamespaceSyncRequests();
      expect(result).toEqual([]);
    });

    it("should skip namespaces without a name", async () => {
      mockListNamespace.mockResolvedValue({
        items: [{ metadata: { annotations: {} } }],
      });

      const result = await client.getNamespaceSyncRequests();
      expect(result).toEqual([]);
    });

    it("should handle empty secret names in annotation values", async () => {
      mockListNamespace.mockResolvedValue({
        items: [
          {
            metadata: {
              name: "test",
              annotations: {
                "secrets.cloudsync.devopsplaybook.io/alibaba-kms": "",
              },
            },
          },
        ],
      });

      const result = await client.getNamespaceSyncRequests();
      expect(result).toHaveLength(0);
    });

    it("should parse multiple providers on the same namespace", async () => {
      mockListNamespace.mockResolvedValue({
        items: [
          {
            metadata: {
              name: "multi-provider",
              annotations: {
                "secrets.cloudsync.devopsplaybook.io/alibaba-kms": "secret1",
                "secrets.cloudsync.devopsplaybook.io/aws-secretsmanager":
                  "secret2",
              },
            },
          },
        ],
      });

      const result = await client.getNamespaceSyncRequests();
      expect(result).toHaveLength(1);
      expect(result[0].annotations).toHaveLength(2);
      expect(result[0].annotations[0].provider).toBe("alibaba-kms");
      expect(result[0].annotations[1].provider).toBe("aws-secretsmanager");
    });
  });

  describe("upsertSecret", () => {
    it("creates a normalized secret with source-name annotation and labels", async () => {
      mockGetNamespacedSecret.mockRejectedValue(NOT_FOUND);
      mockCreateNamespacedSecret.mockResolvedValue({});

      await client.upsertSecret("default", "prod/my-app/database", {
        username: "admin",
        password: "s3cret",
      });

      expect(mockGetNamespacedSecret).toHaveBeenCalledWith({
        name: "cloudsync-prod-my-app-database",
        namespace: "default",
      });
      expect(mockCreateNamespacedSecret).toHaveBeenCalledWith({
        namespace: "default",
        body: expect.objectContaining({
          apiVersion: "v1",
          kind: "Secret",
          metadata: expect.objectContaining({
            name: "cloudsync-prod-my-app-database",
            labels: {
              "app.kubernetes.io/managed-by": "kubernetes-secrets-cloud-sync",
              "cloudsync.devopsplaybook.io/instance": client.instanceId,
            },
            annotations: {
              "cloudsync.devopsplaybook.io/source-name":
                "prod/my-app/database",
            },
          }),
          type: "Opaque",
          data: {
            username: Buffer.from("admin").toString("base64"),
            password: Buffer.from("s3cret").toString("base64"),
          },
        }),
      });
    });

    it("sets the secret-name label when the source name is a valid label value", async () => {
      mockGetNamespacedSecret.mockRejectedValue(NOT_FOUND);
      mockCreateNamespacedSecret.mockResolvedValue({});

      await client.upsertSecret("default", "my-secret", { key: "value" });

      expect(mockCreateNamespacedSecret).toHaveBeenCalledWith({
        namespace: "default",
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: "cloudsync-my-secret",
            labels: expect.objectContaining({
              "cloudsync.devopsplaybook.io/secret-name": "my-secret",
            }),
          }),
        }),
      });
    });

    it("updates a managed secret with a JSON Patch preserving foreign metadata", async () => {
      mockGetNamespacedSecret.mockResolvedValue({
        metadata: {
          name: "cloudsync-my-secret",
          namespace: "default",
          labels: { ...MANAGED_LABELS, "foreign-label": "keep-me" },
          annotations: { "foreign-annotation": "keep-me-too" },
        },
        type: "Opaque",
        data: {},
      });
      mockPatchNamespacedSecret.mockResolvedValue({});

      await client.upsertSecret("default", "my-secret", { key: "new-value" });

      expect(mockCreateNamespacedSecret).not.toHaveBeenCalled();
      expect(mockPatchNamespacedSecret).toHaveBeenCalledWith({
        name: "cloudsync-my-secret",
        namespace: "default",
        fieldManager: "kubernetes-secrets-cloud-sync",
        body: [
          {
            op: "add",
            path: "/metadata/labels",
            value: {
              "app.kubernetes.io/managed-by": "kubernetes-secrets-cloud-sync",
              "cloudsync.devopsplaybook.io/instance": client.instanceId,
              "cloudsync.devopsplaybook.io/secret-name": "my-secret",
              "foreign-label": "keep-me",
            },
          },
          {
            op: "add",
            path: "/metadata/annotations",
            value: {
              "cloudsync.devopsplaybook.io/source-name": "my-secret",
              "foreign-annotation": "keep-me-too",
            },
          },
          {
            op: "add",
            path: "/data",
            value: { key: Buffer.from("new-value").toString("base64") },
          },
        ],
      });
    });

    it("removes a stale secret-name label when the source name is not a valid label value", async () => {
      mockGetNamespacedSecret.mockResolvedValue({
        metadata: {
          name: "cloudsync-prod-my-app-database",
          namespace: "default",
          labels: {
            ...MANAGED_LABELS,
            "cloudsync.devopsplaybook.io/secret-name": "stale",
            "foreign-label": "keep-me",
          },
          annotations: {},
        },
      });
      mockPatchNamespacedSecret.mockResolvedValue({});

      await client.upsertSecret("default", "prod/my-app/database", {
        key: "value",
      });

      const labels = mockPatchNamespacedSecret.mock.calls[0][0].body[0].value;
      expect(labels).not.toHaveProperty(
        "cloudsync.devopsplaybook.io/secret-name",
      );
      expect(labels["foreign-label"]).toBe("keep-me");
    });

    it("refuses to overwrite an unmanaged secret", async () => {
      mockGetNamespacedSecret.mockResolvedValue({
        metadata: {
          name: "cloudsync-my-secret",
          namespace: "default",
          labels: { "app.kubernetes.io/managed-by": "helm" },
          annotations: {},
        },
      });

      await expect(
        client.upsertSecret("default", "my-secret", { key: "value" }),
      ).rejects.toThrow(
        'Refusing to overwrite unmanaged Secret "default/cloudsync-my-secret" for cloud secret "my-secret"',
      );

      expect(mockPatchNamespacedSecret).not.toHaveBeenCalled();
      expect(mockCreateNamespacedSecret).not.toHaveBeenCalled();
    });

    it("adopts a secret carrying the adoption annotation", async () => {
      mockGetNamespacedSecret.mockResolvedValue({
        metadata: {
          name: "cloudsync-my-secret",
          namespace: "default",
          labels: { "app.kubernetes.io/managed-by": "helm" },
          annotations: { "cloudsync.devopsplaybook.io/adopt": "true" },
        },
      });
      mockPatchNamespacedSecret.mockResolvedValue({});

      await client.upsertSecret("default", "my-secret", { key: "value" });

      expect(mockPatchNamespacedSecret).toHaveBeenCalledTimes(1);
      const labels = mockPatchNamespacedSecret.mock.calls[0][0].body[0].value;
      expect(labels["app.kubernetes.io/managed-by"]).toBe(
        "kubernetes-secrets-cloud-sync",
      );
    });

    it("re-reads and patches when a concurrent create returns 409", async () => {
      mockGetNamespacedSecret
        .mockRejectedValueOnce(NOT_FOUND)
        .mockResolvedValueOnce(managedSecret());
      mockCreateNamespacedSecret.mockRejectedValueOnce(CONFLICT);
      mockPatchNamespacedSecret.mockResolvedValue({});

      await client.upsertSecret("default", "my-secret", { key: "value" });

      expect(mockGetNamespacedSecret).toHaveBeenCalledTimes(2);
      expect(mockCreateNamespacedSecret).toHaveBeenCalledTimes(1);
      expect(mockPatchNamespacedSecret).toHaveBeenCalledTimes(1);
    });

    it("retries a conflicting patch once with fresh metadata", async () => {
      mockGetNamespacedSecret.mockResolvedValue(managedSecret());
      mockPatchNamespacedSecret
        .mockRejectedValueOnce(CONFLICT)
        .mockResolvedValueOnce({});

      await client.upsertSecret("default", "my-secret", { key: "value" });

      expect(mockPatchNamespacedSecret).toHaveBeenCalledTimes(2);
    });

    it("throws when the patch keeps conflicting", async () => {
      mockGetNamespacedSecret.mockResolvedValue(managedSecret());
      mockPatchNamespacedSecret.mockRejectedValue(CONFLICT);

      await expect(
        client.upsertSecret("default", "my-secret", { key: "value" }),
      ).rejects.toThrow("Conflict");
      expect(mockPatchNamespacedSecret).toHaveBeenCalledTimes(2);
    });

    it("recreates the secret when the patch returns 404", async () => {
      mockGetNamespacedSecret.mockResolvedValue(managedSecret());
      mockPatchNamespacedSecret.mockRejectedValue(NOT_FOUND);
      mockCreateNamespacedSecret.mockResolvedValue({});

      await client.upsertSecret("default", "my-secret", { key: "value" });

      expect(mockCreateNamespacedSecret).toHaveBeenCalledWith({
        namespace: "default",
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: "cloudsync-my-secret" }),
        }),
      });
    });

    it("propagates non-404 errors from the initial GET", async () => {
      mockGetNamespacedSecret.mockRejectedValue(
        Object.assign(new Error("Forbidden"), { code: 403 }),
      );

      await expect(
        client.upsertSecret("default", "my-secret", { key: "value" }),
      ).rejects.toThrow("Forbidden");
      expect(mockCreateNamespacedSecret).not.toHaveBeenCalled();
      expect(mockPatchNamespacedSecret).not.toHaveBeenCalled();
    });
  });

  describe("listManagedSecrets", () => {
    it("queries with the managed-by and instance label selector", async () => {
      mockListSecretForAllNamespaces.mockResolvedValue({ items: [] });

      await client.listManagedSecrets();

      expect(mockListSecretForAllNamespaces).toHaveBeenCalledWith({
        labelSelector: `app.kubernetes.io/managed-by=kubernetes-secrets-cloud-sync,cloudsync.devopsplaybook.io/instance=${instanceIdForPrefix(config.ANNOTATION_PREFIX)}`,
      });
    });

    it("returns managed secrets with their source name", async () => {
      mockListSecretForAllNamespaces.mockResolvedValue({
        items: [
          {
            metadata: {
              namespace: "default",
              name: "cloudsync-secret-a",
              annotations: {
                "cloudsync.devopsplaybook.io/source-name": "prod/secret-a",
              },
            },
          },
          {
            metadata: {
              namespace: "production",
              name: "cloudsync-secret-b",
            },
          },
        ],
      });

      const result = await client.listManagedSecrets();
      expect(result).toEqual([
        {
          namespace: "default",
          name: "cloudsync-secret-a",
          sourceName: "prod/secret-a",
        },
        {
          namespace: "production",
          name: "cloudsync-secret-b",
          sourceName: undefined,
        },
      ]);
    });

    it("filters out secrets without namespace or name", async () => {
      mockListSecretForAllNamespaces.mockResolvedValue({
        items: [
          { metadata: { namespace: "default", name: "valid-secret" } },
          { metadata: {} },
          { metadata: { namespace: "", name: "" } },
        ],
      });

      const result = await client.listManagedSecrets();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        namespace: "default",
        name: "valid-secret",
        sourceName: undefined,
      });
    });
  });

  describe("deleteSecret", () => {
    it("should delete the specified secret", async () => {
      mockDeleteNamespacedSecret.mockResolvedValue({});

      await client.deleteSecret("default", "cloudsync-old-secret");

      expect(mockDeleteNamespacedSecret).toHaveBeenCalledWith({
        namespace: "default",
        name: "cloudsync-old-secret",
      });
    });

    it("should handle 404 gracefully when secret is already gone", async () => {
      mockDeleteNamespacedSecret.mockRejectedValue(NOT_FOUND);

      await expect(
        client.deleteSecret("default", "already-deleted"),
      ).resolves.toBeUndefined();
    });

    it("should throw if delete fails with non-404 error", async () => {
      mockDeleteNamespacedSecret.mockRejectedValue(
        Object.assign(new Error("Forbidden"), { code: 403 }),
      );

      await expect(
        client.deleteSecret("default", "no-permission"),
      ).rejects.toThrow("Forbidden");
    });
  });
});
