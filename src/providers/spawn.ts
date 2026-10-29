import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { extname, win32 } from "node:path";

export interface PlatformContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  readFile?: (file: string) => string;
  /** The Node.js binary that runs an npm shim's script. */
  node?: string;
}

/**
 * Find a command the way a shell would. On Windows a bare name ("claude", "npx") is looked up on PATH with
 * each PATHEXT extension, so npm's `.cmd` shims and `.exe` files are both found. Elsewhere it is returned
 * as is (spawn searches PATH itself).
 */
export function resolveCommand(command: string, o: PlatformContext = {}): string {
  const platform = o.platform ?? process.platform;
  if (platform !== "win32") return command;
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  // Windows file names are case-insensitive, so ".CMD" from PATHEXT is written as ".cmd".
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const candidates = (base: string) =>
    extname(base) ? [base, ...exts.map((e) => base + e)] : exts.map((e) => base + e);
  if (/[\\/]/.test(command)) return candidates(command).find(exists) ?? command;
  for (const dir of (env.PATH ?? env.Path ?? "").split(";").filter(Boolean))
    for (const file of candidates(win32.join(dir, command))) if (exists(file)) return file;
  return command;
}

/** cmd.exe metacharacters, escaped with ^ (the same set cross-spawn escapes). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quote one argument for `cmd.exe /d /s /c "..."` so it reaches the program unchanged. */
export function quoteForCmd(arg: string, shim: boolean): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(CMD_META, "^$1");
  // An npm .cmd shim passes %* through cmd once more, so its arguments are escaped twice.
  return shim ? quoted.replace(CMD_META, "^$1") : quoted;
}

/** The `.js` file an npm-generated `.cmd` shim runs (`"%dp0%\node_modules\...\cli.js" %*`), if it exists. */
export function shimTarget(file: string, o: PlatformContext = {}): string | undefined {
  const read = o.readFile ?? ((f: string) => readFileSync(f, "utf8"));
  const exists = o.exists ?? existsSync;
  let text: string;
  try {
    text = read(file);
  } catch {
    return undefined;
  }
  const m = /"%~?dp0%?\\?([^"%]+\.[cm]?js)"/i.exec(text);
  if (!m) return undefined;
  const script = win32.join(win32.dirname(file), m[1]!);
  return exists(script) ? script : undefined;
}

/**
 * How to start `command` on this platform. Windows cannot spawn a `.cmd` or `.bat` file directly (Node
 * refuses since its April 2024 security fix), and npm installs CLIs such as claude, codex and npx as
 * `.cmd` shims. A shim that only starts a Node script is unwrapped and the script runs under Node
 * directly. Any other batch file goes through `cmd.exe /d /s /c` with every argument escaped.
 */
export function spawnPlan(
  command: string,
  args: string[],
  o: PlatformContext = {},
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if ((o.platform ?? process.platform) !== "win32") return { command, args };
  const file = resolveCommand(command, o);
  // Windows ignores a #! line, so a Node script given as the command runs under Node.
  if (/\.[cm]?js$/i.test(file)) return { command: o.node ?? process.execPath, args: [file, ...args] };
  if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args };
  const script = shimTarget(file, o);
  if (script) return { command: o.node ?? process.execPath, args: [script, ...args] };
  const line = [file.replace(CMD_META, "^$1"), ...args.map((a) => quoteForCmd(a, true))].join(" ");
  return {
    command: (o.env ?? process.env).ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * How an MCP client (Claude Code, Codex) should start `npx`. They spawn MCP servers without a shell, and
 * on Windows npx is a `.cmd` shim, so there it goes through `cmd /c`.
 */
export function npxCommand(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  return platform === "win32" ? { command: "cmd", args: ["/c", "npx"] } : { command: "npx", args: [] };
}

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
    const plan = spawnPlan(command, args, { env: opts.env });
    const child = spawn(plan.command, plan.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: true,
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
