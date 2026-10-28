import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/config.js";
import type { DB } from "../core/db.js";
import {
  type FilledValue,
  filledFromEvidence,
  type HandoffReason,
  openHandoff,
  recordHandoff,
  toReason,
} from "../core/handoffs.js";
import { allowance, companyAllowed } from "../core/limits.js";
import type { Paths } from "../core/paths.js";
import { type Application, askQuestion, getApplication, openQuestionsFor, setStatus } from "../core/store.js";
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
      question: input.question,
      context: input.context ?? `${a.title} at ${a.company}`,
      options: input.options,
      fieldType: input.fieldType,
    });
    if (a.status !== "needs_answers")
      setStatus(this.db, a.id, "needs_answers", { reason: "waiting for your answers" });
    const open = openQuestionsFor(this.db, a.id).map((x) => x.question);
    this.handoff("unknown_question", {
      detail: `${open.length} question${open.length > 1 ? "s" : ""} with no stored answer: ${open.join(" · ")}`,
      needed:
        "Answer the question(s) in Questions. The job is queued again by itself once they are answered.",
    });
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
    if (openQuestionsFor(this.db, a.id).length)
      return {
        proceed: false,
        mode: "questions",
        instruction: "This application has open questions for the human. Stop without submitting.",
      };
    const evidence = JSON.stringify({ filled, at: new Date().toISOString() });
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
        instruction: "REVIEW MODE. Do not click Submit. The human approves in the dashboard; end the run.",
      };
    }
    if (
      allowance(this.db, this.config).remainingToday <= 0 ||
      !companyAllowed(this.db, this.config, a.company)
    ) {
      const reason = "daily or per-company limit reached";
      setStatus(this.db, a.id, "skipped", { reason: `form filled, but ${reason}`, evidence });
      this.handoff("cap", { detail: `The form is filled, but the ${reason}.`, filled });
      return {
        proceed: false,
        mode: "cap",
        instruction: "Daily or per-company limit reached. Do not submit.",
      };
    }
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
    if (input.outcome === "unclear")
      this.handoff("unclear_submit", {
        detail: input.evidence.slice(0, 300),
        needed: "Check the company's site or your email to see whether the application arrived.",
      });
    else if (input.outcome === "failed") this.handoff("form_error", { detail: input.evidence.slice(0, 300) });
    return { ok: true };
  }

  markBlocked(input: {
    category: string;
    notes: string;
    needed?: string;
    filled?: FilledValue[];
    prefilled?: Record<string, string>;
    rule?: string;
  }) {
    const a = this.app();
    const reason = toReason(input.category);
    const filled = [
      ...(input.filled ?? []),
      ...Object.entries(input.prefilled ?? {}).map(([field, value]) => ({ field, value })),
    ];
    const keep = filled.length ? filled : filledFromEvidence(a.evidence);
    setStatus(this.db, a.id, "blocked", {
      reason: input.notes.slice(0, 500),
      blockedCategory: reason,
      evidence: filled.length
        ? JSON.stringify({ prefilled: Object.fromEntries(filled.map((f) => [f.field, f.value])) })
        : undefined,
    });
    this.handoff(reason, { detail: input.notes, needed: input.needed, rule: input.rule, filled: keep });
    return {
      ok: true,
      instruction: "Handed to the human (Finish yourself list). Leave the page as it is and end.",
    };
  }

  /**
   * The structured end-of-run report. Call it last: the dashboard reads the reason, what is needed and the
   * fields you filled from here, not from your closing message. If you have not handed the job over yet, a
   * non-"done" outcome does it for you.
   */
  reportOutcome(input: {
    outcome: "filled" | "submitted" | "handed_over" | "waiting_for_answers" | "failed";
    reason?: string;
    detail?: string;
    needed?: string;
    filled?: FilledValue[];
  }) {
    const a = this.app();
    const open = openHandoff(this.db, a.id);
    const handled = ["blocked", "needs_answers", "failed", "unclear", "skipped"].includes(a.status);
    if ((input.outcome === "handed_over" || input.outcome === "failed") && !handled)
      return this.markBlocked({
        category: input.reason ?? (input.outcome === "failed" ? "form_error" : "other"),
        notes: input.detail ?? "The agent handed this job back without details.",
        needed: input.needed,
        filled: input.filled,
      });
    if (open && input.filled?.length)
      this.handoff(open.reason, {
        detail: open.detail,
        needed: input.needed ?? open.needed,
        filled: input.filled,
      });
    return { ok: true, status: this.app().status };
  }

  /** Write the handoff record, keeping what was already filled when this call does not say. */
  private handoff(
    reason: HandoffReason,
    h: { detail: string; needed?: string; rule?: string; filled?: FilledValue[] },
  ) {
    const prev = openHandoff(this.db, this.applicationId);
    recordHandoff(this.db, {
      applicationId: this.applicationId,
      reason,
      detail: h.detail,
      needed: h.needed,
      rule: h.rule,
      filled: h.filled?.length ? h.filled : prev?.filled,
    });
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
