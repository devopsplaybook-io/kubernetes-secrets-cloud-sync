import { Config } from "./Config";
import { KubernetesClient, hashSecretData } from "./KubernetesClient";
import { OTelSetTracer } from "./OTelContext";
import { instanceIdForPrefix, isValidLabelValue, normalizeSecretName } from "./SecretName";

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
  class MockApiException extends Error {
    code: number;
    body: unknown;
    headers: Record<string, string>;
    constructor(
      code: number,
      message: string,
      body: unknown,
      headers: Record<string, string>,
    ) {
      super(message);
      this.code = code;
      this.body = body;
      this.headers = headers;
    }
  }
  return { KubeConfig: MockKubeConfig, CoreV1Api: {}, ApiException: MockApiException };
});

const { ApiException } = jest.requireMock("@kubernetes/client-node") as {
  ApiException: new (
    code: number,
    message: string,
    body: unknown,
    headers: Record<string, string>,
  ) => Error;
};

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

function encodeData(
  data: Record<string, string>,
): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    encoded[key] = Buffer.from(value).toString("base64");
  }
  return encoded;
}

/** A Secret as this controller would leave it after a successful cycle. */
function convergedSecret(
  client: KubernetesClient,
  sourceName: string,
  data: Record<string, string>,
): Record<string, any> {
  const labels: Record<string, string> = {
    "app.kubernetes.io/managed-by": "kubernetes-secrets-cloud-sync",
    "cloudsync.devopsplaybook.io/instance": client.instanceId,
  };
  if (isValidLabelValue(sourceName)) {
    labels["cloudsync.devopsplaybook.io/secret-name"] = sourceName;
  }
  return {
    metadata: {
      name: normalizeSecretName(sourceName, "cloudsync-"),
      namespace: "default",
      labels,
      annotations: {
        "cloudsync.devopsplaybook.io/source-name": sourceName,
        "cloudsync.devopsplaybook.io/data-hash": hashSecretData(data),
      },
    },
    type: "Opaque",
    data: encodeData(data),
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
              "cloudsync.devopsplaybook.io/data-hash": hashSecretData({
                username: "admin",
                password: "s3cret",
              }),
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
              "cloudsync.devopsplaybook.io/data-hash": hashSecretData({
                key: "new-value",
              }),
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

    it("does not patch an unchanged secret and reports it", async () => {
      mockGetNamespacedSecret.mockResolvedValue(
        convergedSecret(client, "my-secret", { key: "value", other: "two" }),
      );

      await expect(
        client.upsertSecret("default", "my-secret", {
          other: "two",
          key: "value",
        }),
      ).resolves.toBe("unchanged");

      expect(mockCreateNamespacedSecret).not.toHaveBeenCalled();
      expect(mockPatchNamespacedSecret).not.toHaveBeenCalled();
    });

    it("treats existing Buffer data as unchanged", async () => {
      const converged = convergedSecret(client, "my-secret", {
        key: "value",
      });
      converged.data.key = Buffer.from("value");
      mockGetNamespacedSecret.mockResolvedValue(converged);

      await expect(
        client.upsertSecret("default", "my-secret", { key: "value" }),
      ).resolves.toBe("unchanged");
      expect(mockPatchNamespacedSecret).not.toHaveBeenCalled();
    });

    it("converges a stale secret-name label with a metadata-only patch", async () => {
      const converged = convergedSecret(client, "prod/my-app/database", {
        key: "value",
      });
      converged.metadata.labels["cloudsync.devopsplaybook.io/secret-name"] =
        "stale";
      mockGetNamespacedSecret.mockResolvedValue(converged);
      mockPatchNamespacedSecret.mockResolvedValue({});

      await expect(
        client.upsertSecret("default", "prod/my-app/database", {
          key: "value",
        }),
      ).resolves.toBe("updated");

      const body = mockPatchNamespacedSecret.mock.calls[0][0].body;
      expect(body).toHaveLength(1);
      expect(body[0].path).toBe("/metadata/labels");
      expect(body[0].value).not.toHaveProperty(
        "cloudsync.devopsplaybook.io/secret-name",
      );
    });

    it("adds the data-hash annotation to a legacy secret without touching data", async () => {
      const legacy = convergedSecret(client, "my-secret", { key: "value" });
      delete legacy.metadata.annotations[
        "cloudsync.devopsplaybook.io/data-hash"
      ];
      mockGetNamespacedSecret.mockResolvedValue(legacy);
      mockPatchNamespacedSecret.mockResolvedValue({});

      await expect(
        client.upsertSecret("default", "my-secret", { key: "value" }),
      ).resolves.toBe("updated");

      const body = mockPatchNamespacedSecret.mock.calls[0][0].body;
      expect(body).toHaveLength(1);
      expect(body[0].path).toBe("/metadata/annotations");
      expect(body[0].value["cloudsync.devopsplaybook.io/data-hash"]).toBe(
        hashSecretData({ key: "value" }),
      );
    });

    it("patches data and the hash when the payload changes", async () => {
      mockGetNamespacedSecret.mockResolvedValue(
        convergedSecret(client, "my-secret", { key: "old" }),
      );
      mockPatchNamespacedSecret.mockResolvedValue({});

      await expect(
        client.upsertSecret("default", "my-secret", { key: "new" }),
      ).resolves.toBe("updated");

      const body = mockPatchNamespacedSecret.mock.calls[0][0].body;
      const paths = body.map((op: { path: string }) => op.path);
      expect(paths).toContain("/data");
      expect(paths).toContain("/metadata/annotations");
      const dataOp = body.find((op: { path: string }) => op.path === "/data");
      expect(dataOp.value).toEqual(encodeData({ key: "new" }));
      const annotationsOp = body.find(
        (op: { path: string }) => op.path === "/metadata/annotations",
      );
      expect(
        annotationsOp.value["cloudsync.devopsplaybook.io/data-hash"],
      ).toBe(hashSecretData({ key: "new" }));
    });

    it("patches data when the hash matches but the data was tampered with", async () => {
      const tampered = convergedSecret(client, "my-secret", { key: "value" });
      tampered.data.key = Buffer.from("tampered").toString("base64");
      mockGetNamespacedSecret.mockResolvedValue(tampered);
      mockPatchNamespacedSecret.mockResolvedValue({});

      await expect(
        client.upsertSecret("default", "my-secret", { key: "value" }),
      ).resolves.toBe("updated");

      const body = mockPatchNamespacedSecret.mock.calls[0][0].body;
      expect(body).toHaveLength(1);
      expect(body[0].path).toBe("/data");
      expect(body[0].value).toEqual(encodeData({ key: "value" }));
    });

    it("returns created or updated according to the write performed", async () => {
      mockGetNamespacedSecret.mockRejectedValueOnce(NOT_FOUND);
      mockCreateNamespacedSecret.mockResolvedValue({});
      await expect(
        client.upsertSecret("default", "my-secret", { key: "value" }),
      ).resolves.toBe("created");

      mockGetNamespacedSecret.mockResolvedValue(
        convergedSecret(client, "my-secret", { key: "value" }),
      );
      mockPatchNamespacedSecret.mockResolvedValue({});
      await expect(
        client.upsertSecret("default", "my-secret", { key: "changed" }),
      ).resolves.toBe("updated");
    });

    it("hashes data independently of key insertion order", () => {
      expect(hashSecretData({ a: "1", b: "2" })).toBe(
        hashSecretData({ b: "2", a: "1" }),
      );
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

    it("treats a Kubernetes ApiException 404 as not found", async () => {
      mockGetNamespacedSecret.mockRejectedValue(
        new ApiException(404, "Not Found", {}, {}),
      );
      mockCreateNamespacedSecret.mockResolvedValue({});

      await client.upsertSecret("default", "my-secret", { key: "value" });

      expect(mockCreateNamespacedSecret).toHaveBeenCalledWith({
        namespace: "default",
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: "cloudsync-my-secret" }),
        }),
      });
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

  describe("log noise and tracing", () => {
    interface FakeSpan {
      setAttribute: jest.Mock;
      recordException: jest.Mock;
      setStatus: jest.Mock;
      end: jest.Mock;
    }

    let spans: FakeSpan[];
    let tracer: { startSpan: jest.Mock; shutdown: jest.Mock };

    beforeEach(() => {
      spans = [];
      tracer = {
        startSpan: jest.fn(() => {
          const span: FakeSpan = {
            setAttribute: jest.fn(),
            recordException: jest.fn(),
            setStatus: jest.fn(),
            end: jest.fn(),
          };
          spans.push(span);
          return span;
        }),
        shutdown: jest.fn(async () => undefined),
      };
      OTelSetTracer(tracer as never);
    });

    afterEach(() => {
      OTelSetTracer(undefined as never);
      jest.restoreAllMocks();
    });

    it("does not emit one info line per annotated namespace", async () => {
      const logs: string[] = [];
      jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
      mockListNamespace.mockResolvedValue({
        items: [
          {
            metadata: {
              name: "default",
              annotations: {
                "secrets.cloudsync.devopsplaybook.io/alibaba-kms": "secret-a",
              },
            },
          },
        ],
      });

      await client.getNamespaceSyncRequests();

      expect(
        logs.some((line) => line.includes("found 1 sync annotation")),
      ).toBe(false);
    });

    it("wraps the namespace listing in a span", async () => {
      mockListNamespace.mockResolvedValue({ items: [] });

      await client.getNamespaceSyncRequests();

      expect(tracer.startSpan).toHaveBeenCalledWith(
        "k8s-list-namespaces",
        undefined,
        { kind: expect.anything() },
      );
      expect(spans[0].end).toHaveBeenCalled();
    });

    it("records a failed namespace listing as a span exception", async () => {
      mockListNamespace.mockRejectedValue(new Error("API down"));

      await expect(client.getNamespaceSyncRequests()).rejects.toThrow(
        "API down",
      );
      expect(spans[0].recordException).toHaveBeenCalledWith(expect.any(Error));
      expect(spans[0].end).toHaveBeenCalled();
    });

    it("emits child spans for secret get and create", async () => {
      mockGetNamespacedSecret.mockRejectedValue(NOT_FOUND);
      mockCreateNamespacedSecret.mockResolvedValue({});

      await client.upsertSecret("default", "my-secret", { key: "value" });

      const names = tracer.startSpan.mock.calls.map((call) => call[0]);
      expect(names).toEqual(
        expect.arrayContaining(["k8s-get-secret", "k8s-create-secret"]),
      );
      expect(spans.every((span) => span.end.mock.calls.length === 1)).toBe(
        true,
      );
    });

    it("wraps managed secret listing and deletion in spans", async () => {
      mockListSecretForAllNamespaces.mockResolvedValue({ items: [] });
      mockDeleteNamespacedSecret.mockResolvedValue({});

      await client.listManagedSecrets();
      await client.deleteSecret("default", "cloudsync-old");

      const names = tracer.startSpan.mock.calls.map((call) => call[0]);
      expect(names).toContain("k8s-list-secrets");
      expect(names).toContain("k8s-delete-secret");
    });
  });
});
