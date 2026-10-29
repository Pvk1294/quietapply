import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { browserCandidates, findBrowser } from "../src/cli/doctor.js";
import { expandHome } from "../src/cli/init.js";
import { ownerOnly, paths } from "../src/core/paths.js";
import { findTailscale } from "../src/phone/tailscale.js";
import { locateClaude } from "../src/providers/claude-code.js";
import { locateCodex } from "../src/providers/codex.js";
import { npxCommand, quoteForCmd, resolveCommand, shimTarget, spawnPlan } from "../src/providers/spawn.js";
import { chromeGuardSettings } from "../src/runner/chrome-guard.js";
import { scheduleInstalled, scheduleOff, scheduleOn } from "../src/scheduler/index.js";
import { schtasksCreateArgs, WINDOWS_TASK, windowsTaskFiles } from "../src/scheduler/units.js";

// Windows behaviour, tested on any OS by passing the platform, environment and file checks in.
// Nothing here runs a Windows command; CI also runs the whole suite on windows-latest.

const has =
  (...files: string[]) =>
  (f: string) =>
    files.map((x) => x.toLowerCase()).includes(f.toLowerCase());

const WIN_ENV = {
  PATH: "C:\\Windows\\system32;C:\\Users\\Jane\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  APPDATA: "C:\\Users\\Jane\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\Jane\\AppData\\Local",
  USERPROFILE: "C:\\Users\\Jane",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
};

describe("finding commands on Windows (PATH + PATHEXT)", () => {
  it("finds npm's .cmd shims and .exe files by their bare name", () => {
    const exists = has(
      "C:\\Users\\Jane\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Program Files\\nodejs\\npx.cmd",
    );
    expect(resolveCommand("claude", { platform: "win32", env: WIN_ENV, exists })).toBe(
      "C:\\Users\\Jane\\AppData\\Roaming\\npm\\claude.cmd",
    );
    expect(resolveCommand("npx", { platform: "win32", env: WIN_ENV, exists })).toBe(
      "C:\\Program Files\\nodejs\\npx.cmd",
    );
    expect(resolveCommand("nothing", { platform: "win32", env: WIN_ENV, exists })).toBe("nothing");
  });
  it("leaves commands alone on macOS and Linux", () => {
    expect(resolveCommand("claude", { platform: "darwin", env: WIN_ENV, exists: () => true })).toBe("claude");
  });

  it("runs an npm shim's script with Node instead of the .cmd file", () => {
    const shim = "C:\\Users\\Jane\\AppData\\Roaming\\npm\\codex.cmd";
    const script = "C:\\Users\\Jane\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
    const text = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
    const o = {
      platform: "win32" as const,
      env: WIN_ENV,
      exists: has(shim, script),
      readFile: () => text,
      node: "node.exe",
    };
    expect(shimTarget(shim, o)).toBe(script);
    expect(spawnPlan("codex", ["exec", "--json", "-"], o)).toEqual({
      command: "node.exe",
      args: [script, "exec", "--json", "-"],
    });
  });

  it("sends any other batch file through cmd.exe with every argument escaped", () => {
    const bat = "C:\\tools\\claude.cmd";
    const plan = spawnPlan("C:\\tools\\claude", ["-p", 'say "hi" & exit', "a b"], {
      platform: "win32",
      env: WIN_ENV,
      exists: has(bat),
      readFile: () => "@echo off\r\nrem not an npm shim\r\n",
    });
    expect(plan.command).toBe(WIN_ENV.ComSpec);
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    const line = plan.args[3]!;
    // The & that would start a second command is escaped, and no argument is left bare.
    expect(line).not.toMatch(/[^^]&/);
    expect(line).toContain("^&");
  });

  it("spawns an .exe directly, with no shell", () => {
    const exe = "C:\\Users\\Jane\\.local\\bin\\claude.exe";
    expect(spawnPlan(exe, ["-p"], { platform: "win32", env: WIN_ENV, exists: has(exe) })).toEqual({
      command: exe,
      args: ["-p"],
    });
  });

  it("runs a Node script given as the command under Node (Windows ignores #! lines)", () => {
    expect(
      spawnPlan("C:\\qa\\fake-tailscale.mjs", ["status"], { platform: "win32", node: "node.exe" }),
    ).toEqual({
      command: "node.exe",
      args: ["C:\\qa\\fake-tailscale.mjs", "status"],
    });
  });

  it("quotes for cmd.exe the way cross-spawn does", () => {
    expect(quoteForCmd("plain", false)).toBe('^"plain^"');
    expect(quoteForCmd("a b", false)).toBe('^"a^ b^"');
    expect(quoteForCmd('say "x"', false)).toBe('^"say^ \\^"x\\^"^"');
    expect(quoteForCmd("50%", true)).toBe('^^^"50^^^%^^^"');
  });

  it("starts Playwright MCP through cmd /c npx on Windows, where npx is a .cmd file", () => {
    expect(npxCommand("win32")).toEqual({ command: "cmd", args: ["/c", "npx"] });
    expect(npxCommand("darwin")).toEqual({ command: "npx", args: [] });
  });
});

