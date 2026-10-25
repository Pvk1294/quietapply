import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a CLI, optionally writing stdin and teeing stdout to a log file. On timeout it sends SIGTERM first
 * (so the CLI can stop its own child processes and browser), then SIGKILL a minute later.
 */
export function run(
  command: string,
  args: string[],
  opts: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; logPath?: string } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const log = opts.logPath ? createWriteStream(opts.logPath, { flags: "a", mode: 0o600 }) : undefined;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      log?.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 60_000).unref();
        }, opts.timeoutMs)
      : undefined;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      log?.end();
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      log?.end();
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Whether a command exists on PATH, with its --version output. */
export async function version(command: string, args = ["--version"]): Promise<string | undefined> {
  try {
    const r = await run(command, args, { timeoutMs: 15_000 });
    return r.code === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : undefined;
  } catch {
    return undefined;
  }
}
