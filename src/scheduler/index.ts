import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, sep } from "node:path";
import { type Config, loadConfig, saveConfig } from "../core/config.js";
import { type DB, kvGet, kvSet, openDb } from "../core/db.js";
import type { Paths } from "../core/paths.js";
import { dueSlot, nextSlot } from "./slots.js";
import {
  DASHBOARD_LABEL,
  LABEL,
  launchdDashboardPlist,
  launchdPath,
  launchdPlist,
  SYSTEMD_FILES,
  schtasksCreateArgs,
  schtasksDeleteArgs,
  schtasksQueryArgs,
  schtasksXmlArgs,
  systemdDir,
  systemdUnits,
  WINDOWS_DASHBOARD_TASK,
  windowsDashboardFiles,
  windowsStartupFile,
  windowsTaskFiles,
} from "./units.js";

/**
 * "Run automatically while your computer is on": the same `quietapply schedule on|off|status` on every
 * OS. `on` installs two things, the dashboard as a login item and a check every 15 minutes that runs a
 * scheduled slot when one is due (launchd on macOS, systemd --user on Linux, Task Scheduler on Windows).
 * Nothing runs while the computer is off; a slot missed while it was off or asleep runs once soon after
 * you log in or it wakes, and only the latest missed one (see slots.ts).
 */
export interface ScheduleResult {
  ok: boolean;
  message: string;
  files: string[];
}

/** What the scheduler touches outside its own files. Tests pass a platform, a recorder and a temp home. */
export interface ScheduleEnv {
  platform?: NodeJS.Platform;
  exec?: (command: string, args: string[]) => void;
  /** The user's home folder (LaunchAgents, systemd units, Startup folder). Default: os.homedir(). */
  userHome?: string;
}

const realExec = (command: string, args: string[]) => {
  // stderr is kept, so a failure's error message says what went wrong.
  execFileSync(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
};

const attempt = (f: () => void): boolean => {
  try {
    f();
    return true;
  } catch {
    return false;
  }
};

/** The OS refused the jobs: take the files back, so `schedule status` and `doctor` do not say it is on. */
function notStarted(files: string[], why: string, err: unknown): ScheduleResult {
  for (const f of files) rmSync(f, { force: true });
  const detail = (err as Error).message.split("\n").find((l) => l.trim()) ?? "";
  return {
    ok: false,
    message: `${why} (${detail}). Nothing was installed. The dashboard and \`quietapply run\` still work.`,
    files: [],
  };
}

/** Install the dashboard login item and the run schedule. `dryRun` only reports what would be written. */
export function scheduleOn(
  p: Paths,
  cli: string,
  opts: { dryRun?: boolean; port?: number } & ScheduleEnv = {},
): ScheduleResult {
  const node = process.execPath;
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? realExec;
  const userHome = opts.userHome ?? homedir();
  const port = opts.port ?? 4777;
  const write = (file: string, text: string | Buffer) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  };
  if (platform === "darwin") {
    const tick = launchdPath(userHome, LABEL);
    const dash = launchdPath(userHome, DASHBOARD_LABEL);
    const files = [dash, tick];
    const plists = [launchdDashboardPlist(node, cli, p.home, port), launchdPlist(node, cli, p.home)];
    if (opts.dryRun) return { ok: true, message: plists.join("\n"), files };
    const uid = process.getuid?.();
    try {
      files.forEach((f, i) => {
        write(f, plists[i]!);
        const label = i === 0 ? DASHBOARD_LABEL : LABEL;
        attempt(() => exec("launchctl", ["bootout", `gui/${uid}/${label}`])); // not loaded yet is fine
        exec("launchctl", ["bootstrap", `gui/${uid}`, f]);
      });
    } catch (err) {
      return notStarted(files, "macOS would not start the background jobs", err);
    }
    const folder = macProtectedFolder(cli, userHome);
    return {
      ok: true,
      message: `${onMessage(port)}${
        folder
          ? `\nWarning: QuietApply is in ~/${folder}. macOS can stop background jobs from reading that folder, and the run then hangs without a message. Move the clone somewhere else (for example ~/code/quietapply) and run schedule on again.`
          : ""
      }`,
      files,
    };
  }
  if (platform === "linux") {
    const dir = systemdDir(userHome);
    const units = systemdUnits(node, cli, p.home, port);
    const files = [SYSTEMD_FILES.dashboard, SYSTEMD_FILES.service, SYSTEMD_FILES.timer].map((f) =>
      join(dir, f),
    );
    if (opts.dryRun)
      return { ok: true, message: `${units.dashboard}\n${units.service}\n${units.timer}`, files };
    write(files[0]!, units.dashboard);
    write(files[1]!, units.service);
    write(files[2]!, units.timer);
    try {
      exec("systemctl", ["--user", "daemon-reload"]);
      exec("systemctl", ["--user", "enable", "--now", SYSTEMD_FILES.dashboard]);
      exec("systemctl", ["--user", "enable", "--now", SYSTEMD_FILES.timer]);
    } catch (err) {
      return notStarted(
        files,
        "This computer has no systemd user session, which running automatically needs on Linux",
        err,
      );
    }
    return { ok: true, message: onMessage(port), files };
  }
  if (platform === "win32") {
    const t = windowsTaskFiles(node, cli, p.home);
    const d = windowsDashboardFiles(node, cli, p.home, port, windowsUser());
    const files = [d.cmdPath, d.vbsPath, d.xmlPath, t.cmdPath, t.vbsPath];
    if (opts.dryRun)
      return {
        ok: true,
        message: [
          d.cmd,
          d.vbs,
          d.xml,
          `schtasks ${schtasksXmlArgs(d.xmlPath).join(" ")}`,
          t.cmd,
          t.vbs,
          `schtasks ${schtasksCreateArgs(t.vbsPath).join(" ")}`,
        ].join("\n"),
        files,
      };
    write(d.cmdPath, d.cmd);
    write(d.vbsPath, d.vbs);
    // Task Scheduler reads a task definition as UTF-16 with a byte-order mark.
    write(d.xmlPath, Buffer.from(`﻿${d.xml}`, "utf16le"));
    write(t.cmdPath, t.cmd);
    write(t.vbsPath, t.vbs);
    // A sign-in task normally needs no admin rights when it runs as you; if Windows refuses it anyway,
    // the per-user Startup folder does the same job.
    let note = "";
    if (!attempt(() => exec("schtasks", schtasksXmlArgs(d.xmlPath)))) {
      const startup = windowsStartupFile(userHome);
      write(startup, d.vbs);
      files.push(startup);
      note =
        "\n(The dashboard starts from your Startup folder: Task Scheduler did not accept a sign-in task.)";
    }
    exec("schtasks", schtasksCreateArgs(t.vbsPath));
    attempt(() => exec("wscript.exe", [d.vbsPath])); // start the dashboard now, not only at the next sign-in
    return { ok: true, message: onMessage(port) + note, files };
  }
  return {
    ok: false,
    message: "Running automatically is supported on macOS, Linux and Windows.",
    files: [],
  };
}