describe("Claude Code and Codex on Windows", () => {
  it("finds Claude Code from the native installer when it is not on PATH", () => {
    const exe = "C:\\Users\\Jane\\.local\\bin\\claude.exe";
    expect(locateClaude({ platform: "win32", env: { ...WIN_ENV, PATH: "" }, exists: has(exe) })).toBe(exe);
    expect(locateClaude({ platform: "win32", env: { ...WIN_ENV, PATH: "" }, exists: () => false })).toBe(
      "claude",
    );
    expect(locateClaude({ platform: "win32", env: { ...WIN_ENV, QUIETAPPLY_CLAUDE_BIN: "X:\\c.exe" } })).toBe(
      "X:\\c.exe",
    );
  });
  it("finds codex.exe or the npm codex.cmd, also in %APPDATA%\\npm when PATH lacks it", () => {
    const cmd = "C:\\Users\\Jane\\AppData\\Roaming\\npm\\codex.cmd";
    expect(
      locateCodex({ platform: "win32", env: { ...WIN_ENV, PATH: "C:\\Windows" }, exists: has(cmd) }),
    ).toEqual({
      path: cmd,
      via: "path",
    });
    expect(
      locateCodex({ platform: "win32", configured: "~\\bin\\codex.exe", home: "C:\\Users\\Jane", env: {} }),
    ).toEqual({ path: "C:\\Users\\Jane\\bin\\codex.exe", via: "config" });
  });
});

