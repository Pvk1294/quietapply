import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importResume } from "../../src/cli/setup.js";
import type { WizardContext, WizardDeps } from "../../src/cli/wizard/context.js";
import type { Prompter } from "../../src/cli/wizard/prompter.js";
import { defaultConfig, loadConfig } from "../../src/core/config.js";
import { openDb } from "../../src/core/db.js";
import { ensureHome, paths } from "../../src/core/paths.js";
import { loadProfile } from "../../src/memory/profile.js";
import type { Detection, Provider } from "../../src/providers/types.js";
import type { Fetcher } from "../../src/sources/http.js";

/** One scripted answer: the first question whose message matches gets the value (then it is used up). */
export type Answer = [string | RegExp, unknown];

export interface Scripted extends Prompter {
  asked: string[];
  shown: string[];
  /** Answers that were never asked for: a sign the script and the wizard drifted apart. */
  unused(): Answer[];
}

/**
 * A Prompter driven by a script. Questions not in the script get their pre-filled value, like a person
 * pressing Enter. An Error as the value is thrown (use SetupCancelled to simulate quitting).
 */
export function scripted(answers: Answer[]): Scripted {
  const queue = [...answers];
  const asked: string[] = [];
  const shown: string[] = [];
  const take = <T>(message: string, fallback: T): T => {
    asked.push(message);
    const i = queue.findIndex(([m]) => (typeof m === "string" ? message.includes(m) : m.test(message)));
    if (i < 0) return fallback;
    const [, v] = queue.splice(i, 1)[0]!;
    if (v instanceof Error) throw v;
    return v as T;
  };
  const log = (m: string) => {
    shown.push(m);
  };
  return {
    interactive: true,
    asked,
    shown,
    unused: () => queue,
    intro: log,
    outro: log,
    note: (b, t) => log(`${t ?? ""}\n${b}`),
    info: log,
    warn: log,
    success: log,
    step: log,
    async text(o) {
      const v = String(take(o.message, o.initial ?? ""));
      const err = o.validate?.(v);
      if (err) throw new Error(`"${o.message}" rejected "${v}": ${err}`);
      return v.trim();
    },
    select: async (o) => take(o.message, o.initial ?? o.options[0]!.value),
    multiselect: async (o) => take(o.message, o.initial ?? []),
    confirm: async (o) => take(o.message, o.initial ?? true),
    async spin(label, work, done) {
      const r = await work();
      log(done ? done(r) : label);
      return r;
    },
  };
}

/** A provider whose detect() returns the given results in turn (the last one repeats). */
export function stubProvider(id: "claude-code" | "codex", detections: Partial<Detection>[]): Provider {
  let i = 0;
  return {
    id,
    label: id === "codex" ? "OpenAI Codex" : "Claude Code",
    async detect() {
      const d = detections[Math.min(i++, detections.length - 1)]!;
      return { installed: false, notes: [], ...d };
    },
    complete: async () => "",
    runAgent: async () => ({ status: "completed", text: "", exitCode: 0 }),
  };
}

/** Public job-board API answers for a few made-up companies, plus one careers page with an embedded board. */
export const boardFetcher: Fetcher = async (url) => {
  const gh = /boards-api\.greenhouse\.io\/v1\/boards\/([\w-]+)(\/jobs)?$/.exec(url);
  if (gh?.[1] === "acmerockets")
    return gh[2]
      ? JSON.stringify({
          jobs: [
            { title: "Software Engineer", location: { name: "Bengaluru, India" } },
            { title: "Product Designer", location: { name: "Remote - US" } },
          ],
        })
      : JSON.stringify({ name: "Acme Rockets" });
  if (/api\.lever\.co\/v0\/postings\/globex\?mode=json$/.test(url))
    return JSON.stringify([
      { text: "Backend Developer", categories: { location: "Pune" }, workplaceType: "hybrid" },
    ]);
  if (url === "https://globex.example/careers")
    return '<html><body><iframe src="https://jobs.lever.co/globex?embed=1"></iframe></body></html>';
  if (url === "https://nothing.example/careers") return "<html><body>No jobs here</body></html>";
  throw new Error(`404 Not Found for ${url}`);
};

export function wizardHome(): WizardContext["dirs"] {
  return ensureHome(paths(mkdtempSync(join(tmpdir(), "qa-wizard-"))));
}

/** A wizard context in a fresh temp data folder with stubbed side effects. */
export function makeCtx(
  ui: Prompter,
  over: Partial<WizardDeps> = {},
  opts: WizardContext["opts"] = {},
  dirs = wizardHome(),
): WizardContext & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ui,
    dirs,
    db: openDb(dirs),
    config: { ...(loadConfig(dirs) ?? defaultConfig()), provider: "fake" },
    profile: loadProfile(dirs),
    deps: {
      providers: {
        "claude-code": stubProvider("claude-code", [
          { installed: true, version: "2.0.0", loggedIn: true, authMethod: "subscription" },
        ]),
        codex: stubProvider("codex", [{ installed: false }]),
      },
      fetcher: boardFetcher,
      importResume: (file, p) => importResume(file, p),
      doctor: async () => {
        calls.push("doctor");
        return [{ name: "Node.js", ok: true, detail: "22.13.0" }];
      },
      scheduleOn: () => {
        calls.push("schedule");
        return { ok: true, message: "Scheduled" };
      },
      discover: async () => {
        calls.push("discover");
        return { found: 3, added: 2, alreadyKnown: 0, skipped: {}, errors: [] };
      },
      ...over,
    },
    opts,
  };
}

export const RESUME = join(import.meta.dirname, "../../fixtures/persona/jane-doe-resume.txt");
