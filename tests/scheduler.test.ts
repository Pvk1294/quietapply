import { describe, expect, it } from "vitest";
import { macProtectedFolder } from "../src/scheduler/index.js";
import { dueSlot, retryDue } from "../src/scheduler/slots.js";
import { launchdPlist, systemdUnits } from "../src/scheduler/units.js";

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
  it("writes a systemd timer", () => {
    const u = systemdUnits("/usr/bin/node", "/opt/qa/dist/cli/index.js", "/home/test/.quietapply");
    expect(u.service).toContain("ExecStart=/usr/bin/node /opt/qa/dist/cli/index.js tick");
    expect(u.timer).toContain("OnUnitActiveSec=15min");
  });
});

describe("macOS protected folders", () => {
  it("spots a clone in Desktop, Documents or Downloads, where background jobs hang", () => {
    const home = "/Users/test";
    expect(macProtectedFolder("/Users/test/Desktop/quietapply/dist/cli/index.js", home)).toBe("Desktop");
    expect(macProtectedFolder("/Users/test/Documents/code/quietapply/dist/cli/index.js", home)).toBe(
      "Documents",
    );
    expect(macProtectedFolder("/Users/test/code/quietapply/dist/cli/index.js", home)).toBeUndefined();
    expect(macProtectedFolder("/Users/test/DesktopApps/quietapply/index.js", home)).toBeUndefined();
  });
});
