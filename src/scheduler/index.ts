import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Paths } from "../core/paths.js";
import {
  LABEL,
  launchdPath,
  launchdPlist,
  schtasksCreateArgs,
  schtasksDeleteArgs,
  schtasksQueryArgs,
  systemdDir,
  systemdUnits,
  windowsTaskFiles,
} from "./units.js";

export interface ScheduleResult {
  ok: boolean;
  message: string;
  files: string[];
}

/** What the scheduler touches outside its own files. Tests pass a platform and a recorder for commands. */
export interface ScheduleEnv {
  platform?: NodeJS.Platform;
  exec?: (command: string, args: string[]) => void;
}

const realExec = (command: string, args: string[]) => {
  // stderr is kept, so a failure's error message says what went wrong.
  execFileSync(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
};

/** Install the OS timer that calls `quietapply tick`. `dryRun` only reports what would be written. */
export function scheduleOn(
  p: Paths,
  cli: string,
  opts: { dryRun?: boolean } & ScheduleEnv = {},
): ScheduleResult {
  const node = process.execPath;
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? realExec;
  if (platform === "darwin") {
    const file = launchdPath();
    if (opts.dryRun) return { ok: true, message: launchdPlist(node, cli, p.home), files: [file] };
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, launchdPlist(node, cli, p.home));
    try {
      exec("launchctl", ["bootout", `gui/${process.getuid?.()}/${LABEL}`]);
    } catch {
      // not loaded yet
    }
    exec("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, file]);
    const folder = macProtectedFolder(cli);
    return {
      ok: true,
      message: `LaunchAgent installed: checks for a due run every 15 minutes.${
        folder
          ? `\nWarning: QuietApply is in ~/${folder}. macOS can stop background jobs from reading that folder, and the run then hangs without a message. Move the clone somewhere else (for example ~/code/quietapply) and run schedule on again.`
          : ""
      }`,
      files: [file],
    };
  }
  if (platform === "linux") {
    const dir = systemdDir();
    const units = systemdUnits(node, cli, p.home);
    const files = [join(dir, "quietapply.service"), join(dir, "quietapply.timer")];
    if (opts.dryRun) return { ok: true, message: `${units.service}\n${units.timer}`, files };
    mkdirSync(dir, { recursive: true });
    writeFileSync(files[0]!, units.service);
    writeFileSync(files[1]!, units.timer);
    exec("systemctl", ["--user", "daemon-reload"]);
    exec("systemctl", ["--user", "enable", "--now", "quietapply.timer"]);
    return { ok: true, message: "systemd user timer enabled: checks every 15 minutes.", files };
  }
  if (platform === "win32") {
    const t = windowsTaskFiles(node, cli, p.home);
    const files = [t.cmdPath, t.vbsPath];
    if (opts.dryRun)
      return {
        ok: true,
        message: `${t.cmd}\n${t.vbs}\nschtasks ${schtasksCreateArgs(t.vbsPath).join(" ")}`,
        files,
      };
    writeFileSync(t.cmdPath, t.cmd);
    writeFileSync(t.vbsPath, t.vbs);
    exec("schtasks", schtasksCreateArgs(t.vbsPath));
    return {
      ok: true,
      message:
        "Task Scheduler task QuietApply\\tick created: checks for a due run every 15 minutes while you are signed in.",
      files,
    };
  }
  return {
    ok: false,
    message: "Scheduling is supported on macOS, Linux and Windows.",
    files: [],
  };
}

/**
 * macOS keeps Desktop, Documents and Downloads behind a privacy prompt that a background job cannot
 * answer, so a LaunchAgent that loads code from there hangs. Returns the folder name when `path` is inside one.
 */
export function macProtectedFolder(path: string, home = homedir()): string | undefined {
  return ["Desktop", "Documents", "Downloads"].find((f) => path.startsWith(join(home, f) + sep));
}

export function scheduleOff(p?: Paths, o: ScheduleEnv = {}): ScheduleResult {
  const platform = o.platform ?? process.platform;
  const exec = o.exec ?? realExec;
  if (platform === "darwin") {
    const file = launchdPath();
    try {
      exec("launchctl", ["bootout", `gui/${process.getuid?.()}/${LABEL}`]);
    } catch {
      // not loaded
    }
    if (existsSync(file)) unlinkSync(file);
    return { ok: true, message: "LaunchAgent removed.", files: [file] };
  }
  if (platform === "linux") {
    try {
      exec("systemctl", ["--user", "disable", "--now", "quietapply.timer"]);
    } catch {
      // not enabled
    }
    return { ok: true, message: "systemd timer disabled.", files: [] };
  }
  if (platform === "win32") {
    try {
      exec("schtasks", schtasksDeleteArgs());
    } catch {
      // no such task
    }
    const t = p && windowsTaskFiles("", "", p.home);
    const files = t ? [t.cmdPath, t.vbsPath] : [];
    for (const f of files) if (existsSync(f)) unlinkSync(f);
    return { ok: true, message: "Task Scheduler task removed.", files };
  }
  return { ok: false, message: "Nothing to remove on this platform.", files: [] };
}

export function scheduleInstalled(o: ScheduleEnv = {}): boolean {
  const platform = o.platform ?? process.platform;
  if (platform === "darwin") return existsSync(launchdPath());
  if (platform === "linux") return existsSync(join(systemdDir(), "quietapply.timer"));
  if (platform === "win32") {
    try {
      (o.exec ?? realExec)("schtasks", schtasksQueryArgs());
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
