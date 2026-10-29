import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveConfig } from "../src/core/config.js";
import { kvGet, openDb, openMemoryDb } from "../src/core/db.js";
import { ensureHome, paths } from "../src/core/paths.js";
import {
  macProtectedFolder,
  markScheduleStart,
  scheduleOff,
  scheduleOn,
  scheduleState,
  scheduleStatusLines,
  setAutoStart,
} from "../src/scheduler/index.js";
import { dueSlot, nextSlot, retryDue } from "../src/scheduler/slots.js";
import { launchdDashboardPlist, launchdPlist, systemdUnits } from "../src/scheduler/units.js";

const tmp = () => mkdtempSync(join(tmpdir(), "qa-sched-"));
const recorder = () => {
  const ran: string[] = [];
  return { ran, exec: (c: string, a: string[]) => void ran.push([c, ...a].join(" ")) };
};

const at = (iso: string) => new Date(iso);
const schedule = ["09:00", "13:00", "19:00"];

describe("due slots", () => {
  it("runs the latest passed slot once", () => {
    expect(dueSlot(at("2026-10-26T08:59:00Z"), schedule, undefined, "UTC")).toBeUndefined();
    expect(dueSlot(at("2026-10-26T09:05:00Z"), schedule, undefined, "UTC")).toBe("2026-10-26T09:00");
    expect(dueSlot(at("2026-10-26T09:20:00Z"), schedule, "2026-10-26T09:00", "UTC")).toBeUndefined();
  });
  it("coalesces slots missed while asleep into one run", () => {
    expect(dueSlot(at("2026-10-26T20:00:00Z"), schedule, "2026-10-25T19:00", "UTC")).toBe("2026-10-26T19:00");
  });
  it("catches up last evening's missed slot once in the morning, then the day goes on as usual", () => {
    // Off from 18:00 to 08:00: the 19:00 run happens once at 08:00, then 09:00 as planned.
    expect(dueSlot(at("2026-10-27T08:00:00Z"), schedule, "2026-10-26T13:00", "UTC")).toBe("2026-10-26T19:00");
    expect(dueSlot(at("2026-10-27T08:15:00Z"), schedule, "2026-10-26T19:00", "UTC")).toBeUndefined();
    expect(dueSlot(at("2026-10-27T09:05:00Z"), schedule, "2026-10-26T19:00", "UTC")).toBe("2026-10-27T09:00");
    // Never more than one run for many missed slots, and nothing older than yesterday.
    expect(dueSlot(at("2026-10-30T08:00:00Z"), schedule, "2026-10-26T09:00", "UTC")).toBe("2026-10-29T19:00");
  });
  it("names the next run", () => {
    expect(nextSlot(at("2026-10-26T10:00:00Z"), schedule, "UTC")).toBe("today 13:00");
    expect(nextSlot(at("2026-10-26T20:00:00Z"), schedule, "UTC")).toBe("tomorrow 09:00");
  });
  it("starts from now when turned on: no immediate run for slots already passed", () => {
    const db = openMemoryDb();
    const config = { ...defaultConfig(), timezone: "UTC" };
    markScheduleStart(db, config, at("2026-10-26T14:00:00Z"));
    const last = JSON.parse(kvGet(db, "schedule:last")!);
    expect(last.slot).toBe("2026-10-26T13:00");
    expect(dueSlot(at("2026-10-26T14:15:00Z"), schedule, last.slot, "UTC")).toBeUndefined();
    expect(dueSlot(at("2026-10-26T19:05:00Z"), schedule, last.slot, "UTC")).toBe("2026-10-26T19:00");
  });
  it("uses the configured time zone", () => {
    // 04:00 UTC is 09:30 in India.
    expect(dueSlot(at("2026-10-26T04:00:00Z"), schedule, undefined, "Asia/Kolkata")).toBe("2026-10-26T09:00");
  });
  it("retries a failed slot once after 15 minutes", () => {
    const failed = { slot: "2026-10-26T09:00", status: "failed", at: "2026-10-26T09:10:00Z" };
    expect(retryDue(at("2026-10-26T09:20:00Z"), failed)).toBeUndefined();
    expect(retryDue(at("2026-10-26T09:30:00Z"), failed)).toBe("2026-10-26T09:00");
    expect(retryDue(at("2026-10-26T09:30:00Z"), { ...failed, retried: "2026-10-26T09:00" })).toBeUndefined();
  });
});

