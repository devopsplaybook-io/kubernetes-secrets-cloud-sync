import { spawn } from "child_process";
import { BaseSecretSource, SecretFetchOptions } from "./SecretSource";
import { Config } from "../Config";
import { OTelLogger, toError } from "../OTelContext";
import { maskUrlUserinfo, sanitizeResticOutput } from "../Redaction";
import { SecretFetchResult } from "../types";

const logger = OTelLogger().createModuleLogger("restic-source");

/** Secret names and RESTIC_PATH segments must match this pattern. */
export const RESTIC_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;
const RETRY_BASE_DELAY_MS = 500;
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_RETRIES = 2;

interface ResticSnapshot {
  id?: string;
  short_id?: string;
  time?: string;
}

/**
 * Restic secret source implementation.
 *
 * A sync cycle resolves the newest snapshot once (`restic snapshots --json`)
 * and every secret is streamed from that snapshot with `restic dump`
 * (`/<RESTIC_PATH>/<secretName>.json`). No full-snapshot restore and no
 * temporary plaintext files are involved.
 *
 * Annotation key: secrets.cloudsync.devopsplaybook.io/restic
 * Annotation value: comma-separated list of secret names (each maps to
 * `<secretName>.json` inside the snapshot).
 */
export class ResticSource extends BaseSecretSource {
  readonly providerName = "restic";
  private readonly config: Config;
  private snapshotId?: string;
  private cycleError?: Error;

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
        `Restic source initialized (repository: ${maskUrlUserinfo(this.config.RESTIC_REPOSITORY)})`,
      );
    } catch (error) {
      logger.error("Restic CLI not available", toError(error));
    }
  }

  /**
   * Resolve the newest snapshot for the upcoming cycle. Failures are recorded
   * and re-thrown per secret by `fetchSecret`, so a broken repository does not
   * spawn one restic process per requested secret.
   */
  async beginCycle(
    secretNames: string[],
    options?: SecretFetchOptions,
  ): Promise<void> {
    this.snapshotId = undefined;
    this.cycleError = undefined;
    options?.signal?.throwIfAborted();

    try {
      const stdout = await this.runRestic(
        ["snapshots", "--json"],
        options?.signal,
      );
      let snapshots: unknown;
      try {
        snapshots = JSON.parse(stdout);
      } catch (err) {
        const error = new Error(`restic snapshots returned invalid JSON: ${err}`);
        (error as Error & { cause?: unknown }).cause = err;
        throw error;
      }
      if (!Array.isArray(snapshots) || snapshots.length === 0) {
        throw new Error("restic snapshots returned no snapshots");
      }

      const usable = (snapshots as ResticSnapshot[]).filter(
        (candidate): candidate is ResticSnapshot & { id: string } =>
          !!candidate &&
          typeof candidate.id === "string" &&
          candidate.id.length > 0,
      );
      if (usable.length === 0) {
        throw new Error("restic snapshots returned no usable snapshot id");
      }

      let newest = usable[0];
      for (const candidate of usable.slice(1)) {
        const candidateTime = Date.parse(candidate.time ?? "");
        const newestTime = Date.parse(newest.time ?? "");
        if (
          Number.isFinite(candidateTime) &&
          (!Number.isFinite(newestTime) ||
            candidateTime > newestTime ||
            (candidateTime === newestTime && candidate.id > newest.id))
        ) {
          newest = candidate;
        }
      }

      this.snapshotId = newest.id;
      logger.info(
        `Resolved restic snapshot ${(newest.short_id ?? newest.id).slice(0, 8)} (${newest.time ?? "unknown time"}) for ${secretNames.length} secret name(s)`,
      );
    } catch (error) {
      this.cycleError =
        error instanceof Error ? error : new Error(String(error));
      logger.error(
        "Failed to resolve the restic snapshot; restic secrets will fail this cycle",
        this.cycleError,
      );
    }
  }

  endCycle(): void {
    this.snapshotId = undefined;
    this.cycleError = undefined;
  }

  async fetchSecret(
    secretName: string,
    options?: SecretFetchOptions,
  ): Promise<SecretFetchResult> {
    if (!this.isAvailable()) {
      throw new Error("Restic source not configured");
    }
    options?.signal?.throwIfAborted();
    if (this.cycleError) {
      throw this.cycleError;
    }

    this.validateRelativePath(secretName, "restic secret name");
    const subPath = this.normalizePath(this.config.RESTIC_PATH);
    if (subPath) {
      this.validateRelativePath(subPath, "RESTIC_PATH");
    }
    const relative = subPath ? `${subPath}/${secretName}` : secretName;
    this.validateRelativePath(relative, "restic secret path");
    const includePattern = `/${relative}.json`;

    logger.info(
      `Fetching secret ${secretName} from restic snapshot ${this.snapshotId ?? "latest"} (dump: ${includePattern})`,
    );

    const stdout = await this.runRestic(
      ["dump", this.snapshotId ?? "latest", includePattern],
      options?.signal,
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
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
  }

  isAvailable(): boolean {
    return !!(this.config.RESTIC_REPOSITORY && this.config.RESTIC_PASSWORD);
  }

  private normalizePath(value: string | undefined): string {
    if (!value) {
      return "";
    }
    return value
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\/{2,}/g, "/");
  }

  private validateRelativePath(value: string, label: string): void {
    if (!value) {
      throw new Error(`${label} must not be empty`);
    }
    if (!RESTIC_NAME_PATTERN.test(value)) {
      throw new Error(
        `Invalid ${label} "${value}": only letters, digits, ".", "_", "-" and "/" are allowed`,
      );
    }
    if (value.startsWith("/") || value.endsWith("/")) {
      throw new Error(
        `Invalid ${label} "${value}": leading and trailing slashes are not allowed`,
      );
    }
    for (const segment of value.split("/")) {
      if (segment === "" || segment === "." || segment === "..") {
        throw new Error(
          `Invalid ${label} "${value}": path segments must not be empty, "." or ".."`,
        );
      }
    }
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

  private getTimeoutMs(): number {
    const seconds = Number(this.config.RESTIC_TIMEOUT_SECONDS);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return DEFAULT_TIMEOUT_SECONDS * 1000;
    }
    return seconds * 1000;
  }

  private getRetries(): number {
    const retries = Number(this.config.RESTIC_RETRIES);
    if (!Number.isFinite(retries) || retries < 0) {
      return DEFAULT_RETRIES;
    }
    return Math.floor(retries);
  }

  /** Strip repository credentials from arbitrary restic output. */
  private sanitizeOutput(text: string): string {
    return sanitizeResticOutput(text, {
      repository: this.config.RESTIC_REPOSITORY,
      password: this.config.RESTIC_PASSWORD,
      options: this.config.RESTIC_OPTIONS,
    });
  }

  private sanitizeError(error: unknown): string {
    return this.sanitizeOutput(toError(error).message);
  }

  private abortError(signal: AbortSignal | undefined): Error {
    return signal?.reason instanceof Error
      ? signal.reason
      : new Error("Sync cycle aborted");
  }

  private async runRestic(
    args: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const retries = this.getRetries();
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      signal?.throwIfAborted();
      try {
        return await this.runResticOnce(args, signal);
      } catch (error) {
        lastError = error;
        signal?.throwIfAborted();
        const code = (error as { code?: string })?.code;
        if (code === "ENOENT" || attempt >= retries) {
          throw error;
        }
        const delay =
          RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 250);
        logger.warn(
          `restic ${args[0]} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${this.sanitizeError(error)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  private runResticOnce(
    args: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.getTimeoutMs();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        RESTIC_REPOSITORY: this.config.RESTIC_REPOSITORY,
        RESTIC_PASSWORD: this.config.RESTIC_PASSWORD,
      };

      const extraArgs = this.parseExtraOptions(this.config.RESTIC_OPTIONS);
      const fullArgs = [...args, ...extraArgs];

      const child = spawn("restic", fullArgs, { env, signal });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (settle: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        settle();
      };

      const onAbort = () => {
        finish(() => reject(this.abortError(signal)));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        finish(() => {
          try {
            child.kill("SIGKILL");
          } catch (killError) {
            logger.warn(
              `Failed to kill timed out restic process: ${killError}`,
            );
          }
          reject(
            new Error(`restic ${args[0]} timed out after ${timeoutMs}ms`),
          );
        });
      }, timeoutMs);

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => finish(() => reject(err)));
      child.on("close", (code) => {
        finish(() => {
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(
              new Error(
                `restic ${args[0]} exited with code ${code}: ${this.sanitizeOutput(stderr.trim() || stdout.trim())}`,
              ),
            );
          }
        });
      });
    });
  }
}
