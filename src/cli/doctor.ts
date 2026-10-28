import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { paths } from "../core/paths.js";
import { loadProfile } from "../memory/profile.js";
import { getProvider } from "../providers/index.js";
import { version } from "../providers/spawn.js";
import { scheduleInstalled } from "../scheduler/index.js";

export interface Check {
  name: string;
  ok: boolean | "warn";
  detail: string;
}

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app",
    "/Applications/Microsoft Edge.app",
    "/Applications/Chromium.app",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
  ],
  win32: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
};

/** Everything a run needs, checked without changing anything. */
export async function doctor(): Promise<Check[]> {
  const p = paths();
  const checks: Check[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  checks.push({
    name: "Node.js",
    ok: major > 22 || (major === 22 && minor >= 13),
    detail: `${process.versions.node} (needs 22.13+ for built-in SQLite)`,
  });

  const homeOk = existsSync(p.home);
  const mode = homeOk ? statSync(p.home).mode & 0o777 : 0;
  checks.push({
    name: "Data folder",
    ok: homeOk ? (mode === 0o700 || process.platform === "win32" ? true : "warn") : false,
    detail: homeOk ? `${p.home} (mode ${mode.toString(8)})` : `${p.home} missing: run quietapply init`,
  });

  let config: ReturnType<typeof loadConfig> | undefined;
  try {
    config = loadConfig(p);
    checks.push({
      name: "Config",
      ok: existsSync(p.config),
      detail: existsSync(p.config) ? p.config : "not created yet: run quietapply init",
    });
  } catch (err) {
    checks.push({ name: "Config", ok: false, detail: `invalid: ${(err as Error).message.slice(0, 200)}` });
  }

  const profile = loadProfile(p);
  checks.push({
    name: "Profile",
    ok: !!(profile.name && profile.email),
    detail: profile.name
      ? `${profile.name}, ${profile.skills.length} skills, ${profile.experience.length} roles`
      : "no profile: run quietapply init --resume <file>",
  });
  const resume = profile.resumeFile ? join(p.resumeDir, profile.resumeFile) : undefined;
  checks.push({ name: "Resume file", ok: !!resume && existsSync(resume), detail: resume ?? "none" });

  if (config) {
    const provider = getProvider(config.provider);
    const d = await provider.detect();
    checks.push({
      name: `Provider: ${provider.label}`,
      ok: d.installed && d.loggedIn !== false,
      detail:
        [d.version, d.authMethod && d.authMethod !== "unknown" ? d.authMethod : "", ...d.notes]
          .filter(Boolean)
          .join(" · ") || "not installed",
    });
    if (config.browser !== "claude-in-chrome") {
      const chrome = (CHROME_PATHS[process.platform] ?? []).find((f) => existsSync(f));
      checks.push({
        name: "Browser (Chrome/Edge)",
        ok: chrome ? true : "warn",
        detail: chrome ?? "not found in the usual places; Playwright can install its own",
      });
      const npx = await version("npx");
      checks.push({ name: "npx (for Playwright MCP)", ok: !!npx, detail: npx ?? "not found" });
    } else {
      checks.push({
        name: "Claude in Chrome",
        ok: config.auth === "subscription" ? "warn" : false,
        detail:
          config.auth === "subscription"
            ? "needs the Claude in Chrome extension signed in to your Claude plan"
            : "not available with an API key; use playwright-profile",
      });
    }
    checks.push({
      name: "Dry run",
      ok: config.dryRun ? "warn" : true,
      detail: config.dryRun
        ? "ON: nothing will be submitted"
        : "off: applications are submitted (review mode first)",
    });
    checks.push({
      name: "Companies",
      ok: config.companies.length ? true : "warn",
      detail: `${config.companies.length} on the watch list`,
    });
    if (config.sources.linkedin && config.browser !== "claude-in-chrome")
      checks.push({
        name: "Claude in Chrome (LinkedIn)",
        ok: "warn",
        detail:
          "LinkedIn runs use your own Chrome through the Claude in Chrome extension, signed in to LinkedIn",
      });
    checks.push({
      name: "LinkedIn",
      ok: true,
      detail: config.sources.linkedin
        ? `ON since ${config.linkedin.acceptedAt} (you accepted the risk); ${config.linkedin.perDay} a day`
        : "off (default)",
    });
  }
  checks.push({
    name: "Schedule",
    ok: scheduleInstalled() ? true : "warn",
    detail: scheduleInstalled() ? "installed" : "not installed: quietapply schedule on",
  });
  return checks;
}
