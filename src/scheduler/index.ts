import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Paths } from "../core/paths.js";
import { LABEL, launchdPath, launchdPlist, systemdDir, systemdUnits } from "./units.js";

export interface ScheduleResult {
  ok: boolean;
  message: string;
  files: string[];
}

/** Install the OS timer that calls `quietapply tick`. `dryRun` only reports what would be written. */
export function scheduleOn(p: Paths, cli: string, opts: { dryRun?: boolean } = {}): ScheduleResult {
  const node = process.execPath;
  if (process.platform === "darwin") {
    const file = launchdPath();
    if (opts.dryRun) return { ok: true, message: launchdPlist(node, cli, p.home), files: [file] };
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, launchdPlist(node, cli, p.home));
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid?.()}/${LABEL}`], { stdio: "ignore" });
    } catch {
      // not loaded yet
    }
    execFileSync("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, file]);
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
  if (process.platform === "linux") {
    const dir = systemdDir();
    const units = systemdUnits(node, cli, p.home);
    const files = [join(dir, "quietapply.service"), join(dir, "quietapply.timer")];
    if (opts.dryRun) return { ok: true, message: `${units.service}\n${units.timer}`, files };
    mkdirSync(dir, { recursive: true });
    writeFileSync(files[0]!, units.service);
    writeFileSync(files[1]!, units.timer);
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", "quietapply.timer"]);
    return { ok: true, message: "systemd user timer enabled: checks every 15 minutes.", files };
  }
  return {
    ok: false,
    message: "Scheduling is supported on macOS and Linux for now (Windows is planned).",
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

export function scheduleOff(): ScheduleResult {
  if (process.platform === "darwin") {
    const file = launchdPath();
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid?.()}/${LABEL}`], { stdio: "ignore" });
    } catch {
      // not loaded
    }
    if (existsSync(file)) unlinkSync(file);
    return { ok: true, message: "LaunchAgent removed.", files: [file] };
  }
  if (process.platform === "linux") {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", "quietapply.timer"], { stdio: "ignore" });
    } catch {
      // not enabled
    }
    return { ok: true, message: "systemd timer disabled.", files: [] };
  }
  return { ok: false, message: "Nothing to remove on this platform.", files: [] };
}

export function scheduleInstalled(): boolean {
  if (process.platform === "darwin") return existsSync(launchdPath());
  if (process.platform === "linux") return existsSync(join(systemdDir(), "quietapply.timer"));
  return false;
}
