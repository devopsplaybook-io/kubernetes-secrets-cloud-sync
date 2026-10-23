import { SecretSync } from "./SecretSync";
import { SecretSource } from "./sources/SecretSource";
import { NamespaceSyncRequest } from "./types";
import { KubernetesClient } from "./KubernetesClient";
import { Config } from "./Config";
import { OTelSetTracer } from "./OTelContext";

describe("SecretSync", () => {
  // Mock dependencies
  const mockGetNamespaceSyncRequests = jest.fn<
    Promise<NamespaceSyncRequest[]>,
    []
  >();
  const mockUpsertSecret = jest.fn();
  const mockListManagedSecrets = jest.fn();
  const mockDeleteSecret = jest.fn();
  const mockSecretNamePrefix = "cloudsync-";

  const mockK8sClient = {
    getNamespaceSyncRequests: mockGetNamespaceSyncRequests,
    upsertSecret: mockUpsertSecret,
    listManagedSecrets: mockListManagedSecrets,
    deleteSecret: mockDeleteSecret,
    secretNamePrefix: mockSecretNamePrefix,
    instanceId: "abcd1234",
  };

  // Mock secret sources
  const mockSourceA: jest.Mocked<SecretSource> = {
    providerName: "alibaba-kms",
    init: jest.fn(),
    fetchSecret: jest.fn(),
    isAvailable: jest.fn(),
    beginCycle: jest.fn(),
    endCycle: jest.fn(),
  };

  const mockSourceB: jest.Mocked<SecretSource> = {
    providerName: "aws-secretsmanager",
    init: jest.fn(),
    fetchSecret: jest.fn(),
    isAvailable: jest.fn(),
    beginCycle: jest.fn(),
    endCycle: jest.fn(),
  };

  // Mock config
  const createMockConfig = (
    deleteOrphans: boolean = false,
    overrides: Partial<Config> = {},
  ): Partial<Config> => ({
    DELETE_ORPHANED_SECRETS: deleteOrphans,
    ORPHAN_CLEANUP_DRY_RUN: false,
    ORPHAN_CLEANUP_MAX_DELETIONS: 50,
    SYNC_FETCH_CONCURRENCY: 4,
    SYNC_WRITE_CONCURRENCY: 4,
    ...overrides,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    mockSourceA.isAvailable.mockReturnValue(true);
    mockSourceB.isAvailable.mockReturnValue(true);
    mockUpsertSecret.mockResolvedValue("updated");
  });

  describe("runSync", () => {
    it("should sync secrets from all namespaces with annotations", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [{ provider: "alibaba-kms", secretNames: ["secret-a"] }],
        },
      ]);

      mockSourceA.fetchSecret.mockResolvedValue({
        provider: "alibaba-kms",
        secretName: "secret-a",
        data: { key: "value1" },
      });

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      await sync.runSync();

      expect(mockGetNamespaceSyncRequests).toHaveBeenCalledTimes(1);
      expect(mockSourceA.fetchSecret).toHaveBeenCalledWith("secret-a");
      expect(mockUpsertSecret).toHaveBeenCalledWith(
        "default",
        "secret-a",
        { key: "value1" },
        undefined,
      );
    });

    it("should handle multiple namespaces and multiple providers", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [
            { provider: "alibaba-kms", secretNames: ["secret-a", "secret-b"] },
          ],
        },
        {
          namespace: "production",
          annotations: [
            {
              provider: "aws-secretsmanager",
              secretNames: ["prod-db-pass"],
            },
          ],
        },
      ]);

      mockSourceA.fetchSecret
        .mockResolvedValueOnce({
          provider: "alibaba-kms",
          secretName: "secret-a",
          data: { key: "val-a" },
        })
        .mockResolvedValueOnce({
          provider: "alibaba-kms",
          secretName: "secret-b",
          data: { key: "val-b" },
        });

      mockSourceB.fetchSecret.mockResolvedValue({
        provider: "aws-secretsmanager",
        secretName: "prod-db-pass",
        data: { password: "p@ss" },
      });

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA, mockSourceB],
        createMockConfig() as Config,
      );
      await sync.runSync();

      expect(mockUpsertSecret).toHaveBeenCalledTimes(3);
      expect(mockUpsertSecret).toHaveBeenCalledWith(
        "default",
        "secret-a",
        { key: "val-a" },
        undefined,
      );
      expect(mockUpsertSecret).toHaveBeenCalledWith(
        "default",
        "secret-b",
        { key: "val-b" },
        undefined,
      );
      expect(mockUpsertSecret).toHaveBeenCalledWith(
        "production",
        "prod-db-pass",
        { password: "p@ss" },
        undefined,
      );
    });

    it("should skip providers that are not available", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [
            { provider: "alibaba-kms", secretNames: ["secret-a"] },
            { provider: "aws-secretsmanager", secretNames: ["secret-b"] },
          ],
        },
      ]);

      mockSourceA.isAvailable.mockReturnValue(true);
      mockSourceB.isAvailable.mockReturnValue(false);

      mockSourceA.fetchSecret.mockResolvedValue({
        provider: "alibaba-kms",
        secretName: "secret-a",
        data: { key: "value" },
      });

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA, mockSourceB],
        createMockConfig() as Config,
      );
      await sync.runSync();

      expect(mockSourceA.fetchSecret).toHaveBeenCalledWith("secret-a");
      expect(mockSourceB.fetchSecret).not.toHaveBeenCalled();
      expect(mockUpsertSecret).toHaveBeenCalledTimes(1);
    });

    it("should skip providers not found in registered sources", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [
            { provider: "unknown-provider", secretNames: ["secret-x"] },
          ],
        },
      ]);

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      await sync.runSync();

      expect(mockSourceA.fetchSecret).not.toHaveBeenCalled();
      expect(mockUpsertSecret).not.toHaveBeenCalled();
    });

    it("should gracefully handle errors when namespace listing fails", async () => {
      mockGetNamespaceSyncRequests.mockRejectedValue(
        new Error("API connection failed"),
      );

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      // Should not throw, and must report the failed listing.
      const result = await sync.runSync();
      expect(result.namespaceListSucceeded).toBe(false);
      expect(result.namespaces).toBe(0);
      expect(result.errors).toBe(1);
      expect(result.secrets).toBe(0);
      expect(result.failedNamespaces).toEqual([]);
      expect(mockUpsertSecret).not.toHaveBeenCalled();
    });

    it("should gracefully handle errors when fetchSecret fails", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [{ provider: "alibaba-kms", secretNames: ["secret-a"] }],
        },
      ]);

      mockSourceA.fetchSecret.mockRejectedValue(
        new Error("KMS service unavailable"),
      );

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      const result = await sync.runSync();
      expect(result.succeededSecrets).toBe(0);
      expect(result.failedNamespaces).toEqual(["default"]);
      // Should not attempt to upsert if fetch failed
      expect(mockUpsertSecret).not.toHaveBeenCalled();
    });

    it("should gracefully handle errors when upsertSecret fails", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [{ provider: "alibaba-kms", secretNames: ["secret-a"] }],
        },
      ]);

      mockSourceA.fetchSecret.mockResolvedValue({
        provider: "alibaba-kms",
        secretName: "secret-a",
        data: { key: "value" },
      });

      mockUpsertSecret.mockRejectedValue(new Error("K8s API error"));

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      const result = await sync.runSync();
      expect(result.succeededSecrets).toBe(1);
      expect(result.failedNamespaces).toEqual(["default"]);
      expect(result.errors).toBe(1);
    });

    it("should delete orphaned secrets when DELETE_ORPHANED_SECRETS is true", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [
            { provider: "alibaba-kms", secretNames: ["active-secret"] },
          ],
        },
      ]);

      mockSourceA.fetchSecret.mockResolvedValue({
        provider: "alibaba-kms",
        secretName: "active-secret",
        data: { key: "value" },
      });

      mockListManagedSecrets.mockResolvedValue([
        { namespace: "default", name: "cloudsync-active-secret" },
        { namespace: "default", name: "cloudsync-orphaned-secret" },
      ]);

      mockUpsertSecret.mockResolvedValue(undefined);
      mockDeleteSecret.mockResolvedValue(undefined);

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig(true) as Config,
      );
      await sync.runSync();

      // Should delete the orphaned secret but not the active one
      expect(mockDeleteSecret).toHaveBeenCalledWith(
        "default",
        "cloudsync-orphaned-secret",
        undefined,
      );
      expect(mockDeleteSecret).toHaveBeenCalledTimes(1);
    });

    it("should prune when DELETE_ORPHANED_SECRETS is string true", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([]);
      mockListManagedSecrets.mockResolvedValue([]);

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        { DELETE_ORPHANED_SECRETS: "true" } as unknown as Config,
      );
      await sync.runSync();

      expect(mockListManagedSecrets).toHaveBeenCalled();
    });

    it("should prune when DELETE_ORPHANED_SECRETS is string 1", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([]);
      mockListManagedSecrets.mockResolvedValue([]);

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        { DELETE_ORPHANED_SECRETS: "1" } as unknown as Config,
      );
      await sync.runSync();

      expect(mockListManagedSecrets).toHaveBeenCalled();
    });

    it("should skip orphan cleanup when DELETE_ORPHANED_SECRETS is false", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([]);

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig(false) as Config,
      );
      await sync.runSync();

      expect(mockListManagedSecrets).not.toHaveBeenCalled();
      expect(mockDeleteSecret).not.toHaveBeenCalled();
    });

    it("should skip orphan cleanup when namespace listing failed", async () => {
      mockGetNamespaceSyncRequests.mockRejectedValue(new Error("API error"));
      mockListManagedSecrets.mockResolvedValue([]);

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig(true) as Config,
      );
      await sync.runSync();

      // Should not list secrets for orphan cleanup since namespace listing failed
      expect(mockListManagedSecrets).not.toHaveBeenCalled();
    });

    it("should gracefully handle orphan deletion failures", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [
            { provider: "alibaba-kms", secretNames: ["active-secret"] },
          ],
        },
      ]);

      mockSourceA.fetchSecret.mockResolvedValue({
        provider: "alibaba-kms",
        secretName: "active-secret",
        data: { key: "value" },
      });

      mockUpsertSecret.mockResolvedValue(undefined);

      mockListManagedSecrets.mockResolvedValue([
        { namespace: "default", name: "cloudsync-orphaned" },
      ]);

      mockDeleteSecret.mockRejectedValue(new Error("Delete failed"));

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig(true) as Config,
      );
      // Should not throw, just log the error
      const result = await sync.runSync();
      expect(result.namespaceListSucceeded).toBe(true);
      expect(result.errors).toBe(1);
      expect(result.failedNamespaces).toEqual([]);
    });

    it("should skip colliding secret names while syncing the others", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [
            {
              provider: "alibaba-kms",
              secretNames: ["prod/app/db", "prod-app-db", "safe-secret"],
            },
          ],
        },
      ]);

      mockSourceA.fetchSecret.mockImplementation(async (secretName: string) => ({
        provider: "alibaba-kms",
        secretName,
        data: { key: "value" },
      }));

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      await sync.runSync();

      expect(mockUpsertSecret).toHaveBeenCalledTimes(1);
      expect(mockUpsertSecret).toHaveBeenCalledWith(
        "default",
        "safe-secret",
        { key: "value" },
        undefined,
      );
    });

    it("should fetch a duplicate secret once and write it per namespace", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "ns-a",
          annotations: [
            { provider: "alibaba-kms", secretNames: ["shared", "a-only"] },
          ],
        },
        {
          namespace: "ns-b",
          annotations: [
            { provider: "alibaba-kms", secretNames: ["shared", "b-only"] },
          ],
        },
      ]);

      mockSourceA.fetchSecret.mockImplementation(async (secretName: string) => ({
        provider: "alibaba-kms",
        secretName,
        data: { key: secretName },
      }));

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      await sync.runSync();

      expect(mockSourceA.fetchSecret).toHaveBeenCalledTimes(3);
      expect(
        mockSourceA.fetchSecret.mock.calls.map((call) => call[0]).sort(),
      ).toEqual(["a-only", "b-only", "shared"]);
      expect(mockUpsertSecret).toHaveBeenCalledTimes(4);
      expect(mockUpsertSecret).toHaveBeenCalledWith(
        "ns-a",
        "shared",
        { key: "shared" },
        undefined,
      );
      expect(mockUpsertSecret).toHaveBeenCalledWith(
        "ns-b",
        "shared",
        { key: "shared" },
        undefined,
      );
      expect(mockSourceA.beginCycle).toHaveBeenCalledTimes(1);
      expect(
        (mockSourceA.beginCycle.mock.calls[0][0] as string[]).sort(),
      ).toEqual(["a-only", "b-only", "shared"]);
      expect(mockSourceA.endCycle).toHaveBeenCalledTimes(1);
    });

    it("should fetch the same name once per provider", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "ns-a",
          annotations: [{ provider: "alibaba-kms", secretNames: ["shared"] }],
        },
        {
          namespace: "ns-b",
          annotations: [
            { provider: "aws-secretsmanager", secretNames: ["shared"] },
          ],
        },
      ]);

      mockSourceA.fetchSecret.mockResolvedValue({
        provider: "alibaba-kms",
        secretName: "shared",
        data: { key: "a" },
      });
      mockSourceB.fetchSecret.mockResolvedValue({
        provider: "aws-secretsmanager",
        secretName: "shared",
        data: { key: "b" },
      });

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA, mockSourceB],
        createMockConfig() as Config,
      );
      await sync.runSync();

      expect(mockSourceA.fetchSecret).toHaveBeenCalledTimes(1);
      expect(mockSourceB.fetchSecret).toHaveBeenCalledTimes(1);
      expect(mockUpsertSecret).toHaveBeenCalledTimes(2);
      expect(mockSourceA.beginCycle).toHaveBeenCalledWith(["shared"]);
      expect(mockSourceB.beginCycle).toHaveBeenCalledWith(["shared"]);
    });

    it("should cache a failed fetch and still write the other secrets", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "ns-a",
          annotations: [
            { provider: "alibaba-kms", secretNames: ["broken", "fine"] },
          ],
        },
        {
          namespace: "ns-b",
          annotations: [
            { provider: "alibaba-kms", secretNames: ["broken", "fine"] },
          ],
        },
      ]);

      mockSourceA.fetchSecret.mockImplementation(async (secretName: string) => {
        if (secretName === "broken") {
          throw new Error("fetch failed");
        }
        return {
          provider: "alibaba-kms",
          secretName,
          data: { key: secretName },
        };
      });

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      await sync.runSync();

      // One attempt per unique name, not per reference.
      expect(mockSourceA.fetchSecret).toHaveBeenCalledTimes(2);
      expect(mockUpsertSecret).toHaveBeenCalledTimes(2);
      expect(
        mockUpsertSecret.mock.calls.every((call) => call[1] === "fine"),
      ).toBe(true);
    });

    it("should call endCycle even when writes fail", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "ns-a",
          annotations: [{ provider: "alibaba-kms", secretNames: ["secret-a"] }],
        },
      ]);
      mockSourceA.fetchSecret.mockResolvedValue({
        provider: "alibaba-kms",
        secretName: "secret-a",
        data: { key: "value" },
      });
      mockUpsertSecret.mockRejectedValue(new Error("K8s API error"));

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      await sync.runSync();

      expect(mockSourceA.endCycle).toHaveBeenCalledTimes(1);
    });

    it("should not fetch colliding secret names", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [
            {
              provider: "alibaba-kms",
              secretNames: ["prod/app/db", "prod-app-db", "safe-secret"],
            },
          ],
        },
      ]);

      mockSourceA.fetchSecret.mockResolvedValue({
        provider: "alibaba-kms",
        secretName: "safe-secret",
        data: { key: "value" },
      });

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      await sync.runSync();

      expect(mockSourceA.fetchSecret).toHaveBeenCalledTimes(1);
      expect(mockSourceA.fetchSecret).toHaveBeenCalledWith("safe-secret");
      expect(mockSourceA.beginCycle).toHaveBeenCalledWith(["safe-secret"]);
      expect(mockUpsertSecret).toHaveBeenCalledTimes(1);
    });

    it("should respect the fetch concurrency limit", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [
            {
              provider: "alibaba-kms",
              secretNames: Array.from({ length: 6 }, (_, i) => `secret-${i}`),
            },
          ],
        },
      ]);

      let inFlight = 0;
      let maxInFlight = 0;
      mockSourceA.fetchSecret.mockImplementation(async (secretName: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return {
          provider: "alibaba-kms",
          secretName,
          data: { key: secretName },
        };
      });

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig(false, { SYNC_FETCH_CONCURRENCY: 2 }) as Config,
      );
      await sync.runSync();

      expect(maxInFlight).toBe(2);
      expect(mockUpsertSecret).toHaveBeenCalledTimes(6);
    });

    it("should respect the write concurrency limit", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [
            {
              provider: "alibaba-kms",
              secretNames: Array.from({ length: 6 }, (_, i) => `secret-${i}`),
            },
          ],
        },
      ]);

      mockSourceA.fetchSecret.mockImplementation(async (secretName: string) => ({
        provider: "alibaba-kms",
        secretName,
        data: { key: secretName },
      }));

      let inFlight = 0;
      let maxInFlight = 0;
      mockUpsertSecret.mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return "updated";
      });

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig(false, { SYNC_WRITE_CONCURRENCY: 2 }) as Config,
      );
      await sync.runSync();

      expect(maxInFlight).toBe(2);
      expect(mockUpsertSecret).toHaveBeenCalledTimes(6);
    });

    it("should match the measured workload shape", async () => {
      const uniqueNames = Array.from({ length: 47 }, (_, i) => `secret-${i}`);
      const requests: NamespaceSyncRequest[] = [];
      let references = 0;
      for (let namespaceIndex = 0; namespaceIndex < 13; namespaceIndex++) {
        const count = namespaceIndex < 2 ? 7 : 6;
        const secretNames = Array.from(
          { length: count },
          (_, offset) => uniqueNames[(namespaceIndex * 4 + offset) % 47],
        );
        requests.push({
          namespace: `ns-${namespaceIndex}`,
          annotations: [{ provider: "alibaba-kms", secretNames }],
        });
        references += count;
      }
      expect(references).toBe(80);

      mockGetNamespaceSyncRequests.mockResolvedValue(requests);
      mockSourceA.fetchSecret.mockImplementation(async (secretName: string) => ({
        provider: "alibaba-kms",
        secretName,
        data: { key: secretName },
      }));

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      await sync.runSync();

      expect(mockSourceA.fetchSecret).toHaveBeenCalledTimes(47);
      expect(mockUpsertSecret).toHaveBeenCalledTimes(80);
      const fetched = new Set(
        mockSourceA.fetchSecret.mock.calls.map((call) => call[0]),
      );
      expect(fetched.size).toBe(47);
      expect(mockSourceA.beginCycle).toHaveBeenCalledTimes(1);
      expect(
        (mockSourceA.beginCycle.mock.calls[0][0] as string[]).length,
      ).toBe(47);
    });

    it("should list orphan candidates but delete nothing on dry run", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([]);
      mockListManagedSecrets.mockResolvedValue([
        { namespace: "default", name: "cloudsync-orphan" },
      ]);

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        {
          DELETE_ORPHANED_SECRETS: true,
          ORPHAN_CLEANUP_DRY_RUN: true,
          ORPHAN_CLEANUP_MAX_DELETIONS: 50,
        } as unknown as Config,
      );
      await sync.runSync();

      expect(mockListManagedSecrets).toHaveBeenCalled();
      expect(mockDeleteSecret).not.toHaveBeenCalled();
    });

    it("should delete nothing when orphans exceed the max deletions threshold", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([]);
      mockListManagedSecrets.mockResolvedValue([
        { namespace: "default", name: "cloudsync-orphan-1" },
        { namespace: "default", name: "cloudsync-orphan-2" },
      ]);

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        {
          DELETE_ORPHANED_SECRETS: true,
          ORPHAN_CLEANUP_DRY_RUN: false,
          ORPHAN_CLEANUP_MAX_DELETIONS: 1,
        } as unknown as Config,
      );
      await sync.runSync();

      expect(mockDeleteSecret).not.toHaveBeenCalled();
    });

    it("should delete orphans when below the max deletions threshold", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([]);
      mockListManagedSecrets.mockResolvedValue([
        { namespace: "default", name: "cloudsync-orphan-1" },
        { namespace: "default", name: "cloudsync-orphan-2" },
      ]);
      mockDeleteSecret.mockResolvedValue(undefined);

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        {
          DELETE_ORPHANED_SECRETS: true,
          ORPHAN_CLEANUP_DRY_RUN: false,
          ORPHAN_CLEANUP_MAX_DELETIONS: 5,
        } as unknown as Config,
      );
      await sync.runSync();

      expect(mockDeleteSecret).toHaveBeenCalledTimes(2);
    });

    it("should keep managed secrets matched through their source-name annotation", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [
            {
              provider: "aws-secretsmanager",
              secretNames: ["prod/my-app/database"],
            },
          ],
        },
      ]);

      mockSourceB.fetchSecret.mockResolvedValue({
        provider: "aws-secretsmanager",
        secretName: "prod/my-app/database",
        data: { password: "p@ss" },
      });

      mockListManagedSecrets.mockResolvedValue([
        {
          namespace: "default",
          name: "cloudsync-prod-my-app-database",
          sourceName: "prod/my-app/database",
        },
      ]);
      mockUpsertSecret.mockResolvedValue(undefined);
      mockDeleteSecret.mockResolvedValue(undefined);

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceB],
        createMockConfig(true) as Config,
      );
      await sync.runSync();

      expect(mockDeleteSecret).not.toHaveBeenCalled();
    });
  });

  describe("sync run result and spans", () => {
    it("reports counts and failed namespaces for a partial failure", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "ok",
          annotations: [{ provider: "alibaba-kms", secretNames: ["good"] }],
        },
        {
          namespace: "bad",
          annotations: [{ provider: "alibaba-kms", secretNames: ["broken"] }],
        },
      ]);
      mockSourceA.fetchSecret.mockImplementation(async (secretName: string) => {
        if (secretName === "broken") {
          throw new Error("fetch failed");
        }
        return {
          provider: "alibaba-kms",
          secretName,
          data: { key: "value" },
        };
      });

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      const result = await sync.runSync();

      expect(result).toMatchObject({
        namespaces: 2,
        secrets: 2,
        succeededSecrets: 1,
        errors: 1,
        failedNamespaces: ["bad"],
        namespaceListSucceeded: true,
      });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("counts a name collision as one error and marks the namespace", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [
            {
              provider: "alibaba-kms",
              secretNames: ["prod/app/db", "prod-app-db"],
            },
          ],
        },
      ]);

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      const result = await sync.runSync();

      expect(result.secrets).toBe(2);
      expect(result.succeededSecrets).toBe(0);
      expect(result.errors).toBe(1);
      expect(result.failedNamespaces).toEqual(["default"]);
      expect(mockSourceA.fetchSecret).not.toHaveBeenCalled();
    });

    it("marks every namespace of a provider whose beginCycle failed", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "ns-a",
          annotations: [{ provider: "alibaba-kms", secretNames: ["a"] }],
        },
        {
          namespace: "ns-b",
          annotations: [{ provider: "alibaba-kms", secretNames: ["b"] }],
        },
      ]);
      mockSourceA.beginCycle.mockRejectedValue(new Error("snapshot failed"));
      mockSourceA.fetchSecret.mockRejectedValue(new Error("snapshot failed"));

      const sync = new SecretSync(
        mockK8sClient as unknown as KubernetesClient,
        [mockSourceA],
        createMockConfig() as Config,
      );
      const result = await sync.runSync();

      expect(result.failedNamespaces).toEqual(["ns-a", "ns-b"]);
      expect(result.succeededSecrets).toBe(0);
      expect(result.errors).toBeGreaterThanOrEqual(3);
    });

    it("wraps the cycle in spans with result attributes", async () => {
      interface FakeSpan {
        setAttribute: jest.Mock;
        recordException: jest.Mock;
        setStatus: jest.Mock;
        end: jest.Mock;
      }
      const spans: Array<{ name: string; span: FakeSpan }> = [];
      const tracer = {
        startSpan: jest.fn((name: string) => {
          const span: FakeSpan = {
            setAttribute: jest.fn(),
            recordException: jest.fn(),
            setStatus: jest.fn(),
            end: jest.fn(),
          };
          spans.push({ name, span });
          return span;
        }),
        shutdown: jest.fn(async () => undefined),
      };
      OTelSetTracer(tracer as never);

      try {
        mockGetNamespaceSyncRequests.mockResolvedValue([
          {
            namespace: "default",
            annotations: [
              { provider: "alibaba-kms", secretNames: ["secret-a"] },
            ],
          },
        ]);
        mockSourceA.fetchSecret.mockResolvedValue({
          provider: "alibaba-kms",
          secretName: "secret-a",
          data: { key: "value" },
        });

        const sync = new SecretSync(
          mockK8sClient as unknown as KubernetesClient,
          [mockSourceA],
          createMockConfig() as Config,
        );
        await sync.runSync();

        const names = spans.map((entry) => entry.name);
        expect(names).toEqual(
          expect.arrayContaining([
            "sync-run",
            "source-begin-cycle",
            "source-fetch",
            "source-end-cycle",
          ]),
        );

        const root = spans.find((entry) => entry.name === "sync-run")!.span;
        expect(root.setAttribute).toHaveBeenCalledWith("sync.namespaces", 1);
        expect(root.setAttribute).toHaveBeenCalledWith("sync.secrets", 1);
        expect(root.setAttribute).toHaveBeenCalledWith(
          "sync.succeeded_secrets",
          1,
        );
        expect(root.setAttribute).toHaveBeenCalledWith("sync.errors", 0);
        expect(root.setAttribute).toHaveBeenCalledWith(
          "sync.namespace_list_succeeded",
          true,
        );
        expect(root.end).toHaveBeenCalled();

        const fetchSpan = spans.find(
          (entry) => entry.name === "source-fetch",
        )!.span;
        expect(fetchSpan.setAttribute).toHaveBeenCalledWith(
          "secret.provider",
          "alibaba-kms",
        );
        expect(fetchSpan.setAttribute).toHaveBeenCalledWith(
          "secret.name",
          "secret-a",
        );
        expect(fetchSpan.setAttribute).toHaveBeenCalledWith(
          "source.fetch.success",
          true,
        );
        expect(fetchSpan.end).toHaveBeenCalled();
      } finally {
        OTelSetTracer(undefined as never);
      }
    });

    it("records handled fetch failures on the fetch span", async () => {
      interface FakeSpan {
        setAttribute: jest.Mock;
        recordException: jest.Mock;
        setStatus: jest.Mock;
        end: jest.Mock;
      }
      const spans: Array<{ name: string; span: FakeSpan }> = [];
      const tracer = {
        startSpan: jest.fn((name: string) => {
          const span: FakeSpan = {
            setAttribute: jest.fn(),
            recordException: jest.fn(),
            setStatus: jest.fn(),
            end: jest.fn(),
          };
          spans.push({ name, span });
          return span;
        }),
        shutdown: jest.fn(async () => undefined),
      };
      OTelSetTracer(tracer as never);

      try {
        mockGetNamespaceSyncRequests.mockResolvedValue([
          {
            namespace: "default",
            annotations: [
              { provider: "alibaba-kms", secretNames: ["secret-a"] },
            ],
          },
        ]);
        mockSourceA.fetchSecret.mockRejectedValue(new Error("fetch failed"));

        const sync = new SecretSync(
          mockK8sClient as unknown as KubernetesClient,
          [mockSourceA],
          createMockConfig() as Config,
        );
        await sync.runSync();

        const fetchSpan = spans.find(
          (entry) => entry.name === "source-fetch",
        )!.span;
        expect(fetchSpan.setAttribute).toHaveBeenCalledWith(
          "source.fetch.success",
          false,
        );
        expect(fetchSpan.recordException).toHaveBeenCalledWith(
          expect.objectContaining({ message: "fetch failed" }),
        );
        expect(fetchSpan.end).toHaveBeenCalled();
      } finally {
        OTelSetTracer(undefined as never);
      }
    });
  });
});
