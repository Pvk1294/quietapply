import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { openDb } from "../src/core/db.js";
import { addApplication, getApplication } from "../src/core/store.js";
import { Desk } from "../src/mcp/desk.js";
import { agentArgs, allowedTools, deniedTools } from "../src/providers/claude-code.js";
import { chromeGuardPath, chromeGuardSettings, SUBMIT_LOCK } from "../src/runner/chrome-guard.js";
import { mcpServers } from "../src/runner/run.js";
import { JANE, makeHome } from "./helpers/home.js";

const require = createRequire(import.meta.url);
const hook = require("../browser/chrome-guard.cjs") as {
  decide: (tool: string, input: object, locked: boolean) => string | undefined;
};
const COMPUTER = "mcp__claude-in-chrome__computer";

/** Runs the real hook the way Claude Code does: JSON on stdin, the run folder in the environment. */
function callHook(runDir: string, input: object, tool = COMPUTER) {
  const r = spawnSync("node", [chromeGuardPath()], {
    input: JSON.stringify({ tool_name: tool, tool_input: input }),
    env: { ...process.env, QUIETAPPLY_RUN_DIR: runDir },
    encoding: "utf8",
  });
  return r.stdout ? (JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string } }) : null;
}

describe("dry-run guard for Claude in Chrome", () => {
  it("gives the agent the browser tools minus everything that can click around the guard", () => {
    const o = {
      browser: "claude-in-chrome" as const,
      mcpServers: { desk: { command: "node", args: [] } },
      chromeGuardDir: "/tmp/run-1/app-1",
    };
    expect(deniedTools(o)).toEqual(
      expect.arrayContaining([
        "mcp__claude-in-chrome__javascript_tool",
        "mcp__claude-in-chrome__browser_batch",
      ]),
    );
    const args = agentArgs(
      { ...o, prompt: "", cwd: "/tmp", timeoutMs: 1, logPath: "/tmp/l" },
      "/tmp/mcp.json",
    );
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("shortcuts_execute");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings.hooks.PreToolUse[0].matcher).toBe(COMPUTER);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("chrome-guard.cjs");
    expect(allowedTools(o)).toContain("mcp__claude-in-chrome__*");
    // Live mode after approval: no hook, nothing denied.
    const live = agentArgs(
      { ...o, chromeGuardDir: undefined, prompt: "", cwd: "/tmp", timeoutMs: 1, logPath: "/tmp/l" },
      "/tmp/mcp.json",
    );
    expect(live).not.toContain("--settings");
    expect(live).not.toContain("--disallowedTools");
    expect(chromeGuardSettings("/tmp/x y")).toContain("/tmp/x y");
  });

  it("tells the desk where the run folder is, in Claude in Chrome mode only", () => {
    const p = makeHome({ provider: "claude-code", browser: "claude-in-chrome" });
    const chrome = mcpServers(loadConfig(p), p, 1, true, "/tmp/run-1/app-1");
    expect(chrome.desk?.env?.QUIETAPPLY_RUN_DIR).toBe("/tmp/run-1/app-1");
    expect(chrome.playwright).toBeUndefined();
    const pw = makeHome({ provider: "claude-code" });
    expect(mcpServers(loadConfig(pw), pw, 1, true, "/tmp/run-1/app-1").desk?.env).not.toHaveProperty(
      "QUIETAPPLY_RUN_DIR",
    );
  });

  it("refuses Enter and typed line breaks, and lets ordinary clicks through until the submit step", () => {
    expect(hook.decide(COMPUTER, { action: "key", text: "Enter" }, false)).toMatch(/Enter/);
    expect(hook.decide(COMPUTER, { action: "key", text: "ctrl+Return" }, false)).toBeTruthy();
    expect(hook.decide(COMPUTER, { action: "type", text: "line one\nline two" }, false)).toBeTruthy();
    expect(hook.decide(COMPUTER, { action: "type", text: "plain text" }, false)).toBeUndefined();
    expect(hook.decide(COMPUTER, { action: "left_click", coordinate: [10, 10] }, false)).toBeUndefined();
    expect(hook.decide("mcp__claude-in-chrome__find", { query: "submit" }, true)).toBeUndefined();
  });

  it("locks every click once the desk refused the submit step, and logs each refused action", () => {
    const p = makeHome({ provider: "fake", dryRun: true });
    const db = openDb(p);
    const id = addApplication(db, {
      company: "Hooli",
      title: "Backend Engineer",
      url: "https://job-boards.greenhouse.io/hooli/jobs/1",
      ats: "greenhouse",
    }).id;
    const runDir = mkdtempSync(join(tmpdir(), "qa-guard-"));
    const config = { ...loadConfig(p), dryRun: true };
    const desk = new Desk(db, config, JANE, p, id, { runDir });

    // Before the submit step the agent may click (it is still filling the form).
    expect(callHook(runDir, { action: "left_click", coordinate: [5, 5] })).toBeNull();
    expect(existsSync(join(runDir, SUBMIT_LOCK))).toBe(false);

    // The desk refuses to hand out the submit step: it locks the browser and logs the attempt.
    const filled = [{ field: "Email", value: "jane.doe@example.com", source: "profile:email" }];
    expect(desk.startSubmit(filled)).toMatchObject({ proceed: false, mode: "dry_run" });
    expect(existsSync(join(runDir, SUBMIT_LOCK))).toBe(true);

    // Now any click on a Submit button is refused by the hook; looking is still allowed.
    const click = callHook(runDir, { action: "left_click", ref: "ref_42" });
    expect(click?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(callHook(runDir, { action: "key", text: "Enter" })?.hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
    expect(callHook(runDir, { action: "screenshot" })).toBeNull();

    // Recording a submit that never happened is refused and logged too; the application stays a dry run.
    expect(() => desk.recordResult({ outcome: "submitted", evidence: "Application sent" })).toThrow(
      /nothing may be submitted/,
    );
    expect(getApplication(db, id)?.status).toBe("dry_run");

    const log = readFileSync(join(runDir, "blocked-requests.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { method: string; url: string });
    expect(log.map((l) => `${l.method} ${l.url}`)).toEqual([
      "DESK start_submit (dry run)",
      "CHROME computer left_click",
      "CHROME computer key",
      "DESK record_result(submitted)",
    ]);
    db.close();
  });
});
