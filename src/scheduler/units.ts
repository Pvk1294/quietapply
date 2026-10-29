import { homedir } from "node:os";
import { join } from "node:path";

export const LABEL = "dev.quietapply.tick";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A per-user LaunchAgent that runs `quietapply tick` every 15 minutes and at login (macOS). */
export function launchdPlist(node: string, cli: string, home: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(cli)}</string><string>tick</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>QUIETAPPLY_HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string></dict>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(join(home, "logs", "tick.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(home, "logs", "tick.log"))}</string>
</dict>
</plist>
`;
}

export function launchdPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** systemd --user service + timer (Linux). */
export function systemdUnits(node: string, cli: string, home: string): { service: string; timer: string } {
  return {
    service: `[Unit]
Description=QuietApply scheduled run check

[Service]
Type=oneshot
Environment=QUIETAPPLY_HOME=${home}
Environment=PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}
ExecStart=${node} ${cli} tick
`,
    timer: `[Unit]
Description=QuietApply: check for a due run every 15 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

export function systemdDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

/** The Task Scheduler task (Windows), in its own QuietApply folder. */
export const WINDOWS_TASK = "QuietApply\\tick";

/** `%` is the only character a batch file reads specially inside double quotes. */
const batch = (s: string) => s.replace(/%/g, "%%");

/**
 * The two files the Windows task runs, written into the data folder. `tick.cmd` sets QUIETAPPLY_HOME and
 * runs `quietapply tick`, appending to logs\tick.log. `tick.vbs` starts it with no window, so nothing
 * flashes on screen every 15 minutes.
 */
export function windowsTaskFiles(
  node: string,
  cli: string,
  home: string,
  // The platform's own join (win32 on Windows); tests pass win32.join to check Windows paths anywhere.
  pathJoin: (...parts: string[]) => string = join,
): { cmdPath: string; cmd: string; vbsPath: string; vbs: string } {
  const cmdPath = pathJoin(home, "tick.cmd");
  const vbsPath = pathJoin(home, "tick.vbs");
  const log = pathJoin(home, "logs", "tick.log");
  return {
    cmdPath,
    cmd: [
      "@echo off",
      "rem Written by `quietapply schedule on`. Task Scheduler runs this every 15 minutes.",
      `set "QUIETAPPLY_HOME=${batch(home)}"`,
      `"${batch(node)}" "${batch(cli)}" tick >> "${batch(log)}" 2>&1`,
      "",
    ].join("\r\n"),
    vbsPath,
    // VBScript doubles a quote inside a string; 0 = hidden window, False = do not wait.
    vbs: `CreateObject("WScript.Shell").Run """${cmdPath.replace(/"/g, '""')}""", 0, False\r\n`,
  };
}

/** schtasks arguments to create (or replace) the task: every 15 minutes, as the signed-in user. */
export function schtasksCreateArgs(vbsPath: string): string[] {
  return [
    "/Create",
    "/F",
    "/SC",
    "MINUTE",
    "/MO",
    "15",
    "/TN",
    WINDOWS_TASK,
    "/TR",
    `wscript.exe "${vbsPath}"`,
  ];
}

export const schtasksDeleteArgs = (): string[] => ["/Delete", "/F", "/TN", WINDOWS_TASK];
export const schtasksQueryArgs = (): string[] => ["/Query", "/TN", WINDOWS_TASK];
