import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "../core/paths.js";

/** Each agent run works in `logs/run-<run>/app-<application>/`; screenshots and the guard log land there. */
export function runFolder(p: Paths, run: number, applicationId: number): string {
  return join(p.logsDir, `run-${run}`, `app-${applicationId}`);
}

export interface Screenshot {
  run: number;
  file: string;
  at: string;
}

const RUN_DIR = /^run-(\d+)$/;
const IMAGE = /^[\w.-]+\.(png|jpe?g)$/i;

/** The screenshots the agent saved for one application, newest first. */
export function screenshotsFor(p: Paths, applicationId: number): Screenshot[] {
  if (!existsSync(p.logsDir)) return [];
  const out: Screenshot[] = [];
  for (const dir of readdirSync(p.logsDir)) {
    const run = RUN_DIR.exec(dir)?.[1];
    if (!run) continue;
    const folder = runFolder(p, Number(run), applicationId);
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder)) {
      if (!IMAGE.test(file)) continue;
      out.push({ run: Number(run), file, at: statSync(join(folder, file)).mtime.toISOString() });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || b.run - a.run);
}

/** The file for one screenshot, or undefined when the name is not a plain image file name in that folder. */
export function screenshotFile(
  p: Paths,
  applicationId: number,
  run: number,
  file: string,
): string | undefined {
  if (!Number.isInteger(run) || run < 0 || !IMAGE.test(file)) return undefined;
  const path = join(runFolder(p, run, applicationId), file);
  return existsSync(path) ? path : undefined;
}

/** How many requests the dry-run guard stopped in one run of an application. */
export function blockedRequests(p: Paths, applicationId: number, run: number): number {
  const log = join(runFolder(p, run, applicationId), "blocked-requests.jsonl");
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8").split("\n").filter(Boolean).length;
}
