import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run, version } from "./spawn.js";
import {
  type AgentRunOptions,
  type AgentRunResult,
  type Detection,
  type Provider,
  USAGE_LIMIT_RE,
} from "./types.js";

const BIN = process.env.QUIETAPPLY_CODEX_BIN ?? "codex";

/** TOML literal for a `-c key=value` override. */
const toml = (v: unknown) => JSON.stringify(v);

/**
 * argv for `codex exec`. MCP servers are passed as `-c mcp_servers.<name>.*` overrides so nothing is
 * written into the user's ~/.codex/config.toml.
 */
export function agentArgs(opts: AgentRunOptions, lastMessagePath: string): string[] {
  const args = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-o", lastMessagePath];
  for (const [name, spec] of Object.entries(opts.mcpServers)) {
    args.push("-c", `mcp_servers.${name}.command=${toml(spec.command)}`);
    args.push("-c", `mcp_servers.${name}.args=${toml(spec.args)}`);
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
    const v = await version(BIN);
    if (!v) return { installed: false, notes: ["Install Codex CLI: npm install -g @openai/codex"] };
    const notes: string[] = [];
    let loggedIn: boolean | undefined;
    let authMethod: Detection["authMethod"] = "unknown";
    try {
      const r = await run(BIN, ["login", "status"], { timeoutMs: 20_000 });
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
    const r = await run(BIN, args, { input: prompt, timeoutMs: opts.timeoutMs ?? 180_000 });
    if (r.code !== 0) throw new Error(`codex exited with ${r.code}: ${r.stderr.slice(0, 300)}`);
    return r.stdout.trim();
  },

  async runAgent(opts): Promise<AgentRunResult> {
    const last = join(opts.cwd, "last-message.txt");
    const r = await run(BIN, agentArgs(opts, last), {
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
