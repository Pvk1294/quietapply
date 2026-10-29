import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../core/paths.js";

/** The hook Claude Code runs before every Claude in Chrome action in dry run and review mode. */
export function chromeGuardPath(): string {
  return join(packageRoot(), "browser", "chrome-guard.cjs");
}

/** Written by the desk when it refuses the submit step; the hook then refuses every click and key press. */
export const SUBMIT_LOCK = "submit-step.json";
/** Shared with Playwright's dry-run guard, so the dashboard counts both. */
export const GUARD_LOG = "blocked-requests.jsonl";

/** `--settings` JSON that registers the hook for the Claude in Chrome `computer` tool. */
export function chromeGuardSettings(runDir: string): string {
  // The run folder is an argument, not a `VAR=value` prefix, so the same line works in sh, cmd and PowerShell.
  const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  const command = `node ${quote(chromeGuardPath())} ${quote(runDir)}`;
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "mcp__claude-in-chrome__computer", hooks: [{ type: "command", command }] }],
    },
  });
}

/** The desk reached the submit step in dry run or review mode: from now on the browser may only look. */
export function lockSubmitStep(runDir: string | undefined, why: string): void {
  if (!runDir) return;
  mkdirSync(runDir, { recursive: true });
  if (!existsSync(join(runDir, SUBMIT_LOCK)))
    writeFileSync(join(runDir, SUBMIT_LOCK), JSON.stringify({ at: new Date().toISOString(), why }));
}

/** Log an attempt to submit that the desk refused. */
export function logSubmitAttempt(runDir: string | undefined, what: string): void {
  if (!runDir) return;
  mkdirSync(runDir, { recursive: true });
  const line = { at: new Date().toISOString(), method: "DESK", url: what, reason: "submit refused" };
  appendFileSync(join(runDir, GUARD_LOG), `${JSON.stringify(line)}\n`);
}
