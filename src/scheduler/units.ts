import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The files each OS needs for "run automatically while your computer is on": the dashboard as a login
 * item, and a check every 15 minutes that calls `quietapply tick`, which runs a slot when one is due.
 */
export const LABEL = "dev.quietapply.tick";
export const DASHBOARD_LABEL = "dev.quietapply.dashboard";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const defaultPath = () => process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

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
  <dict><key>QUIETAPPLY_HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(defaultPath())}</string></dict>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(join(home, "logs", "tick.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(home, "logs", "tick.log"))}</string>
</dict>
</plist>
`;
}

/**
 * The dashboard as a login item (macOS): started when you log in, and again if it stops with an error
 * (not when you quit it). A busy port makes it exit with an error, so it waits 30 s between tries.
 */
export function launchdDashboardPlist(node: string, cli: string, home: string, port: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DASHBOARD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(cli)}</string><string>dashboard</string><string>--port</string><string>${port}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>QUIETAPPLY_HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(defaultPath())}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(join(home, "logs", "dashboard.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(home, "logs", "dashboard.log"))}</string>
</dict>
</plist>
`;
}

export function launchdPath(userHome = homedir(), label = LABEL): string {
  return join(userHome, "Library", "LaunchAgents", `${label}.plist`);
}

/**
 * systemd --user units (Linux): the tick service and its timer, and the dashboard service. The timer is
 * on the wall clock with Persistent=true, so a check missed while the machine was off or suspended runs
 * once when it is back; `tick` then runs only the latest missed slot.
 */
export function systemdUnits(
  node: string,
  cli: string,
  home: string,
  port = 4777,
): { service: string; timer: string; dashboard: string } {
  return {
    service: `[Unit]
Description=QuietApply scheduled run check

[Service]
Type=oneshot
Environment=QUIETAPPLY_HOME=${home}
Environment=PATH=${defaultPath()}
ExecStart=${node} ${cli} tick
`,
    timer: `[Unit]
Description=QuietApply: check for a due run every 15 minutes

[Timer]
OnCalendar=*:0/15
OnStartupSec=2min
Persistent=true

[Install]
WantedBy=timers.target
`,
    dashboard: `[Unit]
Description=QuietApply dashboard (http://127.0.0.1:${port})

[Service]
Environment=QUIETAPPLY_HOME=${home}
Environment=PATH=${defaultPath()}
ExecStart=${node} ${cli} dashboard --port ${port}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`,
  };
}

export const SYSTEMD_FILES = {
  service: "quietapply.service",
  timer: "quietapply.timer",
  dashboard: "quietapply-dashboard.service",
} as const;

export function systemdDir(userHome = homedir()): string {
  return join(userHome, ".config", "systemd", "user");
}

/** The Task Scheduler tasks (Windows), in their own QuietApply folder. */
export const WINDOWS_TASK = "QuietApply\\tick";
export const WINDOWS_DASHBOARD_TASK = "QuietApply\\dashboard";

/** `%` is the only character a batch file reads specially inside double quotes. */
const batch = (s: string) => s.replace(/%/g, "%%");

/** A VBScript that starts a .cmd with no window. VBScript doubles a quote inside a string; 0 = hidden, False = do not wait. */
const hiddenLauncher = (cmdPath: string) =>
  `CreateObject("WScript.Shell").Run """${cmdPath.replace(/"/g, '""')}""", 0, False\r\n`;

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
    vbs: hiddenLauncher(cmdPath),
  };
}

/**
 * The dashboard login item (Windows): `dashboard.cmd` and its hidden launcher, plus the task definition.
 * The task starts at your sign-in only and runs as you, without admin rights.
 */
export function windowsDashboardFiles(
  node: string,
  cli: string,
  home: string,
  port: number,
  user: string,
  pathJoin: (...parts: string[]) => string = join,
): { cmdPath: string; cmd: string; vbsPath: string; vbs: string; xmlPath: string; xml: string } {
  const cmdPath = pathJoin(home, "dashboard.cmd");
  const vbsPath = pathJoin(home, "dashboard.vbs");
  const log = pathJoin(home, "logs", "dashboard.log");
  return {
    cmdPath,
    cmd: [
      "@echo off",
      "rem Written by `quietapply schedule on`. Starts the QuietApply dashboard when you sign in.",
      `set "QUIETAPPLY_HOME=${batch(home)}"`,
      `"${batch(node)}" "${batch(cli)}" dashboard --port ${port} >> "${batch(log)}" 2>&1`,
      "",
    ].join("\r\n"),
    vbsPath,
    vbs: hiddenLauncher(cmdPath),
    xmlPath: pathJoin(home, "dashboard-task.xml"),
    xml: `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>QuietApply dashboard at sign-in (written by quietapply schedule on)</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"${xml(vbsPath)}"</Arguments></Exec></Actions>
</Task>
`,
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

export const schtasksDeleteArgs = (task = WINDOWS_TASK): string[] => ["/Delete", "/F", "/TN", task];
export const schtasksQueryArgs = (task = WINDOWS_TASK): string[] => ["/Query", "/TN", task];
export const schtasksXmlArgs = (xmlPath: string, task = WINDOWS_DASHBOARD_TASK): string[] => [
  "/Create",
  "/F",
  "/TN",
  task,
  "/XML",
  xmlPath,
];

/** The per-user Startup folder: the fallback login item when Task Scheduler refuses a sign-in task. */
export function windowsStartupFile(
  userHome = homedir(),
  appData = process.env.APPDATA,
  pathJoin: (...parts: string[]) => string = join,
): string {
  return pathJoin(
    appData ?? pathJoin(userHome, "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "QuietApply dashboard.vbs",
  );
}
