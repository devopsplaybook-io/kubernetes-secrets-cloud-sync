import { Config } from "./Config";
import { KubernetesClient } from "./KubernetesClient";

// Mock @kubernetes/client-node
const mockListNamespace = jest.fn();
const mockReplaceNamespacedSecret = jest.fn();
const mockCreateNamespacedSecret = jest.fn();
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
        replaceNamespacedSecret: (...args: unknown[]) =>
          mockReplaceNamespacedSecret(...args),
        createNamespacedSecret: (...args: unknown[]) =>
          mockCreateNamespacedSecret(...args),
        listSecretForAllNamespaces: (...args: unknown[]) =>
          mockListSecretForAllNamespaces(...args),
        deleteNamespacedSecret: (...args: unknown[]) =>
          mockDeleteNamespacedSecret(...args),
      };
    }
  }
  return { KubeConfig: MockKubeConfig, CoreV1Api: {} };
});

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
          {
            metadata: {
              name: "default",
              annotations: {},
            },
          },
          {
            metadata: {
              name: "kube-system",
              annotations: {},
            },
          },
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
        items: [
          {
            metadata: { name: "default" },
          },
        ],
      });

      const result = await client.getNamespaceSyncRequests();
      expect(result).toEqual([]);
    });

    it("should skip namespaces without a name", async () => {
      mockListNamespace.mockResolvedValue({
        items: [
          {
            metadata: { annotations: {} },
          },
        ],
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
    it("should prefix secret name and encode data as base64", async () => {
      mockReplaceNamespacedSecret.mockResolvedValue({});

      await client.upsertSecret("default", "my-secret", {
        username: "admin",
        password: "s3cret",
      });

      expect(mockReplaceNamespacedSecret).toHaveBeenCalledWith({
        name: "cloudsync-my-secret",
        namespace: "default",
        body: expect.objectContaining({
          apiVersion: "v1",
          kind: "Secret",
          metadata: expect.objectContaining({
            name: "cloudsync-my-secret",
            labels: {
              "app.kubernetes.io/managed-by": "kubernetes-secrets-cloud-sync",
              "cloudsync.devopsplaybook.io/secret-name": "my-secret",
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

    it("should create secret if replace returns 404", async () => {
      const notFoundError = Object.assign(new Error("Not Found"), {
        code: 404,
      });
      mockReplaceNamespacedSecret.mockRejectedValue(notFoundError);
      mockCreateNamespacedSecret.mockResolvedValue({});

      await client.upsertSecret("default", "new-secret", { key: "value" });

      expect(mockCreateNamespacedSecret).toHaveBeenCalledWith({
        namespace: "default",
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: "cloudsync-new-secret",
          }),
        }),
      });
    });

    it("should throw if replace fails with non-404 error", async () => {
      const serverError = Object.assign(new Error("Server Error"), {
        code: 500,
      });
      mockReplaceNamespacedSecret.mockRejectedValue(serverError);

      await expect(
        client.upsertSecret("default", "fail-secret", { key: "value" }),
      ).rejects.toThrow("Server Error");
    });
  });

  describe("listManagedSecrets", () => {
    it("should return list of managed secrets from all namespaces", async () => {
      mockListSecretForAllNamespaces.mockResolvedValue({
        items: [
          {
            metadata: {
              namespace: "default",
              name: "cloudsync-secret-a",
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
        { namespace: "default", name: "cloudsync-secret-a" },
        { namespace: "production", name: "cloudsync-secret-b" },
      ]);
    });

    it("should filter out secrets without namespace or name", async () => {
      mockListSecretForAllNamespaces.mockResolvedValue({
        items: [
          {
            metadata: {
              namespace: "default",
              name: "valid-secret",
            },
          },
          {
            metadata: {},
          },
          {
            metadata: {
              namespace: "",
              name: "",
            },
          },
        ],
      });

      const result = await client.listManagedSecrets();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        namespace: "default",
        name: "valid-secret",
      });
    });

    it("should query with the managed-by label selector", async () => {
      mockListSecretForAllNamespaces.mockResolvedValue({ items: [] });

      await client.listManagedSecrets();

      expect(mockListSecretForAllNamespaces).toHaveBeenCalledWith({
        labelSelector:
          "app.kubernetes.io/managed-by=kubernetes-secrets-cloud-sync",
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
      const notFoundError = Object.assign(new Error("Not Found"), {
        code: 404,
      });
      mockDeleteNamespacedSecret.mockRejectedValue(notFoundError);

      // Should not throw
      await expect(
        client.deleteSecret("default", "already-deleted"),
      ).resolves.toBeUndefined();
    });

    it("should throw if delete fails with non-404 error", async () => {
      const forbiddenError = Object.assign(new Error("Forbidden"), {
        code: 403,
      });
      mockDeleteNamespacedSecret.mockRejectedValue(forbiddenError);

      await expect(
        client.deleteSecret("default", "no-permission"),
      ).rejects.toThrow("Forbidden");
    });
  });
});