function onMessage(port: number): string {
  return [
    `Automatic runs are on. The dashboard starts when you log in (http://127.0.0.1:${port}),`,
    "and QuietApply checks every 15 minutes for a scheduled run while your computer is on.",
    "A run missed while it was off or asleep happens once, soon after you log in or it wakes.",
  ].join("\n");
}

function windowsUser(): string {
  const name = process.env.USERNAME ?? userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
}

/**
 * macOS keeps Desktop, Documents and Downloads behind a privacy prompt that a background job cannot
 * answer, so a LaunchAgent that loads code from there hangs. Returns the folder name when `path` is inside one.
 */
export function macProtectedFolder(path: string, home = homedir()): string | undefined {
  return ["Desktop", "Documents", "Downloads"].find((f) => path.startsWith(join(home, f) + sep));
}

/** Remove both the login item and the run schedule. */
export function scheduleOff(p?: Paths, o: ScheduleEnv = {}): ScheduleResult {
  const platform = o.platform ?? process.platform;
  const exec = o.exec ?? realExec;
  const userHome = o.userHome ?? homedir();
  const remove = (files: string[]) => {
    for (const f of files) if (existsSync(f)) unlinkSync(f);
    return files;
  };
  const message = "Automatic runs are off: no login item and no schedule. Run now still works.";
  if (platform === "darwin") {
    for (const label of [LABEL, DASHBOARD_LABEL])
      attempt(() => exec("launchctl", ["bootout", `gui/${process.getuid?.()}/${label}`]));
    return {
      ok: true,
      message,
      files: remove([launchdPath(userHome, DASHBOARD_LABEL), launchdPath(userHome, LABEL)]),
    };
  }
  if (platform === "linux") {
    for (const unit of [SYSTEMD_FILES.timer, SYSTEMD_FILES.dashboard])
      attempt(() => exec("systemctl", ["--user", "disable", "--now", unit]));
    const files = remove(Object.values(SYSTEMD_FILES).map((f) => join(systemdDir(userHome), f)));
    attempt(() => exec("systemctl", ["--user", "daemon-reload"]));
    return { ok: true, message, files };
  }
  if (platform === "win32") {
    attempt(() => exec("schtasks", schtasksDeleteArgs()));
    attempt(() => exec("schtasks", schtasksDeleteArgs(WINDOWS_DASHBOARD_TASK)));
    const t = p && windowsTaskFiles("", "", p.home);
    const d = p && windowsDashboardFiles("", "", p.home, 0, "");
    const files = remove([
      ...(t ? [t.cmdPath, t.vbsPath] : []),
      ...(d ? [d.cmdPath, d.vbsPath, d.xmlPath] : []),
      windowsStartupFile(userHome),
    ]);
    return {
      ok: true,
      message: `${message}\nA dashboard that is already open keeps running until you sign out.`,
      files,
    };
  }
  return { ok: false, message: "Nothing to remove on this platform.", files: [] };
}

