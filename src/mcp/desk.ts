import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/config.js";
import type { DB } from "../core/db.js";
import { allowance, companyAllowed } from "../core/limits.js";
import type { Paths } from "../core/paths.js";
import {
  type Application,
  askQuestion,
  BLOCKED_CATEGORIES,
  type BlockedCategory,
  getApplication,
  openQuestionsFor,
  setStatus,
} from "../core/store.js";
import { getAnswer, type LookupResult, lookupAnswer, markUsed, parseMemoryId } from "../memory/answers.js";
import { PROFILE_FIELDS, type Profile, profileForPrompt } from "../memory/profile.js";

export interface FilledField {
  field: string;
  value: string;
  /** Where the value came from: "mem:12", "profile:email", "resume" (file upload) or "tailored:mem:12". */
  source: string;
}

export type SubmitDecision =
  | { proceed: true; instruction: string }
  | {
      proceed: false;
      mode: "dry_run" | "review" | "cap" | "questions" | "invalid";
      instruction: string;
      problems?: string[];
    };

/**
 * The desk: everything the agent may read or change, bound to one application per run.
 * The MCP server (server.ts) is a thin wrapper over these methods, so they are tested directly.
 */
export class Desk {
  constructor(
    private db: DB,
    private config: Config,
    private profile: Profile,
    private p: Paths,
    readonly applicationId: number,
  ) {}

  private app(): Application {
    const a = getApplication(this.db, this.applicationId);
    if (!a) throw new Error(`Application ${this.applicationId} not found`);
    return a;
  }

  mode(): "dry_run" | "review" | "live" {
    if (this.config.dryRun) return "dry_run";
    const app = this.app();
    if (allowance(this.db, this.config).reviewMode && !app.review_approved) return "review";
    return "live";
  }

  getJob() {
    const a = this.app();
    return {
      applicationId: a.id,
      company: a.company,
      title: a.title,
      url: a.url,
      ats: a.ats,
      location: a.location,
      mode: this.mode(),
    };
  }

  getProfile() {
    return profileForPrompt(this.profile);
  }

  lookupAnswers(questions: string[]): ({ question: string } & LookupResult)[] {
    const a = this.app();
    return questions.map((q) => {
      const r = lookupAnswer(this.db, this.profile, q, { company: a.company, ats: a.ats });
      if (r.status === "known" && r.memoryId.startsWith("mem:"))
        markUsed(this.db, Number(r.memoryId.slice(4)));
      return { question: q, ...r };
    });
  }

  askHuman(input: { question: string; context?: string; options?: string[]; fieldType?: string }) {
    const a = this.app();
    const q = askQuestion(this.db, {
      applicationId: a.id,
      // Labels copied off a form keep their required marker ("Cover letter*"); the question is the label.
      question: input.question.replace(/\s*(\*|✱|\(required\))\s*$/i, "").trim(),
      context: input.context ?? `${a.title} at ${a.company}`,
      options: input.options,
      fieldType: input.fieldType,
    });
    if (a.status !== "needs_answers")
      setStatus(this.db, a.id, "needs_answers", { reason: "waiting for your answers" });
    return {
      questionId: q.id,
      alreadyQueued: q.duplicate,
      instruction:
        "Queued for the human. Keep filling the fields you can, ask any other unknowns, then stop without submitting. This application continues in a later run.",
    };
  }

  checkDuplicate(input: { company: string; title: string; url: string }) {
    const rows = this.db
      .prepare(
        `SELECT id, status, url FROM applications
         WHERE id != ? AND (url = ? OR (lower(company) = lower(?) AND lower(title) = lower(?)))
           AND status IN ('submitted','submitting','unclear','awaiting_review')`,
      )
      .all(this.applicationId, input.url, input.company, input.title) as { id: number; status: string }[];
    return { duplicate: rows.length > 0, matches: rows };
  }

  /** Every typed value must cite where it came from; anything else is an invented answer. */
  validateFilled(filled: FilledField[]): string[] {
    const problems: string[] = [];
    for (const f of filled) {
      const src = f.source.replace(/^tailored:/, "");
      if (src === "resume") continue;
      const id = parseMemoryId(src);
      if (!id) problems.push(`${f.field}: source "${f.source}" is not a memory id`);
      else if (id.kind === "mem" && !getAnswer(this.db, id.id))
        problems.push(`${f.field}: ${src} does not exist`);
      else if (id.kind === "profile" && !PROFILE_FIELDS.some((p) => p.field === id.field))
        problems.push(`${f.field}: unknown profile field ${id.field}`);
    }
    return problems;
  }

