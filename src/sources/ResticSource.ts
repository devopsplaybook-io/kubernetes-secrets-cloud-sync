import { spawn } from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { BaseSecretSource } from "./SecretSource";
import { Config } from "../Config";
import { OTelLogger } from "../OTelContext";
import { SecretFetchResult } from "../types";

const logger = OTelLogger().createModuleLogger("restic-source");

/**
 * Restic secret source implementation.
 *
 * For each secret name requested, the source restores the latest snapshot
 * of the configured restic repository into a fresh temporary directory,
 * reads the file named `<secretName>.json` (expected to be a flat JSON
 * object of string key/value pairs), then removes the temporary directory.
 *
 * Annotation key: secrets.cloudsync.devopsplaybook.io/restic
 * Annotation value: comma-separated list of secret names (each maps to
 * `<secretName>.json` inside the snapshot).
 */
export class ResticSource extends BaseSecretSource {
  readonly providerName = "restic";
  private readonly config: Config;

  constructor(config: Config) {
    super();
    this.config = config;
  }

  async init(): Promise<void> {
    if (!this.isAvailable()) {
      logger.warn(
        "Restic source not configured. Required: RESTIC_REPOSITORY, RESTIC_PASSWORD",
      );
      return;
    }

    try {
      await this.runRestic(["version"]);
      logger.info(
        `Restic source initialized (repository: ${this.config.RESTIC_REPOSITORY})`,
      );
    } catch (error) {
      logger.error(`Restic CLI not available: ${error}`);
    }
  }

  async fetchSecret(secretName: string): Promise<SecretFetchResult> {
    if (!this.isAvailable()) {
      throw new Error("Restic source not configured");
    }

    const tempDir = await fse.mkdtemp(
      path.join(os.tmpdir(), "restic-secrets-"),
    );

    try {
      const subPath = this.normalizePath(this.config.RESTIC_PATH);
      const fileRelative = subPath
        ? `${subPath}/${secretName}.json`
        : `${secretName}.json`;
      const includePattern = `/${fileRelative}`;

      logger.info(
        `Fetching secret ${secretName} from restic snapshot (include: ${includePattern})`,
      );

      await this.runRestic([
        "restore",
        "latest",
        "--target",
        tempDir,
        "--include",
        includePattern,
      ]);

      const restoredFile = path.join(tempDir, fileRelative);
      if (!(await fse.pathExists(restoredFile))) {
        throw new Error(
          `Secret file not found in latest snapshot: ${includePattern}`,
        );
      }

      const content = await fse.readFile(restoredFile, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        const error = new Error(
          `Secret file ${includePattern} is not valid JSON: ${err}`,
        );
        (error as Error & { cause?: unknown }).cause = err;
        throw error;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(
          `Secret file ${includePattern} must contain a JSON object`,
        );
      }

      const raw = parsed as Record<string, unknown>;
      logger.info(
        `Secret fetched: ${secretName} (${Object.keys(raw).length} keys)`,
      );

      return this.buildResult(secretName, raw);
    } finally {
      try {
        await fse.remove(tempDir);
      } catch (cleanupError) {
        logger.warn(
          `Failed to cleanup restic temp dir ${tempDir}: ${cleanupError}`,
        );
      }
    }
  }

  isAvailable(): boolean {
    return !!(this.config.RESTIC_REPOSITORY && this.config.RESTIC_PASSWORD);
  }

  private normalizePath(value: string | undefined): string {
    if (!value) {
      return "";
    }
    return value.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  private parseExtraOptions(value: string | undefined): string[] {
    if (!value) {
      return [];
    }
    return (
      value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => {
        if (
          (token.startsWith('"') && token.endsWith('"')) ||
          (token.startsWith("'") && token.endsWith("'"))
        ) {
          return token.slice(1, -1);
        }
        return token;
      }) ?? []
    );
  }

  private runRestic(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        RESTIC_REPOSITORY: this.config.RESTIC_REPOSITORY,
        RESTIC_PASSWORD: this.config.RESTIC_PASSWORD,
      };

      const extraArgs = this.parseExtraOptions(this.config.RESTIC_OPTIONS);
      const fullArgs = [...args, ...extraArgs];

      const child = spawn("restic", fullArgs, { env });
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(
              `restic ${args[0]} exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
            ),
          );
        }
      });
    });
  }
}
