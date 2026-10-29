import { describe, expect, it } from "vitest";
import { allowedTools, agentArgs as claudeArgs, parseStreamResult } from "../src/providers/claude-code.js";
import { agentArgs as codexArgs, locateCodex, parseJsonl } from "../src/providers/codex.js";
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
    expect(args).toContain("--ignore-user-config");
    // codex exec cancels MCP calls that need approval, so our own two servers are pre-approved.
    expect(args).toContain('mcp_servers.desk.default_tools_approval_mode="approve"');
    expect(args).toContain('mcp_servers.playwright.default_tools_approval_mode="approve"');
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

describe("finding the Codex CLI", () => {
  const app = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
  const only =
    (...files: string[]) =>
    (f: string) =>
      files.includes(f);

  it("prefers QUIETAPPLY_CODEX_BIN, then codex.path in the config", () => {
    expect(locateCodex({ env: { QUIETAPPLY_CODEX_BIN: "/x/codex" }, configured: "/y/codex" })).toEqual({
      path: "/x/codex",
      via: "env",
    });
    expect(locateCodex({ env: {}, configured: "~/bin/codex", home: "/Users/jane" })).toEqual({
      path: "/Users/jane/bin/codex",
      via: "config",
    });
  });
  it("uses codex on PATH before the desktop app", () => {
    const r = locateCodex({
      env: { PATH: "/usr/bin:/opt/homebrew/bin" },
      platform: "darwin",
      home: "/Users/jane",
      exists: only("/opt/homebrew/bin/codex", app),
    });
    expect(r).toEqual({ path: "/opt/homebrew/bin/codex", via: "path" });
  });
  it("falls back to the copy inside the ChatGPT or Codex app on macOS", () => {
    const base = { env: { PATH: "/usr/bin" }, platform: "darwin" as const, home: "/Users/jane" };
    expect(locateCodex({ ...base, exists: only(app) })).toEqual({ path: app, via: "app" });
    const codexApp = "/Users/jane/Applications/Codex.app/Contents/Resources/codex";
    expect(locateCodex({ ...base, exists: only(codexApp) })).toEqual({ path: codexApp, via: "app" });
    expect(locateCodex({ ...base, exists: () => false })).toBeUndefined();
  });
  it("looks in app bundles only on macOS", () => {
    expect(locateCodex({ env: { PATH: "/usr/bin" }, platform: "linux", exists: only(app) })).toBeUndefined();
  });
});
