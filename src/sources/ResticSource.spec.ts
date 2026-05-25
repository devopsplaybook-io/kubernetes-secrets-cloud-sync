import { Config } from "../Config";
import { ResticSource } from "./ResticSource";
import { SecretFetchResult } from "../types";

// We need to access private methods for testing
interface ResticSourceTest {
  normalizePath(value: string | undefined): string;
  parseExtraOptions(value: string | undefined): string[];
  runRestic(args: string[]): Promise<string>;
}

jest.mock("child_process", () => {
  const mockEventEmitter = () => {
    const ee: any = {};
    ee.on = jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!ee._handlers) ee._handlers = {};
      ee._handlers[event] = handler;
      return ee;
    });
    ee._emit = (event: string, ...args: unknown[]) => {
      if (ee._handlers && ee._handlers[event]) {
        ee._handlers[event](...args);
      }
    };
    return ee;
  };

  return {
    spawn: jest.fn(() => {
      const child = mockEventEmitter();
      child.stdout = mockEventEmitter();
      child.stderr = mockEventEmitter();
      child.pid = 12345;
      return child;
    }),
  };
});

describe("ResticSource", () => {
  let config: Config;
  let source: ResticSource;

  beforeEach(() => {
    jest.clearAllMocks();
    config = new Config();
    // Configure restic settings
    config.RESTIC_REPOSITORY = "s3:https://example.com/restic-repo";
    config.RESTIC_PASSWORD = "restic-pass";
    config.RESTIC_PATH = "secrets/";
    config.RESTIC_OPTIONS = "";
    source = new ResticSource(config);
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

    it("should handle multiple leading slashes", () => {
      const result = (source as unknown as ResticSourceTest).normalizePath(
        "//secrets//data//",
      );
      expect(result).toBe("secrets//data");
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
      const result = (
        source as unknown as ResticSourceTest
      ).parseExtraOptions(undefined);
      expect(result).toEqual([]);
    });

    it("should return empty array for empty string", () => {
      const result = (
        source as unknown as ResticSourceTest
      ).parseExtraOptions("");
      expect(result).toEqual([]);
    });

    it("should split unquoted options by whitespace", () => {
      const result = (
        source as unknown as ResticSourceTest
      ).parseExtraOptions("--option1 value1 --option2 value2");
      expect(result).toEqual([
        "--option1",
        "value1",
        "--option2",
        "value2",
      ]);
    });

    it("should handle double-quoted options", () => {
      const result = (
        source as unknown as ResticSourceTest
      ).parseExtraOptions('--option "value with spaces"');
      expect(result).toEqual(["--option", "value with spaces"]);
    });

    it("should handle single-quoted options", () => {
      const result = (
        source as unknown as ResticSourceTest
      ).parseExtraOptions("--option 'value with spaces'");
      expect(result).toEqual(["--option", "value with spaces"]);
    });

    it("should handle mixed options", () => {
      const result = (
        source as unknown as ResticSourceTest
      ).parseExtraOptions(
        '--option1 val1 --option2 "quoted val" --option3 \'also quoted\'',
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
      const result = (
        source as unknown as ResticSourceTest
      ).parseExtraOptions(
        '-o "first value" -p "second value"',
      );
      expect(result).toEqual([
        "-o",
        "first value",
        "-p",
        "second value",
      ]);
    });
  });

  describe("providerName", () => {
    it("should be 'restic'", () => {
      expect(source.providerName).toBe("restic");
    });
  });
});
