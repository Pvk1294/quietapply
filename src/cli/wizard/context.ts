import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Config } from "../../core/config.js";
import type { DB } from "../../core/db.js";
import type { Paths } from "../../core/paths.js";
import { listAnswers, saveAnswer } from "../../memory/answers.js";
import type { Profile } from "../../memory/profile.js";
import type { Provider } from "../../providers/types.js";
import type { DiscoverSummary } from "../../runner/discover.js";
import type { Fetcher } from "../../sources/http.js";
import type { Check } from "../doctor.js";
import type { importResume } from "../setup.js";
import type { Prompter } from "./prompter.js";

/** Everything with side effects outside the data folder, so tests can replace it. */
export interface WizardDeps {
  providers: { "claude-code": Provider; codex: Provider };
  fetcher: Fetcher;
  importResume: typeof importResume;
  doctor: () => Promise<Check[]>;
  scheduleOn: () => { ok: boolean; message: string };
  discover: () => Promise<DiscoverSummary>;
}

export interface WizardOptions {
  resume?: string;
  provider?: Config["provider"];
  /** Ask the optional standard questions too. */
  full?: boolean;
}

export interface WizardContext {
  ui: Prompter;
  dirs: Paths;
  db: DB;
  /** Loaded at the start; each finished step saves it. */
  config: Config;
  profile: Profile;
  deps: WizardDeps;
  opts: WizardOptions;
}

export interface Step {
  id: StepId;
  title: string;
  /** "skipped" leaves the step unfinished, so the next `quietapply init` offers it again. */
  run(ctx: WizardContext): Promise<undefined | "skipped">;
}

export const STEP_IDS = ["ai", "resume", "answers", "targets", "sources", "logins", "safety"] as const;
export type StepId = (typeof STEP_IDS)[number];

export interface SetupState {
  version: 1;
  done: StepId[];
  updatedAt?: string;
}

export function loadState(p: Paths): SetupState {
  if (!existsSync(p.setupState)) return { version: 1, done: [] };
  try {
    const s = JSON.parse(readFileSync(p.setupState, "utf8")) as Partial<SetupState>;
    return { version: 1, done: (s.done ?? []).filter((d): d is StepId => STEP_IDS.includes(d as StepId)) };
  } catch {
    return { version: 1, done: [] };
  }
}

export function saveState(p: Paths, s: SetupState): void {
  writeFileSync(p.setupState, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
}

/** "a, b,\nc" → ["a", "b", "c"] */
export function splitList(s: string | undefined): string[] {
  return (s ?? "")
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** The saved global answer for a key, to pre-fill a question. */
export function savedAnswer(db: DB, key: string): string | undefined {
  return listAnswers(db).find((a) => a.key === key && a.scope === "global")?.answer;
}

/** Save a setup answer, or leave memory alone when the person skipped it. */
export function remember(
  db: DB,
  key: string,
  question: string,
  answer: string,
  extra: { type?: string; sensitive?: boolean } = {},
): void {
  if (!answer.trim()) return;
  saveAnswer(db, { key, question, answer: answer.trim(), source: "setup", ...extra });
}