export interface AutoStartState {
  /** The dashboard starts at login. */
  dashboard: boolean;
  /** The 15-minute check that runs scheduled slots. */
  runs: boolean;
}

export function scheduleState(o: ScheduleEnv = {}): AutoStartState {
  const platform = o.platform ?? process.platform;
  const userHome = o.userHome ?? homedir();
  if (platform === "darwin")
    return {
      dashboard: existsSync(launchdPath(userHome, DASHBOARD_LABEL)),
      runs: existsSync(launchdPath(userHome, LABEL)),
    };
  if (platform === "linux") {
    const dir = systemdDir(userHome);
    return {
      dashboard: existsSync(join(dir, SYSTEMD_FILES.dashboard)),
      runs: existsSync(join(dir, SYSTEMD_FILES.timer)),
    };
  }
  if (platform === "win32") {
    const exec = o.exec ?? realExec;
    return {
      dashboard:
        attempt(() => exec("schtasks", schtasksQueryArgs(WINDOWS_DASHBOARD_TASK))) ||
        existsSync(windowsStartupFile(userHome)),
      runs: attempt(() => exec("schtasks", schtasksQueryArgs())),
    };
  }
  return { dashboard: false, runs: false };
}

/** The run schedule is installed (the dashboard login item may or may not be). */
export function scheduleInstalled(o: ScheduleEnv = {}): boolean {
  return scheduleState(o).runs;
}

/**
 * Turning automatic runs on starts from now: the slots already passed today count as done, so the first
 * run is the next scheduled time, not an immediate catch-up of this morning. Only when nothing ran yet.
 */
export function markScheduleStart(db: DB, config: Config, at = new Date()): void {
  if (kvGet(db, "schedule:last")) return;
  const slot = dueSlot(at, config.schedule, undefined, config.timezone);
  if (slot) kvSet(db, "schedule:last", JSON.stringify({ slot, status: "skipped", at: at.toISOString() }));
}

/**
 * On or off as one step, the same from `schedule on|off`, `init` and Settings: installs or removes both
 * parts, remembers the choice in config.yaml, and on "on" starts the schedule from now.
 */
export function setAutoStart(p: Paths, cli: string, on: boolean, env: ScheduleEnv = {}): ScheduleResult {
  const config = loadConfig(p);
  const r = on ? scheduleOn(p, cli, { ...env, port: config.dashboard.port }) : scheduleOff(p, env);
  if (!r.ok) return r;
  if (on) {
    const db = openDb(p);
    try {
      markScheduleStart(db, config);
    } finally {
      db.close();
    }
  }
  saveConfig({ ...config, autoStart: on }, p);
  // A LaunchAgent or unit that points into npx's cache breaks without a sound when that cache is cleared.
  return on && /[\\/]_npx[\\/]/.test(cli)
    ? {
        ...r,
        message: `${r.message}\nWarning: QuietApply is running from npx's temporary cache, which can be cleared at any time. Run \`npm install -g quietapply\`, then \`quietapply schedule on\` again.`,
      }
    : r;
}

/** The lines `quietapply schedule status` prints (and the dashboard shows). */
export function scheduleStatusLines(
  state: AutoStartState,
  config: Config,
  last: { slot?: string; status?: string },
  at = new Date(),
): string[] {
  const tz = config.timezone === "auto" ? Intl.DateTimeFormat().resolvedOptions().timeZone : config.timezone;
  const on = state.dashboard && state.runs;
  const next = nextSlot(at, config.schedule, config.timezone);
  return [
    `Run automatically: ${on ? "ON" : state.dashboard || state.runs ? "PARTLY ON (run quietapply schedule on)" : "OFF"}`,
    `  Dashboard at login: ${state.dashboard ? "installed" : "not installed"} (http://127.0.0.1:${config.dashboard.port})`,
    `  Run schedule:       ${state.runs ? "installed, checks every 15 minutes" : "not installed"}`,
    `  Times:              ${config.schedule.join(", ") || "none"} (${tz})`,
    ...(state.runs && next ? [`  Next run:           ${next}`] : []),
    `  Last run:           ${last.slot ? `${last.slot} ${last.status ?? ""}`.trim() : "none yet"}`,
    "  Missed runs:        the latest one runs once, soon after login or wake; nothing runs while the computer is off",
    `  Dry run:            ${config.dryRun ? "on (forms are filled, nothing is submitted)" : "off (applications are submitted)"}`,
  ];
}
