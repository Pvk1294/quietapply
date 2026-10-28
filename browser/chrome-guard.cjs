// Claude in Chrome has no network guard (it drives the user's own browser), so in dry run and review mode
// this PreToolUse hook is the tool-level guard. Claude Code runs it before every Claude in Chrome `computer`
// call (see providers/claude-code.ts). It needs QUIETAPPLY_RUN_DIR, the application's run folder.
//   - Enter / Return and typed line breaks are refused: they submit forms.
//   - Once the desk has refused the submit step (start_submit in dry run or review), every click, drag,
//     key press and typing action is refused for the rest of the run; looking (screenshot, scroll, zoom) is fine.
// Every refusal is appended to blocked-requests.jsonl in the run folder, next to Playwright's guard log.
// A click on a final Submit button before start_submit is called cannot be told apart from any other click
// at this level; the desk's own checks (start_submit, record_result) cover that case.
const { appendFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const LOCK_FILE = "submit-step.json";
const LOG_FILE = "blocked-requests.jsonl";
const LOOK_ONLY = new Set(["screenshot", "scroll", "scroll_to", "zoom", "wait", "hover", "mouse_move"]);

/** The reason this call is refused, or undefined when it may go ahead. */
function decide(tool, input, locked) {
  if (!/(^|__)computer$/.test(String(tool))) return undefined;
  const action = String(input?.action ?? "");
  const text = String(input?.text ?? "");
  if (action === "key" && /(^|[\s+])(enter|return|kp_enter)(\s|$)/i.test(text))
    return "Enter submits forms: click the field or button instead (never the final Submit).";
  if (action === "type" && /[\r\n]/.test(text)) return "Typed line breaks can submit a form.";
  if (locked && !LOOK_ONLY.has(action))
    return "The submit step was reached in dry run or review mode: no more clicks or typing. End the run.";
  return undefined;
}

function main(raw, runDir) {
  let call;
  try {
    call = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const locked = !!runDir && existsSync(join(runDir, LOCK_FILE));
  const reason = decide(call.tool_name, call.tool_input, locked);
  if (!reason) return undefined;
  if (runDir) {
    try {
      const line = {
        at: new Date().toISOString(),
        method: "CHROME",
        url: `computer ${call.tool_input?.action ?? ""}`.trim(),
        reason,
      };
      appendFileSync(join(runDir, LOG_FILE), `${JSON.stringify(line)}\n`);
    } catch {}
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `QuietApply guard: ${reason}`,
    },
  };
}

module.exports = { decide, main, LOCK_FILE, LOG_FILE };

if (require.main === module) {
  let raw = "";
  process.stdin.on("data", (d) => {
    raw += d;
  });
  process.stdin.on("end", () => {
    const out = main(raw, process.env.QUIETAPPLY_RUN_DIR);
    if (out) process.stdout.write(JSON.stringify(out));
  });
}
