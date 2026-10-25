import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../core/db.js";
import { type Paths, packageRoot } from "../core/paths.js";
import type { Application } from "../core/store.js";
import { coreAnswers, relevantAnswers } from "../memory/answers.js";
import { type Profile, profileForPrompt } from "../memory/profile.js";
import type { FormInfo } from "../sources/types.js";

export function systemPrompt(): string {
  return readFileSync(join(packageRoot(), "prompts", "system.md"), "utf8");
}

export function playbook(ats: string): string {
  const file = join(packageRoot(), "playbooks", `${ats}.md`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function siteNotes(p: Paths, url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const file = join(p.siteNotes, `${host}.md`);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(-20).join("\n") : "";
  } catch {
    return "";
  }
}

/**
 * The prompt for one application: fixed instructions, the ATS playbook, then only the data this form
 * needs (compact profile, answers matching the expected questions, a few core answers). The full answer
 * memory stays behind `lookup_answers`, so the prompt does not grow as the memory does.
 */
export function buildPrompt(opts: {
  db: DB;
  p: Paths;
  app: Application;
  profile: Profile;
  mode: "dry_run" | "review" | "live";
  form?: FormInfo;
  /** Where the resume copy for this run lives (inside the agent's working folder). */
  resumePath?: string;
}): string {
  const { db, p, app, profile, mode, form } = opts;
  const ctx = { company: app.company, ats: app.ats };
  const answers = new Map<string, { question: string; memoryId: string; answer: string }>();
  for (const a of form
    ? relevantAnswers(
        db,
        profile,
        form.fields.map((f) => f.label),
        ctx,
      )
    : [])
    answers.set(a.question, a);
  for (const a of coreAnswers(db, ctx))
    if (![...answers.values()].some((x) => x.memoryId === a.memoryId)) answers.set(a.question, a);
  const resume = opts.resumePath ?? (profile.resumeFile ? join(p.resumeDir, profile.resumeFile) : undefined);
  const notes = siteNotes(p, app.url);

  const sections = [
    systemPrompt(),
    playbook(app.ats),
    "## This run",
    "```json",
    JSON.stringify(
      {
        mode,
        job: {
          applicationId: app.id,
          company: app.company,
          title: app.title,
          url: app.url,
          ats: app.ats,
          location: app.location,
        },
        resumeFile: resume ?? "none on file: ask_human if the form requires a resume",
        profile: profileForPrompt(profile),
        knownAnswers: [...answers.values()],
        expectedQuestions: form?.fields.map((f) => ({
          label: f.label,
          type: f.type,
          required: f.required,
          options: f.options,
        })),
      },
      null,
      2,
    ),
    "```",
    notes ? `## Notes from earlier runs on this site\n${notes}` : "",
    mode === "live"
      ? "Mode is live: submit only if start_submit returns proceed: true."
      : `Mode is ${mode}: fill the form, call start_submit, and do NOT click Submit.`,
  ];
  return sections.filter(Boolean).join("\n\n");
}
