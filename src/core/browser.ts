import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Where Chrome and Edge are usually installed. On Windows: per machine (both Program Files) or per user.
 * Chromium is not listed: Playwright MCP opens Chrome or Edge, and refuses to start with anything else.
 */
export function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") return ["/Applications/Google Chrome.app", "/Applications/Microsoft Edge.app"];
  if (platform === "linux")
    return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/microsoft-edge"];
  if (platform === "win32") {
    const roots = [
      env.ProgramFiles ?? "C:\\Program Files",
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      env.LOCALAPPDATA,
    ].filter((r): r is string => !!r);
    return roots.flatMap((r) => [
      win32.join(r, "Google", "Chrome", "Application", "chrome.exe"),
      win32.join(r, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
  }
  return [];
}

/** The first Chrome or Edge that exists. */
export function findBrowser(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (f: string) => boolean = existsSync,
): string | undefined {
  return browserCandidates(platform, env).find(exists);
}

/** Playwright MCP opens Google Chrome unless told otherwise, so a computer with only Edge has to say so. */
export function playwrightBrowserArgs(found: string | undefined = findBrowser()): string[] {
  return found && /edge/i.test(found) ? ["--browser", "msedge"] : [];
}
