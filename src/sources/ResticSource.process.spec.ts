import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "../Config";
import { ResticSource } from "./ResticSource";

/**
 * Some sandboxed agent environments allow checking whether a PID exists but
 * refuse to deliver signals to other processes (EPERM/EACCES). The kill-based
 * regression test cannot exercise anything there, so it is skipped; CI runners
 * allow signalling child processes and run it.
 */
function canSignalChildProcesses(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    const probe = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 2000)"],
      { detached: true, stdio: "ignore" },
    );
    if (probe.pid === undefined) {
      return false;
    }
    try {
      process.kill(-probe.pid, "SIGKILL");
      probe.unref();
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        probe.unref();
        return false;
      }
      // ESRCH: the probe exited before the signal arrived; retry once.
    }
  }
  return false;
}

const signalsAvailable = canSignalChildProcesses();
if (!signalsAvailable) {
  console.warn(
    "Skipping the restic process-group cleanup test: this environment does not permit signalling child processes.",
  );
}

const describePosix =
  process.platform === "win32" || !signalsAvailable
    ? describe.skip
    : describe;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
  // A killed child can linger as a zombie until its new parent reaps it;
  // a zombie no longer runs code and is not an orphan.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim()[0] !== "Z";
  } catch {
    return true;
  }
}

async function waitForPid(file: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (/^\d+$/.test(raw)) {
        return Number(raw);
      }
    }
    await delay(25);
  }
  throw new Error(`orphan child pid file ${file} was not written`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`orphan restic child ${pid} is still alive`);
}

describePosix("ResticSource process cleanup (POSIX)", () => {
  let tmpDir: string;
  let originalPath: string | undefined;
  let pidFile: string;
  let source: ResticSource;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restic-source-proc-"));
    pidFile = path.join(tmpDir, "child.pid");
    originalPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.RESTIC_TEST_CHILD_PID_FILE = pidFile;

    const config = new Config();
    config.RESTIC_REPOSITORY = "/tmp/restic-repo";
    config.RESTIC_PASSWORD = "restic-pass";
    config.RESTIC_PATH = "secrets";
    config.RESTIC_TIMEOUT_SECONDS = 0.2;
    config.RESTIC_RETRIES = 0;
    config.RESTIC_MAX_SNAPSHOT_AGE_SECONDS = 0;
    source = new ResticSource(config);
  });

  afterEach(() => {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    process.env.PATH = originalPath;
    delete process.env.RESTIC_TEST_CHILD_PID_FILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    "kills the whole process group on timeout, leaving no orphan child",
    async () => {
      const scriptPath = path.join(tmpDir, "restic");
      fs.writeFileSync(
        scriptPath,
        [
          "#!/bin/sh",
          "sleep 300 &",
          'echo $! > "$RESTIC_TEST_CHILD_PID_FILE"',
          "wait",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      await expect(source.fetchSecret("name-a")).rejects.toThrow(/timed out/);

      const childPid = await waitForPid(pidFile);
      await waitForProcessExit(childPid);
    },
    15000,
  );
});
