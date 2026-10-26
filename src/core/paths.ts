import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where all user data lives. Override with QUIETAPPLY_HOME (tests and the demo use a temp folder). */
export function dataHome(): string {
  const fromEnv = process.env.QUIETAPPLY_HOME;
  return fromEnv ? resolve(fromEnv) : join(homedir(), ".quietapply");
}

export interface Paths {
  home: string;
  config: string;
  profile: string;
  db: string;
  resumeDir: string;
  logsDir: string;
  browserProfile: string;
  siteNotes: string;
  lock: string;
  pauseFlag: string;
  /** Which `quietapply init` steps are finished, so setup can continue where it stopped. */
  setupState: string;
}

export function paths(home = dataHome()): Paths {
  return {
    home,
    config: join(home, "config.yaml"),
    profile: join(home, "profile.yaml"),
    db: join(home, "data.db"),
    resumeDir: join(home, "resume"),
    logsDir: join(home, "logs"),
    browserProfile: join(home, "browser-profile"),
    siteNotes: join(home, "site-notes"),
    lock: join(home, "runner.lock"),
    pauseFlag: join(home, "PAUSED"),
    setupState: join(home, "setup-state.json"),
  };
}

/** Create the data folder with owner-only permissions (700). */
export function ensureHome(p: Paths = paths()): Paths {
  for (const dir of [p.home, p.resumeDir, p.logsDir, p.siteNotes]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(p.home, 0o700);
  } catch {
    // Windows or a filesystem without POSIX modes; nothing to do.
  }
  return p;
}

/** Root of the installed package (works from src/ under vitest and from dist/ after build). */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not find the QuietApply package root");
}
