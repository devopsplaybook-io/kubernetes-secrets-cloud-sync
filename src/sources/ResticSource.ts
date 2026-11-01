import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
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
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 172800;
const DEFAULT_MAX_OUTPUT_BYTES = 8388608;

/** Spawn failures worth retrying: the process table / file descriptors were temporarily exhausted. */
const TRANSIENT_SPAWN_CODES = new Set(["EAGAIN", "EMFILE", "ENFILE"]);

/** stderr fragments of restic exit-1 failures that a retry may fix. */
const TRANSIENT_STDERR_MARKERS = [
  "connection reset",
  "connection refused",
  "timed out",
  "timeout",
  "network is unreachable",
  "network unreachable",
  "no such host",
  "tls handshake",
  "too many requests",
  "429",
  "internal server error",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "temporary failure",
  "repository locked",
  "repository is already locked",
];

/** stderr fragments of exit-1 failures caused by configuration or credentials. */
const PERMANENT_STDERR_MARKERS = [
  "wrong password",
  "repository does not exist",
  "does not exist",
  "no such file",
  "access denied",
  "permission denied",
  "unauthorized",
  "invalid credentials",
  "unknown flag",
  "unknown argument",
  "invalid argument",
];

interface ResticSnapshot {
  id?: string;
  short_id?: string;
  time?: string;
}

/** Error enriched with the data needed to decide whether a retry can help. */
interface ResticError extends Error {
  resticTransient?: boolean;
  resticExitCode?: number | null;
  resticStderr?: string;
}

