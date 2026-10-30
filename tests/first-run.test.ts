import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MIN_NODE, nodeTooOld, nodeTooOldMessage } from "../src/cli/node-check.js";
import { browserCandidates, playwrightBrowserArgs } from "../src/core/browser.js";
import { defaultConfig, saveConfig } from "../src/core/config.js";
import { openDb } from "../src/core/db.js";
import { ensureHome, paths } from "../src/core/paths.js";
import { addApplication, getApplication } from "../src/core/store.js";
import { claudeCode } from "../src/providers/claude-code.js";
import { mcpServers, runOnce } from "../src/runner/run.js";
import { scheduleOn, scheduleState, setAutoStart } from "../src/scheduler/index.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "qa-first-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("Node.js too old", () => {
  it("draws the line at 22.13, the first release with node:sqlite without a flag", () => {
    for (const v of ["12.22.12", "18.20.8", "20.20.2", "22.5.0", "22.12.0"]) expect(nodeTooOld(v)).toBe(true);
    for (const v of ["22.13.0", "22.23.4", "23.0.0", "24.22.2", "26.13.0"]) expect(nodeTooOld(v)).toBe(false);
  });

  it("says which version is here, which is needed and how to get it", () => {
    const m = nodeTooOldMessage("20.20.2");
    expect(m).toContain("Node.js 22.13 or newer");
    expect(m).toContain("Node.js 20.20.2");
    expect(m).toContain("https://nodejs.org");
  });

  it("keeps the minimum the same as package.json", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${MIN_NODE}`);
  });

  it("runs the check before anything that can load node:sqlite", () => {
    const entry = readFileSync("src/cli/index.ts", "utf8");
    expect(entry.indexOf("./node-check.js")).toBeGreaterThan(-1);
    expect(entry.indexOf("./node-check.js")).toBeLessThan(entry.indexOf("./main.js"));
    expect(entry).not.toMatch(/^\s*await /m); // top-level await is a syntax error on the oldest versions
    expect(readFileSync("src/cli/node-check.ts", "utf8")).not.toMatch(/^import /m);
  });

  const built = "dist/cli/node-check.js";
  it.skipIf(!existsSync(built))("the built check speaks and exits 1 when the version is too old", () => {
    // The real process.versions is read when the module loads, so a preload stands in for an old Node.js.
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `Object.defineProperty(process.versions, "node", { value: "20.20.2" }); await import("${pathToFileURL(built).href}");`,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("This computer is running Node.js 20.20.2");
    expect(r.stderr).not.toContain("ERR_UNKNOWN_BUILTIN_MODULE");
  });
});

describe("no Chrome", () => {
  it("does not offer Chromium, which Playwright MCP refuses to start", () => {
    for (const os of ["darwin", "linux"] as const)
      expect(browserCandidates(os).some((b) => /chromium/i.test(b))).toBe(false);
  });

  it("tells Playwright to use Edge when Edge is all there is, and says nothing for Chrome", () => {
    expect(playwrightBrowserArgs("/Applications/Microsoft Edge.app")).toEqual(["--browser", "msedge"]);
    expect(
      playwrightBrowserArgs("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"),
    ).toEqual(["--browser", "msedge"]);
    expect(playwrightBrowserArgs("/Applications/Google Chrome.app")).toEqual([]);
    expect(playwrightBrowserArgs(undefined)).toEqual([]);
  });

  it("passes that choice to Playwright MCP", () => {
    const p = ensureHome(paths(tmp()));
    const edge = ["--browser", "msedge"];
    const args = mcpServers(defaultConfig(), p, 1, true, "/tmp/run", false, edge).playwright!.args!;
    expect(args.slice(args.indexOf("--browser"), args.indexOf("--browser") + 2)).toEqual(edge);
  });
});

describe("the chosen AI is not installed", () => {
  it("stops before touching the queue and says what to install", async () => {
    const p = ensureHome(paths(tmp()));
    saveConfig({ ...defaultConfig(), provider: "claude-code" }, p);
    const db = openDb(p);
    const { id } = addApplication(db, {
      url: "https://boards.greenhouse.io/acme/jobs/1",
      company: "Acme",
      title: "Software Engineer",
      ats: "greenhouse",
      source: "manual",
    });
    const detect = vi
      .spyOn(claudeCode, "detect")
      .mockResolvedValue({ installed: false, notes: ["Install Claude Code: https://code.claude.com/docs"] });
    const lines: string[] = [];
    const s = await runOnce({ p, log: (l) => lines.push(l) });
    detect.mockRestore();
    expect(s.status).toBe("failed");
    expect(s.message).toContain("Claude Code is not installed");
    expect(s.message).toContain("https://code.claude.com/docs");
    expect(lines.join("\n")).not.toContain("apply Acme");
    expect(getApplication(db, id)?.status).toBe("queued");
    db.close();
  });
});

describe("the OS will not run background jobs", () => {
  const refuse = (command: string) => () => {
    throw new Error(`spawnSync ${command} ENOENT`);
  };

  it("Linux without systemd: a plain message and nothing left behind that says it is on", () => {
    const userHome = tmp();
    const p = ensureHome(paths(join(userHome, ".quietapply")));
    const on = scheduleOn(p, "/opt/qa/dist/cli/index.js", {
      platform: "linux",
      exec: refuse("systemctl"),
      userHome,
    });
    expect(on.ok).toBe(false);
    expect(on.message).toContain("no systemd user session");
    expect(on.message).toContain("spawnSync systemctl ENOENT");
    expect(scheduleState({ platform: "linux", userHome })).toEqual({ dashboard: false, runs: false });
  });

  it("macOS: launchctl saying no is handled the same way", () => {
    const userHome = tmp();
    const p = ensureHome(paths(join(userHome, ".quietapply")));
    const on = scheduleOn(p, "/opt/qa/dist/cli/index.js", {
      platform: "darwin",
      exec: refuse("launchctl"),
      userHome,
    });
    expect(on.ok).toBe(false);
    expect(on.message).toContain("macOS would not start the background jobs");
    expect(scheduleState({ platform: "darwin", userHome })).toEqual({ dashboard: false, runs: false });
  });

  it("does not remember the choice when it did not work", () => {
    const userHome = tmp();
    const p = ensureHome(paths(join(userHome, ".quietapply")));
    saveConfig(defaultConfig(), p);
    const r = setAutoStart(p, "/opt/qa/dist/cli/index.js", true, {
      platform: "linux",
      exec: refuse("systemctl"),
      userHome,
    });
    expect(r.ok).toBe(false);
    expect(readFileSync(p.config, "utf8")).not.toContain("autoStart");
  });

  it("warns when the schedule would point into npx's temporary cache", () => {
    const userHome = tmp();
    const p = ensureHome(paths(join(userHome, ".quietapply")));
    saveConfig(defaultConfig(), p);
    const exec = () => {};
    const npx = "/Users/jane/.npm/_npx/b60dd886997f6865/node_modules/quietapply/dist/cli/index.js";
    const r = setAutoStart(p, npx, true, { platform: "linux", exec, userHome });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("npm install -g quietapply");
    const off = setAutoStart(p, "/opt/qa/dist/cli/index.js", true, { platform: "linux", exec, userHome });
    expect(off.message).not.toContain("npx");
  });
});