describe("browser, folders and phone on Windows", () => {
  it("looks for Chrome and Edge in both Program Files folders and the per-user folder", () => {
    const list = browserCandidates("win32", WIN_ENV);
    expect(list).toContain("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(list).toContain("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(list).toContain("C:\\Users\\Jane\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe");
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    expect(findBrowser("win32", WIN_ENV, has(edge))).toBe(edge);
  });

  it("skips chmod on Windows and keeps it elsewhere", () => {
    const calls: string[] = [];
    const chmod = (f: string, m: number) => calls.push(`${f} ${m.toString(8)}`);
    expect(ownerOnly("C:\\Users\\Jane\\.quietapply", 0o700, "win32", chmod)).toBe(false);
    expect(calls).toEqual([]);
    expect(ownerOnly("/home/jane/.quietapply", 0o700, "linux", chmod)).toBe(true);
    expect(calls).toEqual(["/home/jane/.quietapply 700"]);
  });

  it("finds tailscale.exe in Program Files when it is not on PATH", () => {
    const exe = "C:\\Program Files\\Tailscale\\tailscale.exe";
    expect(findTailscale({ ...WIN_ENV, PATH: "C:\\Windows" }, "win32", has(exe))).toBe(exe);
    expect(findTailscale({ ...WIN_ENV, PATH: "C:\\Windows" }, "win32", () => false)).toBeUndefined();
  });

  it("expands ~\\ in a resume path", () => {
    expect(expandHome("~/resume.pdf", "/home/jane")).toBe(join("/home/jane", "resume.pdf"));
    expect(expandHome("~\\resume.pdf", "/home/jane")).toBe(join("/home/jane", "resume.pdf"));
    expect(expandHome("C:\\cv.pdf", "/home/jane")).toBe("C:\\cv.pdf");
  });

  it("passes the run folder to the Claude in Chrome hook as an argument, not a sh-only VAR=value prefix", () => {
    const s = JSON.parse(chromeGuardSettings("C:\\Users\\Jane\\.quietapply\\logs\\run-1\\app-2"));
    const command: string = s.hooks.PreToolUse[0].hooks[0].command;
    expect(command).toMatch(/^node "/);
    expect(command).not.toContain("QUIETAPPLY_RUN_DIR=");
    expect(command.endsWith('"C:\\Users\\Jane\\.quietapply\\logs\\run-1\\app-2"')).toBe(true);
  });
});

describe("Task Scheduler (Windows)", () => {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const cli = "C:\\Users\\Jane\\code\\quietapply\\dist\\cli\\index.js";
  const home = "C:\\Users\\Jane\\.quietapply";

  it("writes a wrapper that sets QUIETAPPLY_HOME and logs, and a hidden-window launcher", () => {
    const t = windowsTaskFiles(node, cli, home, win32.join);
    expect(t.cmdPath).toBe("C:\\Users\\Jane\\.quietapply\\tick.cmd");
    expect(t.cmd).toContain('set "QUIETAPPLY_HOME=C:\\Users\\Jane\\.quietapply"');
    expect(t.cmd).toContain(`"${node}" "${cli}" tick >> "C:\\Users\\Jane\\.quietapply\\logs\\tick.log" 2>&1`);
    expect(t.cmd).toContain("\r\n");
    expect(t.vbs).toBe(
      'CreateObject("WScript.Shell").Run """C:\\Users\\Jane\\.quietapply\\tick.cmd""", 0, False\r\n',
    );
    expect(windowsTaskFiles(node, cli, "C:\\100%\\qa", win32.join).cmd).toContain("C:\\100%%\\qa");
  });

  it("creates the task every 15 minutes, and removes and queries it", () => {
    expect(schtasksCreateArgs("C:\\q\\tick.vbs")).toEqual([
      "/Create",
      "/F",
      "/SC",
      "MINUTE",
      "/MO",
      "15",
      "/TN",
      WINDOWS_TASK,
      "/TR",
      'wscript.exe "C:\\q\\tick.vbs"',
    ]);
    const tmpHome = mkdtempSync(join(tmpdir(), "qa-win-"));
    const p = paths(tmpHome);
    const ran: string[] = [];
    const exec = (c: string, a: string[]) => {
      ran.push(`${c} ${a[0]}`);
    };
    const on = scheduleOn(p, cli, { platform: "win32", exec });
    expect(on.ok).toBe(true);
    expect(ran).toEqual(["schtasks /Create"]);
    expect(on.files).toEqual([join(tmpHome, "tick.cmd"), join(tmpHome, "tick.vbs")]);
    expect(readFileSync(on.files[0]!, "utf8")).toContain(`"${cli}" tick`);
    expect(scheduleInstalled({ platform: "win32", exec })).toBe(true);
    expect(
      scheduleInstalled({
        platform: "win32",
        exec: () => {
          throw new Error("ERROR: The system cannot find the file specified.");
        },
      }),
    ).toBe(false);
    expect(scheduleOff(p, { platform: "win32", exec }).ok).toBe(true);
    expect(ran).toContain("schtasks /Delete");
  });

  it("prints what it would install without running anything", () => {
    const ran: string[] = [];
    const r = scheduleOn(paths("/tmp/qa-win-print"), cli, {
      platform: "win32",
      dryRun: true,
      exec: (c) => {
        ran.push(c);
      },
    });
    expect(ran).toEqual([]);
    expect(r.message).toContain("schtasks /Create");
    expect(r.files).toEqual([join("/tmp/qa-win-print", "tick.cmd"), join("/tmp/qa-win-print", "tick.vbs")]);
  });
});
