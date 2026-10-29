import { existsSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { CHROME_CLICK_TOOLS, LINKEDIN_CHROME_TOOLS, LINKEDIN_DENIED_CHROME_TOOLS } from "../linkedin/mode.js";
import { chromeGuardSettings } from "../runner/chrome-guard.js";
import { resolveCommand, run, version } from "./spawn.js";
import {
  type AgentRunOptions,
  type AgentRunResult,
  type Detection,
  type McpServerSpec,
  type Provider,
  USAGE_LIMIT_RE,
} from "./types.js";

/**
 * The Claude Code CLI: QUIETAPPLY_CLAUDE_BIN, else "claude" from PATH. On Windows, when it is not on PATH,
 * also the native installer's `%USERPROFILE%\.local\bin\claude.exe` and npm's `%APPDATA%\npm\claude.cmd`.
 */
export function locateClaude(
  o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (f: string) => boolean } = {},
): string {
  const env = o.env ?? process.env;
  if (env.QUIETAPPLY_CLAUDE_BIN) return env.QUIETAPPLY_CLAUDE_BIN;
  if ((o.platform ?? process.platform) !== "win32") return "claude";
  const exists = o.exists ?? existsSync;
  const onPath = resolveCommand("claude", { platform: "win32", env, exists });
  if (onPath !== "claude") return onPath;
  const extra = [
    env.USERPROFILE && win32.join(env.USERPROFILE, ".local", "bin", "claude.exe"),
    env.APPDATA && win32.join(env.APPDATA, "npm", "claude.cmd"),
  ].filter((f): f is string => !!f);
  return extra.find(exists) ?? "claude";
}

const BIN = locateClaude();

/** Tools the agent may call. Built-in file and shell tools are off: it acts only through MCP. */
export function allowedTools(
  opts: Pick<AgentRunOptions, "browser" | "mcpServers" | "linkedin" | "chromeGuardDir">,
): string[] {
  const tools = Object.keys(opts.mcpServers).map((name) => `mcp__${name}__*`);
  if (opts.linkedin) tools.push(...LINKEDIN_CHROME_TOOLS);
  else if (opts.browser === "claude-in-chrome") tools.push("mcp__claude-in-chrome__*");
  return tools;
}

/** Tools refused outright: LinkedIn's long list, and in dry run or review every tool that can click around `computer`. */
export function deniedTools(opts: Pick<AgentRunOptions, "linkedin" | "chromeGuardDir">): string[] {
  return opts.linkedin ? LINKEDIN_DENIED_CHROME_TOOLS : opts.chromeGuardDir ? CHROME_CLICK_TOOLS : [];
}

export function mcpConfigJson(servers: Record<string, McpServerSpec>): string {
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

/** argv for one unattended agent run (`claude -p`, streaming JSON so the log shows every step). */
export function agentArgs(opts: AgentRunOptions, mcpConfigPath: string): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    // Ignore the user's own settings, hooks and MCP servers so runs are reproducible.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--tools",
    "",
    "--allowedTools",
    allowedTools(opts).join(","),
  ];
  const denied = deniedTools(opts);
  if (denied.length) args.push("--disallowedTools", denied.join(","));
  if (opts.browser === "claude-in-chrome" || opts.linkedin) args.push("--chrome");
  if (opts.chromeGuardDir) args.push("--settings", chromeGuardSettings(opts.chromeGuardDir));
  if (opts.model) args.push("--model", opts.model);
  return args;
}

/** The final result event of a stream-json transcript. */
export function parseStreamResult(stdout: string): { text: string; isError: boolean; usageLimit: boolean } {
  let result: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (ev.type === "result") result = ev;
    } catch {
      // partial line
    }
  }
  const text = String(result?.result ?? "");
  const isError = !result || result.is_error === true;
  const usageLimit = result?.api_error === "usage_limit_reached" || (isError && USAGE_LIMIT_RE.test(text));
  return { text, isError, usageLimit };
}

export const claudeCode: Provider = {
  id: "claude-code",
  label: "Claude Code",

  async detect(): Promise<Detection> {
    const v = await version(BIN);
    if (!v) return { installed: false, notes: ["Install Claude Code: https://code.claude.com/docs"] };
    const notes: string[] = [];
    let loggedIn: boolean | undefined;
    let authMethod: Detection["authMethod"] = "unknown";
    try {
      const r = await run(BIN, ["auth", "status"], { timeoutMs: 20_000 });
      const s = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string };
      loggedIn = s.loggedIn;
      authMethod = s.authMethod === "claude.ai" ? "subscription" : s.authMethod ? "api-key" : "unknown";
    } catch {
      if (process.env.ANTHROPIC_API_KEY) authMethod = "api-key";
    }
    if (authMethod === "api-key")
      notes.push("API key login: Claude in Chrome is not available, so the browser will be Playwright.");
    if (loggedIn === false)
      notes.push("Not signed in. Run `claude` once and sign in, or set ANTHROPIC_API_KEY.");
    return { installed: true, version: v, loggedIn, authMethod, notes };
  },

  async complete(prompt, opts = {}) {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
    ];
    if (opts.model) args.push("--model", opts.model);
    const r = await run(BIN, args, { input: prompt, timeoutMs: opts.timeoutMs ?? 180_000 });
    if (r.code !== 0) throw new Error(`claude exited with ${r.code}: ${r.stderr.slice(0, 300)}`);
    const out = JSON.parse(r.stdout) as { result?: string; is_error?: boolean };
    if (out.is_error) throw new Error(out.result ?? "claude returned an error");
    return out.result ?? "";
  },

  async runAgent(opts): Promise<AgentRunResult> {
    const mcpPath = join(opts.cwd, "mcp.json");
    writeFileSync(mcpPath, mcpConfigJson(opts.mcpServers), { mode: 0o600 });
    const r = await run(BIN, agentArgs(opts, mcpPath), {
      input: opts.prompt,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      logPath: opts.logPath,
    });
    if (r.timedOut) return { status: "timed_out", text: "The run hit its time limit.", exitCode: r.code };
    const res = parseStreamResult(r.stdout);
    const status = res.usageLimit ? "usage_limit" : res.isError || r.code !== 0 ? "failed" : "completed";
    return { status, text: res.text || r.stderr.slice(0, 500), exitCode: r.code };
  },
};
