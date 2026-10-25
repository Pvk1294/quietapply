import { describe, expect, it } from "vitest";
import { allowedTools, agentArgs as claudeArgs, parseStreamResult } from "../src/providers/claude-code.js";
import { agentArgs as codexArgs, parseJsonl } from "../src/providers/codex.js";
import type { AgentRunOptions } from "../src/providers/types.js";

const opts: AgentRunOptions = {
  prompt: "apply",
  mcpServers: {
    desk: {
      command: "node",
      args: ["cli.js", "mcp", "--application", "7"],
      env: { QUIETAPPLY_HOME: "/tmp/qa" },
    },
    playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.83"] },
  },
  browser: "playwright-profile",
  cwd: "/tmp",
  timeoutMs: 1000,
  logPath: "/tmp/log",
};

describe("Claude Code provider", () => {
  it("runs unattended with only the desk and browser tools", () => {
    const args = claudeArgs(opts, "/tmp/mcp.json");
    expect(args).toEqual(
      expect.arrayContaining(["-p", "--strict-mcp-config", "--permission-mode", "dontAsk"]),
    );
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__desk__*,mcp__playwright__*");
    expect(args).not.toContain("--chrome");
  });
  it("adds Claude in Chrome when chosen", () => {
    const o = { ...opts, browser: "claude-in-chrome" as const, mcpServers: { desk: opts.mcpServers.desk! } };
    expect(claudeArgs(o, "/tmp/mcp.json")).toContain("--chrome");
    expect(allowedTools(o)).toEqual(["mcp__desk__*", "mcp__claude-in-chrome__*"]);
  });
  it("reads the result and spots usage limits", () => {
    const ok = '{"type":"system"}\n{"type":"result","is_error":false,"result":"Filled 1 form"}\n';
    expect(parseStreamResult(ok)).toEqual({ text: "Filled 1 form", isError: false, usageLimit: false });
    const limit = '{"type":"result","is_error":true,"result":"You\'ve hit your limit · resets 5pm"}';
    expect(parseStreamResult(limit).usageLimit).toBe(true);
    expect(parseStreamResult("garbage").isError).toBe(true);
  });
});

describe("Codex provider", () => {
  it("passes MCP servers as config overrides without touching config.toml", () => {
    const args = codexArgs(opts, "/tmp/last.txt");
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain('mcp_servers.desk.command="node"');
    expect(args).toContain('mcp_servers.desk.args=["cli.js","mcp","--application","7"]');
    expect(args).toContain('mcp_servers.desk.env={ QUIETAPPLY_HOME="/tmp/qa" }');
    expect(args.at(-1)).toBe("-");
  });
  it("reads the last agent message and failures from JSONL", () => {
    const out = [
      '{"type":"thread.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Done: 1 dry run"}}',
      '{"type":"turn.completed"}',
    ].join("\n");
    expect(parseJsonl(out)).toEqual({ text: "Done: 1 dry run", failed: false, error: "" });
    expect(parseJsonl('{"type":"turn.failed","error":{"message":"quota exceeded"}}')).toMatchObject({
      failed: true,
      error: "quota exceeded",
    });
  });
});
