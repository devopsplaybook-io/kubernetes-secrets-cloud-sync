import { Config } from "../Config";
import { ResticSource } from "./ResticSource";

// We need to access private methods for testing
interface ResticSourceTest {
  normalizePath(value: string | undefined): string;
  parseExtraOptions(value: string | undefined): string[];
  runRestic(args: string[]): Promise<string>;
}

jest.mock("child_process", () => {
  const makeEmitter = (): Record<string, any> => {
    const ee: Record<string, any> = {
      _handlers: {} as Record<string, ((...args: unknown[]) => void)[]>,
    };
    ee.on = jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      (ee._handlers[event] = ee._handlers[event] ?? []).push(handler);
      return ee;
    });
    ee.emit = (event: string, ...args: unknown[]) => {
      for (const handler of ee._handlers[event] ?? []) {
        handler(...args);
      }
    };
    return ee;
  };

  return {
    spawn: jest.fn(() => {
      const child = makeEmitter();
      child.stdout = makeEmitter();
      child.stderr = makeEmitter();
      child.pid = 12345;
      child.kill = jest.fn();
      return child;
    }),
  };
});

const { spawn } = jest.requireMock("child_process") as { spawn: jest.Mock };

function spawnedChild(index?: number): Record<string, any> {
  const results = spawn.mock.results;
  const result = index === undefined ? results[results.length - 1] : results[index];
  if (!result) {
    throw new Error(`No spawn call at index ${index}`);
  }
  return result.value;
}

function completeSnapshotResolution(
  snapshots: unknown,
  childIndex?: number,
): void {
  const child = spawnedChild(childIndex);
  child.stdout.emit("data", Buffer.from(JSON.stringify(snapshots)));
  child.emit("close", 0);
}

function completeDump(value: unknown, childIndex?: number): void {
  const child = spawnedChild(childIndex);
  child.stdout.emit("data", Buffer.from(JSON.stringify(value)));
  child.emit("close", 0);
}

