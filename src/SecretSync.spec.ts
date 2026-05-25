import { SecretSync } from "./SecretSync";
import { SecretSource } from "./sources/SecretSource";
import { NamespaceSyncRequest, SecretFetchResult } from "./types";

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
  };

  // Mock secret sources
  const mockSourceA: jest.Mocked<SecretSource> = {
    providerName: "alibaba-kms",
    init: jest.fn(),
    fetchSecret: jest.fn(),
    isAvailable: jest.fn(),
  };

  const mockSourceB: jest.Mocked<SecretSource> = {
    providerName: "aws-secretsmanager",
    init: jest.fn(),
    fetchSecret: jest.fn(),
    isAvailable: jest.fn(),
  };

  // Mock config
  const createMockConfig = (deleteOrphans: string | boolean = false) =>
    ({
      DELETE_ORPHANED_SECRETS: deleteOrphans,
    }) as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSourceA.isAvailable.mockReturnValue(true);
    mockSourceB.isAvailable.mockReturnValue(true);
  });

  describe("runSync", () => {
    it("should sync secrets from all namespaces with annotations", async () => {
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
        data: { key: "value1" },
      });

      const sync = new SecretSync(
        mockK8sClient as any,
        [mockSourceA],
        createMockConfig(),
      );
      await sync.runSync();

      expect(mockGetNamespaceSyncRequests).toHaveBeenCalledTimes(1);
      expect(mockSourceA.fetchSecret).toHaveBeenCalledWith("secret-a");
      expect(mockUpsertSecret).toHaveBeenCalledWith("default", "secret-a", {
        key: "value1",
      });
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
        mockK8sClient as any,
        [mockSourceA, mockSourceB],
        createMockConfig(),
      );
      await sync.runSync();

      expect(mockUpsertSecret).toHaveBeenCalledTimes(3);
      expect(mockUpsertSecret).toHaveBeenCalledWith(
        "default",
        "secret-a",
        { key: "val-a" },
      );
      expect(mockUpsertSecret).toHaveBeenCalledWith(
        "default",
        "secret-b",
        { key: "val-b" },
      );
      expect(mockUpsertSecret).toHaveBeenCalledWith(
        "production",
        "prod-db-pass",
        { password: "p@ss" },
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
        mockK8sClient as any,
        [mockSourceA, mockSourceB],
        createMockConfig(),
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
        mockK8sClient as any,
        [mockSourceA],
        createMockConfig(),
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
        mockK8sClient as any,
        [mockSourceA],
        createMockConfig(),
      );
      // Should not throw
      await expect(sync.runSync()).resolves.toBeUndefined();
      expect(mockUpsertSecret).not.toHaveBeenCalled();
    });

    it("should gracefully handle errors when fetchSecret fails", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([
        {
          namespace: "default",
          annotations: [
            { provider: "alibaba-kms", secretNames: ["secret-a"] },
          ],
        },
      ]);

      mockSourceA.fetchSecret.mockRejectedValue(
        new Error("KMS service unavailable"),
      );

      const sync = new SecretSync(
        mockK8sClient as any,
        [mockSourceA],
        createMockConfig(),
      );
      await expect(sync.runSync()).resolves.toBeUndefined();
      // Should not attempt to upsert if fetch failed
      expect(mockUpsertSecret).not.toHaveBeenCalled();
    });

    it("should gracefully handle errors when upsertSecret fails", async () => {
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

      mockUpsertSecret.mockRejectedValue(new Error("K8s API error"));

      const sync = new SecretSync(
        mockK8sClient as any,
        [mockSourceA],
        createMockConfig(),
      );
      await expect(sync.runSync()).resolves.toBeUndefined();
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
        mockK8sClient as any,
        [mockSourceA],
        createMockConfig(true),
      );
      await sync.runSync();

      // Should delete the orphaned secret but not the active one
      expect(mockDeleteSecret).toHaveBeenCalledWith(
        "default",
        "cloudsync-orphaned-secret",
      );
      expect(mockDeleteSecret).toHaveBeenCalledTimes(1);
    });

    it("should prune when DELETE_ORPHANED_SECRETS is string true", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([]);
      mockListManagedSecrets.mockResolvedValue([]);

      const sync = new SecretSync(
        mockK8sClient as any,
        [mockSourceA],
        createMockConfig("true"),
      );
      await sync.runSync();

      expect(mockListManagedSecrets).toHaveBeenCalled();
    });

    it("should prune when DELETE_ORPHANED_SECRETS is string 1", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([]);
      mockListManagedSecrets.mockResolvedValue([]);

      const sync = new SecretSync(
        mockK8sClient as any,
        [mockSourceA],
        createMockConfig("1"),
      );
      await sync.runSync();

      expect(mockListManagedSecrets).toHaveBeenCalled();
    });

    it("should skip orphan cleanup when DELETE_ORPHANED_SECRETS is false", async () => {
      mockGetNamespaceSyncRequests.mockResolvedValue([]);

      const sync = new SecretSync(
        mockK8sClient as any,
        [mockSourceA],
        createMockConfig(false),
      );
      await sync.runSync();

      expect(mockListManagedSecrets).not.toHaveBeenCalled();
      expect(mockDeleteSecret).not.toHaveBeenCalled();
    });

    it("should skip orphan cleanup when namespace listing failed", async () => {
      mockGetNamespaceSyncRequests.mockRejectedValue(
        new Error("API error"),
      );
      mockListManagedSecrets.mockResolvedValue([]);

      const sync = new SecretSync(
        mockK8sClient as any,
        [mockSourceA],
        createMockConfig(true),
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
        mockK8sClient as any,
        [mockSourceA],
        createMockConfig(true),
      );
      // Should not throw, just log the error
      await expect(sync.runSync()).resolves.toBeUndefined();
    });
  });
});