describe("OS units", () => {
  it("writes a LaunchAgent that calls tick every 15 minutes", () => {
    const plist = launchdPlist("/usr/local/bin/node", "/opt/qa/dist/cli/index.js", "/Users/test/.quietapply");
    expect(plist).toContain("<string>tick</string>");
    expect(plist).toContain("<integer>900</integer>");
    expect(plist).toContain("/Users/test/.quietapply");
  });
  it("writes a login-item LaunchAgent for the dashboard on its port", () => {
    const plist = launchdDashboardPlist(
      "/usr/local/bin/node",
      "/opt/qa/cli.js",
      "/Users/test/.quietapply",
      4790,
    );
    expect(plist).toContain("<string>dashboard</string><string>--port</string><string>4790</string>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
  });
  it("writes systemd units: a wall-clock timer that catches up, and the dashboard service", () => {
    const u = systemdUnits("/usr/bin/node", "/opt/qa/dist/cli/index.js", "/home/test/.quietapply", 4790);
    expect(u.service).toContain("ExecStart=/usr/bin/node /opt/qa/dist/cli/index.js tick");
    expect(u.timer).toContain("OnCalendar=*:0/15");
    expect(u.timer).toContain("Persistent=true");
    expect(u.dashboard).toContain("ExecStart=/usr/bin/node /opt/qa/dist/cli/index.js dashboard --port 4790");
    expect(u.dashboard).toContain("WantedBy=default.target");
  });
});

describe("schedule on | off | status, per platform", () => {
  const cli = "/opt/qa/dist/cli/index.js";

  it("macOS: installs and loads both LaunchAgents, and removes both", () => {
    const userHome = tmp();
    const p = ensureHome(paths(join(userHome, ".quietapply")));
    const { ran, exec } = recorder();
    const on = scheduleOn(p, cli, { platform: "darwin", exec, userHome, port: 4777 });
    expect(on.ok).toBe(true);
    expect(on.files.map((f) => basename(f))).toEqual([
      "dev.quietapply.dashboard.plist",
      "dev.quietapply.tick.plist",
    ]);
    expect(ran.filter((r) => r.startsWith("launchctl bootstrap"))).toHaveLength(2);
    expect(readFileSync(on.files[0]!, "utf8")).toContain("<string>4777</string>");
    expect(scheduleState({ platform: "darwin", userHome })).toEqual({ dashboard: true, runs: true });
    expect(on.message).toContain("starts when you log in");
    scheduleOff(p, { platform: "darwin", exec, userHome });
    expect(ran.filter((r) => r.startsWith("launchctl bootout"))).toHaveLength(4);
    expect(on.files.some(existsSync)).toBe(false);
    expect(scheduleState({ platform: "darwin", userHome })).toEqual({ dashboard: false, runs: false });
  });

  it("Linux: enables the dashboard service and the timer as user units, and removes them", () => {
    const userHome = tmp();
    const p = ensureHome(paths(join(userHome, ".quietapply")));
    const { ran, exec } = recorder();
    const on = scheduleOn(p, cli, { platform: "linux", exec, userHome });
    expect(on.files.map((f) => basename(f))).toEqual([
      "quietapply-dashboard.service",
      "quietapply.service",
      "quietapply.timer",
    ]);
    expect(ran).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now quietapply-dashboard.service",
      "systemctl --user enable --now quietapply.timer",
    ]);
    expect(scheduleState({ platform: "linux", userHome })).toEqual({ dashboard: true, runs: true });
    scheduleOff(p, { platform: "linux", exec, userHome });
    expect(ran).toContain("systemctl --user disable --now quietapply-dashboard.service");
    expect(on.files.some(existsSync)).toBe(false);
  });

  it("turning on from setup or Settings remembers the choice and starts from now", () => {
    const userHome = tmp();
    const p = ensureHome(paths(join(userHome, ".quietapply")));
    saveConfig({ ...defaultConfig(), timezone: "UTC" }, p);
    const { exec } = recorder();
    expect(setAutoStart(p, cli, true, { platform: "linux", exec, userHome }).ok).toBe(true);
    expect(loadConfig(p).autoStart).toBe(true);
    const db = openDb(p);
    expect(
      kvGet(db, "schedule:last") === undefined ||
        JSON.parse(kvGet(db, "schedule:last")!).status === "skipped",
    ).toBe(true);
    db.close();
    setAutoStart(p, cli, false, { platform: "linux", exec, userHome });
    expect(loadConfig(p).autoStart).toBe(false);
    expect(scheduleState({ platform: "linux", userHome })).toEqual({ dashboard: false, runs: false });
  });

  it("status says what is installed, the times, the next run and the catch-up rule", () => {
    const lines = scheduleStatusLines(
      { dashboard: true, runs: true },
      { ...defaultConfig(), timezone: "UTC" },
      { slot: "2026-10-26T09:00", status: "completed" },
      at("2026-10-26T10:00:00Z"),
    ).join("\n");
    expect(lines).toContain("Run automatically: ON");
    expect(lines).toContain("09:00, 13:00, 19:00 (UTC)");
    expect(lines).toContain("Next run:           today 13:00");
    expect(lines).toContain("2026-10-26T09:00 completed");
    expect(lines).toContain("nothing runs while the computer is off");
    expect(scheduleStatusLines({ dashboard: true, runs: false }, defaultConfig(), {})[0]).toContain("PARTLY");
  });
});

describe("macOS protected folders", () => {
  it("spots a clone in Desktop, Documents or Downloads, where background jobs hang", () => {
    // Built with join, so the test also holds where the separator is a backslash.
    const home = join("/Users", "test");
    const at = (...parts: string[]) => join(home, ...parts);
    expect(macProtectedFolder(at("Desktop", "quietapply", "dist", "cli", "index.js"), home)).toBe("Desktop");
    expect(macProtectedFolder(at("Documents", "code", "quietapply", "dist", "cli", "index.js"), home)).toBe(
      "Documents",
    );
    expect(macProtectedFolder(at("code", "quietapply", "dist", "cli", "index.js"), home)).toBeUndefined();
    expect(macProtectedFolder(at("DesktopApps", "quietapply", "index.js"), home)).toBeUndefined();
  });
});