describe("ResticSource", () => {
  let config: Config;
  let source: ResticSource;

  beforeEach(() => {
    jest.clearAllMocks();
    config = new Config();
    config.RESTIC_REPOSITORY = "s3:https://example.com/restic-repo";
    config.RESTIC_PASSWORD = "restic-pass";
    config.RESTIC_PATH = "secrets/";
    config.RESTIC_OPTIONS = "";
    config.RESTIC_TIMEOUT_SECONDS = 120;
    config.RESTIC_RETRIES = 0;
    source = new ResticSource(config);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("isAvailable", () => {
    it("should return true when RESTIC_REPOSITORY and RESTIC_PASSWORD are set", () => {
      expect(source.isAvailable()).toBe(true);
    });

    it("should return false when RESTIC_REPOSITORY is empty", () => {
      config.RESTIC_REPOSITORY = "";
      const s = new ResticSource(config);
      expect(s.isAvailable()).toBe(false);
    });

    it("should return false when RESTIC_PASSWORD is empty", () => {
      config.RESTIC_PASSWORD = "";
      const s = new ResticSource(config);
      expect(s.isAvailable()).toBe(false);
    });

    it("should return false when both are empty", () => {
      config.RESTIC_REPOSITORY = "";
      config.RESTIC_PASSWORD = "";
      const s = new ResticSource(config);
      expect(s.isAvailable()).toBe(false);
    });
  });

  describe("normalizePath", () => {
    it("should strip leading slashes", () => {
      const result = (source as unknown as ResticSourceTest).normalizePath(
        "/secrets/data",
      );
      expect(result).toBe("secrets/data");
    });

    it("should strip trailing slashes", () => {
      const result = (source as unknown as ResticSourceTest).normalizePath(
        "secrets/data/",
      );
      expect(result).toBe("secrets/data");
    });

    it("should strip both leading and trailing slashes", () => {
      const result = (source as unknown as ResticSourceTest).normalizePath(
        "/secrets/data/",
      );
      expect(result).toBe("secrets/data");
    });

    it("should collapse repeated slashes", () => {
      const result = (source as unknown as ResticSourceTest).normalizePath(
        "//secrets//data//",
      );
      expect(result).toBe("secrets/data");
    });

    it("should return empty string for undefined", () => {
      const result = (source as unknown as ResticSourceTest).normalizePath(
        undefined,
      );
      expect(result).toBe("");
    });

    it("should return empty string for empty string", () => {
      const result = (source as unknown as ResticSourceTest).normalizePath("");
      expect(result).toBe("");
    });
  });

  describe("parseExtraOptions", () => {
    it("should return empty array for undefined", () => {
      const result = (source as unknown as ResticSourceTest).parseExtraOptions(
        undefined,
      );
      expect(result).toEqual([]);
    });

    it("should return empty array for empty string", () => {
      const result = (source as unknown as ResticSourceTest).parseExtraOptions(
        "",
      );
      expect(result).toEqual([]);
    });

    it("should split unquoted options by whitespace", () => {
      const result = (source as unknown as ResticSourceTest).parseExtraOptions(
        "--option1 value1 --option2 value2",
      );
      expect(result).toEqual(["--option1", "value1", "--option2", "value2"]);
    });

    it("should handle double-quoted options", () => {
      const result = (source as unknown as ResticSourceTest).parseExtraOptions(
        '--option "value with spaces"',
      );
      expect(result).toEqual(["--option", "value with spaces"]);
    });

    it("should handle single-quoted options", () => {
      const result = (source as unknown as ResticSourceTest).parseExtraOptions(
        "--option 'value with spaces'",
      );
      expect(result).toEqual(["--option", "value with spaces"]);
    });

    it("should handle mixed options", () => {
      const result = (source as unknown as ResticSourceTest).parseExtraOptions(
        "--option1 val1 --option2 \"quoted val\" --option3 'also quoted'",
      );
      expect(result).toEqual([
        "--option1",
        "val1",
        "--option2",
        "quoted val",
        "--option3",
        "also quoted",
      ]);
    });

    it("should handle multiple quotes of the same type", () => {
      const result = (source as unknown as ResticSourceTest).parseExtraOptions(
        '-o "first value" -p "second value"',
      );
      expect(result).toEqual(["-o", "first value", "-p", "second value"]);
    });
  });

  describe("providerName", () => {
    it("should be 'restic'", () => {
      expect(source.providerName).toBe("restic");
    });
  });

  describe("beginCycle", () => {
    it("resolves the newest snapshot and dumps secrets from it", async () => {
      const cycle = source.beginCycle(["name-a", "name-b"]);
      completeSnapshotResolution([
        { id: "old", short_id: "old00000", time: "2026-10-01T00:00:00Z" },
        { id: "newest", short_id: "new00000", time: "2026-10-22T06:00:00Z" },
        { id: "middle", short_id: "mid00000", time: "2026-10-10T00:00:00Z" },
      ]);
      await cycle;

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0][1]).toEqual(["snapshots", "--json"]);

      const fetch = source.fetchSecret("name-a");
      completeDump({ key: "value" });
      await expect(fetch).resolves.toEqual({
        provider: "restic",
        secretName: "name-a",
        data: { key: "value" },
      });
      expect(spawn.mock.calls[1][1]).toEqual([
        "dump",
        "newest",
        "/secrets/name-a.json",
      ]);
    });

    it("breaks time ties by snapshot id", async () => {
      const cycle = source.beginCycle(["name-a"]);
      completeSnapshotResolution([
        { id: "aaa", time: "2026-10-22T06:00:00Z" },
        { id: "zzz", time: "2026-10-22T06:00:00Z" },
      ]);
      await cycle;

      const fetch = source.fetchSecret("name-a");
      completeDump({ key: "value" });
      await fetch;
      expect(spawn.mock.calls[1][1]).toEqual([
        "dump",
        "zzz",
        "/secrets/name-a.json",
      ]);
    });

    it("records a cycle error and fails fetches without spawning", async () => {
      const cycle = source.beginCycle(["name-a"]);
      const child = spawnedChild();
      child.stderr.emit("data", Buffer.from("repository unavailable"));
      child.emit("close", 1);
      await cycle;

      await expect(source.fetchSecret("name-a")).rejects.toThrow(
        "restic snapshots exited with code 1: repository unavailable",
      );
      // Only the failing snapshots call spawned.
      expect(spawn).toHaveBeenCalledTimes(1);

      source.endCycle();
      const fetch = source.fetchSecret("name-a");
      completeDump({ key: "value" });
      await expect(fetch).resolves.toMatchObject({ secretName: "name-a" });
    });

    it("fails fetches when the repository has no snapshots", async () => {
      const cycle = source.beginCycle(["name-a"]);
      completeSnapshotResolution([]);
      await cycle;

      await expect(source.fetchSecret("name-a")).rejects.toThrow(
        "restic snapshots returned no snapshots",
      );
    });
  });

  describe("fetchSecret", () => {
    it("uses restic dump and never restores the snapshot", async () => {
      const fetch = source.fetchSecret("feedwatcher");
      completeDump({ LLM_MODEL: "gpt-4" });
      await fetch;

      const args = spawn.mock.calls[0][1];
      expect(args[0]).toBe("dump");
      expect(args[1]).toBe("latest");
      expect(args[2]).toBe("/secrets/feedwatcher.json");
      expect(args).not.toContain("restore");
      expect(args).not.toContain("--include");
      expect(args).not.toContain("--target");
    });

    it("fails on invalid JSON", async () => {
      const fetch = source.fetchSecret("bad-json");
      const child = spawnedChild();
      child.stdout.emit("data", Buffer.from("not json"));
      child.emit("close", 0);
      await expect(fetch).rejects.toThrow("is not valid JSON");
    });

    it("fails when the file does not contain a JSON object", async () => {
      const fetch = source.fetchSecret("array");
      completeDump(["a", "b"]);
      await expect(fetch).rejects.toThrow("must contain a JSON object");
    });

    it("fails without spawning when the source is not configured", async () => {
      config.RESTIC_PASSWORD = "";
      await expect(source.fetchSecret("name-a")).rejects.toThrow(
        "Restic source not configured",
      );
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe("name and path validation", () => {
    it.each(["../x", "/abs", "a//b", "a*", "a?b", "a[b]", "a/./b", "a\\b"])(
      "rejects invalid restic secret name %p",
      async (name) => {
        await expect(source.fetchSecret(name)).rejects.toThrow(
          /Invalid restic secret name/,
        );
        expect(spawn).not.toHaveBeenCalled();
      },
    );

    it("accepts letters, digits, dots, underscores, dashes and slashes", async () => {
      const fetch = source.fetchSecret("secrets/a.b-c_d");
      completeDump({ key: "value" });
      await expect(fetch).resolves.toMatchObject({
        secretName: "secrets/a.b-c_d",
      });
      expect(spawn.mock.calls[0][1][2]).toBe(
        "/secrets/secrets/a.b-c_d.json",
      );
    });

    it("rejects a RESTIC_PATH with traversal or glob characters", async () => {
      config.RESTIC_PATH = "../etc";
      await expect(source.fetchSecret("name-a")).rejects.toThrow(
        "Invalid RESTIC_PATH",
      );
      expect(spawn).not.toHaveBeenCalled();
    });

    it("rejects an empty secret name", async () => {
      await expect(source.fetchSecret("")).rejects.toThrow(
        "restic secret name must not be empty",
      );
    });
  });

  describe("timeout and retries", () => {
    it("kills a hung restic invocation with SIGKILL", async () => {
      jest.useFakeTimers();
      const fetch = source.fetchSecret("name-a");
      const child = spawnedChild();

      jest.advanceTimersByTime(120_000);
      await expect(fetch).rejects.toThrow(
        "restic dump timed out after 120000ms",
      );
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("retries a transient failure and then succeeds", async () => {
      jest.useFakeTimers();
      config.RESTIC_RETRIES = 1;
      const fetch = source.fetchSecret("name-a");

      const first = spawnedChild();
      first.stderr.emit("data", Buffer.from("temporary failure"));
      first.emit("close", 1);

      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1000);
      expect(spawn).toHaveBeenCalledTimes(2);

      completeDump({ key: "value" });
      await expect(fetch).resolves.toMatchObject({ secretName: "name-a" });
    });

    it("does not retry when RESTIC_RETRIES is 0", async () => {
      const fetch = source.fetchSecret("name-a");
      const child = spawnedChild();
      child.stderr.emit("data", Buffer.from("failed"));
      child.emit("close", 1);

      await expect(fetch).rejects.toThrow("restic dump exited with code 1");
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("does not retry a missing restic binary", async () => {
      config.RESTIC_RETRIES = 2;
      const fetch = source.fetchSecret("name-a");
      const child = spawnedChild();
      const error = Object.assign(new Error("spawn restic ENOENT"), {
        code: "ENOENT",
      });
      child.emit("error", error);

      await expect(fetch).rejects.toThrow("spawn restic ENOENT");
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe("cycle benchmark", () => {
    it("performs one snapshot resolution and one dump per unique secret", async () => {
      const names = Array.from({ length: 47 }, (_, index) => `secret-${index}`);

      const cycle = source.beginCycle(names);
      completeSnapshotResolution([
        { id: "snap-1", time: "2026-10-22T06:00:00Z" },
      ]);
      await cycle;

      for (const name of names) {
        const fetch = source.fetchSecret(name);
        completeDump({ key: name });
        await fetch;
      }

      expect(spawn).toHaveBeenCalledTimes(48);
      const commands = spawn.mock.calls.map((call) => call[1][0]);
      expect(commands.filter((command) => command === "snapshots")).toHaveLength(
        1,
      );
      expect(commands.filter((command) => command === "dump")).toHaveLength(47);
      expect(commands).not.toContain("restore");
    });
  });

  describe("credential redaction", () => {
    beforeEach(() => {
      config.RESTIC_REPOSITORY =
        "s3:https://user:secret@example.com/restic-repo";
      config.RESTIC_PASSWORD = "restic-pass";
      config.RESTIC_OPTIONS = "--option secret-value";
      source = new ResticSource(config);
    });

    it("masks the repository in the initialization log", async () => {
      const logs: string[] = [];
      const logSpy = jest
        .spyOn(console, "log")
        .mockImplementation((...args: unknown[]) => {
          logs.push(args.map(String).join(" "));
        });

      const init = source.init();
      const child = spawnedChild();
      child.emit("close", 0);
      await init;

      expect(
        logs.some((line) =>
          line.includes("s3:https://***@example.com/restic-repo"),
        ),
      ).toBe(true);
      expect(logs.some((line) => line.includes("user:secret"))).toBe(false);
      logSpy.mockRestore();
    });

    it("sanitizes restic stderr in the thrown error", async () => {
      const fetch = source.fetchSecret("name-a");
      const child = spawnedChild();
      child.stderr.emit(
        "data",
        Buffer.from(
          "Fatal: unable to open s3:https://user:secret@example.com/restic-repo password restic-pass options --option secret-value",
        ),
      );
      child.emit("close", 1);

      const error = (await fetch.catch((err) => err)) as Error;
      expect(error.message).toContain("restic dump exited with code 1");
      expect(error.message).toContain("s3:https://***@example.com/restic-repo");
      expect(error.message).not.toContain("user:secret");
      expect(error.message).not.toContain("restic-pass");
      expect(error.message).not.toContain("secret-value");
    });

    it("sanitizes the retry warning", async () => {
      jest.useFakeTimers();
      config.RESTIC_RETRIES = 1;
      const logs: string[] = [];
      const logSpy = jest
        .spyOn(console, "log")
        .mockImplementation((...args: unknown[]) => {
          logs.push(args.map(String).join(" "));
        });

      const fetch = source.fetchSecret("name-a");
      const first = spawnedChild();
      first.stderr.emit(
        "data",
        Buffer.from(
          "temporary failure at s3:https://user:secret@example.com/restic-repo restic-pass",
        ),
      );
      first.emit("close", 1);

      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1000);
      completeDump({ key: "value" });
      await expect(fetch).resolves.toMatchObject({ secretName: "name-a" });

      expect(logs.some((line) => line.includes("user:secret"))).toBe(false);
      expect(logs.some((line) => line.includes("restic-pass"))).toBe(false);
      logSpy.mockRestore();
    });
  });
});
