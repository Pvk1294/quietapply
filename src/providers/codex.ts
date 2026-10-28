import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { loadConfig } from "../core/config.js";
import { run, version } from "./spawn.js";
import {
  type AgentRunOptions,
  type AgentRunResult,
  type Detection,
  type Provider,
  USAGE_LIMIT_RE,
} from "./types.js";

/**
 * Where the desktop apps keep their own copy of the Codex CLI (macOS). The ChatGPT app path was checked on
 * ChatGPT 1.2026.x (codex-cli 0.163); the Codex app paths are the same layout and its older single file.
 */
export const MAC_APP_BUNDLES = [
  "ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "Codex.app/Contents/Resources/codex-cli/bin/codex",
  "Codex.app/Contents/Resources/codex",
];

export interface CodexLocation {
  path: string;
  via: "env" | "config" | "path" | "app";
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the Codex CLI: QUIETAPPLY_CODEX_BIN, then `codex.path` in config.yaml, then PATH, then the copy
 * shipped inside the ChatGPT or Codex desktop app (in /Applications or ~/Applications). Undefined when
 * none exists; an explicit setting that points nowhere is still returned so the error names it.
 */
export function locateCodex(
  o: {
    configured?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
    exists?: (file: string) => boolean;
  } = {},
): CodexLocation | undefined {
  const env = o.env ?? process.env;
  const exists = o.exists ?? isExecutable;
  if (env.QUIETAPPLY_CODEX_BIN) return { path: env.QUIETAPPLY_CODEX_BIN, via: "env" };
  if (o.configured) return { path: o.configured.replace(/^~(?=\/)/, o.home ?? homedir()), via: "config" };
  const platform = o.platform ?? process.platform;
  const names = platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];
  for (const dir of (env.PATH ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean))
    for (const name of names) if (exists(join(dir, name))) return { path: join(dir, name), via: "path" };
  if (platform === "darwin")
    for (const root of ["/Applications", join(o.home ?? homedir(), "Applications")])
      for (const rel of MAC_APP_BUNDLES)
        if (exists(join(root, rel))) return { path: join(root, rel), via: "app" };
  return undefined;
}

function configuredPath(): string | undefined {
  try {
    return loadConfig().codex.path;
  } catch {
    return undefined;
  }
}

/** The command to run; plain "codex" when nothing was found, so the spawn error is the usual one. */
export function codexBin(): string {
  return locateCodex({ configured: configuredPath() })?.path ?? "codex";
}

/** TOML literal for a `-c key=value` override. */
const toml = (v: unknown) => JSON.stringify(v);

/**
 * argv for `codex exec`. MCP servers are passed as `-c mcp_servers.<name>.*` overrides so nothing is
 * written into the user's ~/.codex/config.toml, and that file is not loaded either (login still works), so
 * the user's own MCP servers and settings stay out of application runs.
 *
 * `codex exec` has no one to ask, so an MCP call that needs approval is cancelled
 * (https://github.com/openai/codex/issues/24135). Our two servers are pre-approved with
 * `default_tools_approval_mode = "approve"`; nothing else is reachable, and shell commands stay read-only.
 */
export function agentArgs(opts: AgentRunOptions, lastMessagePath: string): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "-o",
    lastMessagePath,
  ];
  for (const [name, spec] of Object.entries(opts.mcpServers)) {
    args.push("-c", `mcp_servers.${name}.command=${toml(spec.command)}`);
    args.push("-c", `mcp_servers.${name}.args=${toml(spec.args)}`);
    args.push("-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`);
    // npx may need a few seconds to start Playwright MCP; the default is 10.
    args.push("-c", `mcp_servers.${name}.startup_timeout_sec=60`);
    if (spec.env && Object.keys(spec.env).length) {
      const env = Object.entries(spec.env)
        .map(([k, v]) => `${k}=${toml(v)}`)
        .join(", ");
      args.push("-c", `mcp_servers.${name}.env={ ${env} }`);
    }
  }
  if (opts.model) args.push("-m", opts.model);
  args.push("-");
  return args;
}

/** The final agent message and any failure from a `codex exec --json` transcript. */
export function parseJsonl(stdout: string): { text: string; failed: boolean; error: string } {
  let text = "";
  let failed = false;
  let error = "";
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: string };
        error?: { message?: string };
        message?: string;
      };
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = ev.item.text ?? text;
      if (ev.type === "turn.failed" || ev.type === "error") {
        failed = true;
        error = ev.error?.message ?? ev.message ?? error;
      }
    } catch {
      // partial line
    }
  }
  return { text, failed, error };
}

export const codex: Provider = {
  id: "codex",
  label: "OpenAI Codex",

  async detect(): Promise<Detection> {
    const found = locateCodex({ configured: configuredPath() });
    const bin = found?.path ?? "codex";
    const v = await version(bin);
    if (!v)
      return {
        installed: false,
        notes: [
          found?.via === "config" || found?.via === "env"
            ? `Codex not found at ${bin}. Fix codex.path in config.yaml.`
            : "Install Codex CLI (npm install -g @openai/codex) or the ChatGPT desktop app, or set codex.path in config.yaml",
        ],
      };
    const notes: string[] = [];
    if (found?.via === "app") notes.push(`using the Codex CLI inside the desktop app: ${bin}`);
    let loggedIn: boolean | undefined;
    let authMethod: Detection["authMethod"] = "unknown";
    try {
      const r = await run(bin, ["login", "status"], { timeoutMs: 20_000 });
      const out = `${r.stdout}\n${r.stderr}`;
      loggedIn = r.code === 0 && !/not logged in/i.test(out);
      authMethod = /chatgpt/i.test(out) ? "subscription" : /api key/i.test(out) ? "api-key" : "unknown";
    } catch {
      // older CLI without `login status`
    }
    if (process.env.CODEX_API_KEY) authMethod = "api-key";
    if (loggedIn === false) notes.push("Not signed in. Run `codex login`, or set CODEX_API_KEY.");
    return { installed: true, version: v, loggedIn, authMethod, notes };
  },

  async complete(prompt, opts = {}) {
    const args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral"];
    if (opts.model) args.push("-m", opts.model);
    args.push("-");
    const r = await run(codexBin(), args, { input: prompt, timeoutMs: opts.timeoutMs ?? 180_000 });
    if (r.code !== 0) throw new Error(`codex exited with ${r.code}: ${r.stderr.slice(0, 300)}`);
    return r.stdout.trim();
  },

  async runAgent(opts): Promise<AgentRunResult> {
    const last = join(opts.cwd, "last-message.txt");
    const r = await run(codexBin(), agentArgs(opts, last), {
      input: opts.prompt,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      logPath: opts.logPath,
    });
    if (r.timedOut) return { status: "timed_out", text: "The run hit its time limit.", exitCode: r.code };
    const res = parseJsonl(r.stdout);
    let text = res.text;
    try {
      text = readFileSync(last, "utf8").trim() || text;
    } catch {
      // no final message written
    }
    const usage = USAGE_LIMIT_RE.test(`${res.error}\n${r.stderr}`);
    const status = usage ? "usage_limit" : res.failed || r.code !== 0 ? "failed" : "completed";
    return { status, text: text || res.error || r.stderr.slice(0, 500), exitCode: r.code };
  },
};