/** Classify a non-zero restic exit: true only when a retry can plausibly help. */
function classifyExitFailure(exitCode: number, stderr: string): boolean {
  // 11 = repository lock could not be acquired; worth retrying.
  if (exitCode === 11) {
    return true;
  }
  // 2 = usage error, 3 = backend error without a transient wording, 10 = repository
  // missing, 12 = wrong password, 130 = cancelled: all need operator action.
  if (exitCode !== 1) {
    return false;
  }
  const text = stderr.toLowerCase();
  if (PERMANENT_STDERR_MARKERS.some((marker) => text.includes(marker))) {
    return false;
  }
  return TRANSIENT_STDERR_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Restic secret source implementation.
 *
 * A sync cycle resolves the newest snapshot once (`restic snapshots --json`,
 * optionally filtered by host/tag/path) and every secret is streamed from that
 * snapshot with `restic dump` (`/<RESTIC_PATH>/<secretName>.json`). No
 * full-snapshot restore and no temporary plaintext files are involved. The
 * resolved snapshot must be newer than `RESTIC_MAX_SNAPSHOT_AGE_SECONDS`, and
 * restic output is bounded by `RESTIC_MAX_OUTPUT_BYTES` per stream.
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
        this.buildSnapshotArgs(),
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

      const snapshotTime = Date.parse(newest.time ?? "");
      const maxAgeSeconds = this.getMaxSnapshotAgeSeconds();
      let ageDescription = "age not checked";
      if (maxAgeSeconds > 0) {
        if (!Number.isFinite(snapshotTime)) {
          throw new Error(
            `Newest restic snapshot ${newest.id} has no parseable time (${newest.time ?? "missing"}), so its freshness cannot be verified against RESTIC_MAX_SNAPSHOT_AGE_SECONDS=${maxAgeSeconds}; refusing to apply stale secrets`,
          );
        }
        const ageSeconds = Math.round((Date.now() - snapshotTime) / 1000);
        if (ageSeconds > maxAgeSeconds) {
          throw new Error(
            `Newest restic snapshot ${newest.id} from ${newest.time} is ${ageSeconds}s old, above RESTIC_MAX_SNAPSHOT_AGE_SECONDS=${maxAgeSeconds}; refusing to apply stale secrets`,
          );
        }
        ageDescription = `age ${ageSeconds}s`;
      }
      this.snapshotId = newest.id;
      logger.info(
        `Resolved restic snapshot ${(newest.short_id ?? newest.id).slice(0, 8)} (${newest.time ?? "unknown time"}, ${ageDescription}) for ${secretNames.length} secret name(s)`,
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

  private getMaxSnapshotAgeSeconds(): number {
    const seconds = Number(this.config.RESTIC_MAX_SNAPSHOT_AGE_SECONDS);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
    }
    return Math.floor(seconds);
  }

  private getMaxOutputBytes(): number {
    const bytes = Number(this.config.RESTIC_MAX_OUTPUT_BYTES);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return DEFAULT_MAX_OUTPUT_BYTES;
    }
    return Math.floor(bytes);
  }

  /** `snapshots` arguments, including the optional host/tag/path filters. */
  private buildSnapshotArgs(): string[] {
    const args = ["snapshots", "--json"];
    const host = String(this.config.RESTIC_HOST ?? "").trim();
    if (host) {
      args.push(`--host=${host}`);
    }
    const tag = String(this.config.RESTIC_TAG ?? "").trim();
    if (tag) {
      args.push(`--tag=${tag}`);
    }
    // RESTIC_SNAPSHOT_PATH filters the snapshots; RESTIC_PATH is the
    // in-snapshot folder used by `dump`, so the two must stay separate.
    const snapshotPath = String(this.config.RESTIC_SNAPSHOT_PATH ?? "").trim();
    if (snapshotPath) {
      args.push(`--path=${snapshotPath}`);
    }
    return args;
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

  /** Only failures that a retry can plausibly fix are retried. */
  private isTransientError(error: unknown): boolean {
    const classified = error as ResticError | undefined;
    if (classified && typeof classified.resticTransient === "boolean") {
      return classified.resticTransient;
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return typeof code === "string" && TRANSIENT_SPAWN_CODES.has(code);
  }

  private killProcessGroup(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined || process.platform === "win32") {
      this.killDirectChild(child);
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      logger.warn(
        `Failed to kill restic process group ${pid}: ${error}; falling back to the direct child`,
      );
      this.killDirectChild(child);
    }
  }

  private killDirectChild(child: ChildProcess): void {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      logger.warn(`Failed to kill restic process: ${error}`);
    }
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
        if (attempt >= retries || !this.isTransientError(error)) {
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
      const maxOutputBytes = this.getMaxOutputBytes();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        RESTIC_REPOSITORY: this.config.RESTIC_REPOSITORY,
        RESTIC_PASSWORD: this.config.RESTIC_PASSWORD,
      };

      const extraArgs = this.parseExtraOptions(this.config.RESTIC_OPTIONS);
      const fullArgs = [...args, ...extraArgs];

      // detached: true puts restic in its own process group, so a timeout or
      // abort can kill the whole tree (restic may spawn rclone or ssh).
      const child = spawn("restic", fullArgs, { env, detached: true });
      // StringDecoder keeps incomplete multi-byte UTF-8 sequences between
      // chunks instead of turning them into U+FFFD replacement characters.
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const commandError = (
        message: string,
        transient: boolean,
        extra?: { exitCode?: number | null; stderr?: string },
      ): ResticError => {
        const error = new Error(message) as ResticError;
        error.resticTransient = transient;
        if (extra) {
          error.resticExitCode = extra.exitCode;
          error.resticStderr = extra.stderr;
        }
        return error;
      };

      const finish = (settle: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        settle();
      };

      const failOutputLimit = (stream: "stdout" | "stderr") => {
        finish(() => {
          this.killProcessGroup(child);
          reject(
            commandError(
              `restic ${args[0]} output exceeded the RESTIC_MAX_OUTPUT_BYTES limit of ${maxOutputBytes} bytes (${stream})`,
              false,
            ),
          );
        });
      };

      const onAbort = () => {
        finish(() => {
          this.killProcessGroup(child);
          reject(this.abortError(signal));
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        finish(() => {
          this.killProcessGroup(child);
          reject(
            commandError(
              `restic ${args[0]} timed out after ${timeoutMs}ms`,
              true,
            ),
          );
        });
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          failOutputLimit("stdout");
          return;
        }
        stdout += stdoutDecoder.write(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        stderrBytes += chunk.length;
        if (stderrBytes > maxOutputBytes) {
          failOutputLimit("stderr");
          return;
        }
        stderr += stderrDecoder.write(chunk);
      });
      child.on("error", (err) => {
        finish(() => {
          const spawnError = err as ResticError & NodeJS.ErrnoException;
          spawnError.resticTransient =
            typeof spawnError.code === "string" &&
            TRANSIENT_SPAWN_CODES.has(spawnError.code);
          reject(spawnError);
        });
      });
      child.on("close", (code) => {
        finish(() => {
          stdout += stdoutDecoder.end();
          stderr += stderrDecoder.end();
          if (code === 0) {
            resolve(stdout);
            return;
          }
          const rawStderr = stderr.trim() || stdout.trim();
          reject(
            commandError(
              `restic ${args[0]} exited with code ${code}: ${this.sanitizeOutput(rawStderr)}`,
              typeof code === "number" ? classifyExitFailure(code, rawStderr) : false,
              { exitCode: code, stderr: rawStderr },
            ),
          );
        });
      });
    });
  }
}