  /**
   * Called right before clicking Submit. Records the filled values, then decides: dry run and review mode
   * stop here; otherwise the application is marked "submitting" first, so an unclear result is never
   * retried blindly.
   */
  startSubmit(filled: FilledField[]): SubmitDecision {
    const a = this.app();
    const problems = this.validateFilled(filled);
    if (problems.length)
      return {
        proceed: false,
        mode: "invalid",
        problems,
        instruction:
          "Some values have no memory id. Do not submit. Use lookup_answers for them, or ask_human, then call start_submit again.",
      };
    const evidence = JSON.stringify({ filled, at: new Date().toISOString() });
    if (openQuestionsFor(this.db, a.id).length) {
      // Keep what was filled so far, so the dashboard shows it next to the open questions.
      this.db
        .prepare("UPDATE applications SET evidence = ? WHERE id = ?")
        .run(JSON.stringify({ filled, at: new Date().toISOString(), partial: true }), a.id);
      return {
        proceed: false,
        mode: "questions",
        instruction:
          "This application has open questions for the human. Do not submit. Take a screenshot of the form, then end the run.",
      };
    }
    const mode = this.mode();
    if (mode === "dry_run") {
      setStatus(this.db, a.id, "dry_run", { reason: "dry run: form filled, not submitted", evidence });
      return {
        proceed: false,
        mode: "dry_run",
        instruction: "DRY RUN. Do not click Submit. Take a screenshot of the filled form, then end the run.",
      };
    }
    if (mode === "review") {
      setStatus(this.db, a.id, "awaiting_review", {
        reason: "filled; waiting for your OK in the dashboard",
        evidence,
      });
      return {
        proceed: false,
        mode: "review",
        instruction:
          "REVIEW MODE. Do not click Submit. Take a screenshot of the filled form; the human approves in the dashboard. End the run.",
      };
    }
    if (
      allowance(this.db, this.config).remainingToday <= 0 ||
      !companyAllowed(this.db, this.config, a.company)
    )
      return {
        proceed: false,
        mode: "cap",
        instruction: "Daily or per-company limit reached. Do not submit.",
      };
    setStatus(this.db, a.id, "submitting", { reason: "about to click Submit", evidence });
    return {
      proceed: true,
      instruction:
        "Click Submit once. Then call record_result with what the page shows. If the result is unclear, use outcome 'unclear'; never submit twice.",
    };
  }

  recordResult(input: { outcome: "submitted" | "unclear" | "failed"; evidence: string }) {
    const a = this.app();
    if (input.outcome === "submitted" && a.status !== "submitting")
      throw new Error("record_result(submitted) without start_submit approving it first");
    setStatus(this.db, a.id, input.outcome, {
      reason: input.evidence.slice(0, 500),
      evidence: input.evidence,
    });
    return { ok: true };
  }

  markBlocked(input: { category: string; notes: string; prefilled?: Record<string, string> }) {
    const a = this.app();
    const category = (BLOCKED_CATEGORIES as readonly string[]).includes(input.category)
      ? (input.category as BlockedCategory)
      : "other";
    setStatus(this.db, a.id, "blocked", {
      reason: input.notes.slice(0, 500),
      blockedCategory: category,
      evidence: input.prefilled ? JSON.stringify({ prefilled: input.prefilled }) : undefined,
    });
    return {
      ok: true,
      instruction:
        "Handed to the human (Finish yourself list). Take a screenshot, leave the page as it is and end.",
    };
  }

  /** How-to notes per site ("the resume field is a custom dropzone"). Personal facts are stripped. */
  addSiteNote(input: { host: string; note: string }) {
    const host = input.host.toLowerCase().replace(/[^a-z0-9.-]/g, "");
    if (!host) throw new Error("host is required");
    const note = input.note
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
      .replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]")
      .slice(0, 1000);
    appendFileSync(
      join(this.p.siteNotes, `${host}.md`),
      `- ${new Date().toISOString().slice(0, 10)}: ${note}\n`,
      {
        mode: 0o600,
      },
    );
    return { ok: true };
  }
}
