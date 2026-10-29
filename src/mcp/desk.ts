import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/config.js";
import type { DB } from "../core/db.js";
import {
  closeHandoffs,
  type FilledValue,
  filledFromEvidence,
  type HandoffReason,
  openHandoff,
  recordHandoff,
  toReason,
} from "../core/handoffs.js";
import { allowance, companyAllowed } from "../core/limits.js";
import type { Paths } from "../core/paths.js";
import { checkFit } from "../core/rules.js";
import {
  type Application,
  askQuestion,
  getApplication,
  moveApplication,
  openQuestionsFor,
  setStatus,
  updateJobFacts,
} from "../core/store.js";
import {
  humanDelayMs,
  isLinkedInApp,
  linkedInEnabled,
  linkedInStop,
  looksLikeLinkedInWarning,
  type PaceKind,
  STOP_CATEGORIES,
  stopLinkedIn,
  typingChunks,
} from "../linkedin/mode.js";
import { getAnswer, type LookupResult, lookupAnswer, markUsed, parseMemoryId } from "../memory/answers.js";
import { PROFILE_FIELDS, type Profile, profileForPrompt } from "../memory/profile.js";
import { lockSubmitStep, logSubmitAttempt } from "../runner/chrome-guard.js";
import { detectAts } from "../sources/detect.js";

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
      mode: "dry_run" | "review" | "cap" | "questions" | "invalid" | "linkedin";
      instruction: string;
      problems?: string[];
    };

/**
 * The desk: everything the agent may read or change, bound to one application per run.
 * The MCP server (server.ts) is a thin wrapper over these methods, so they are tested directly.
 */
export interface DeskOptions {
  /** How a human pause is waited out. Tests pass a recorder instead of a real timer. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** The application's run folder. Set when the browser has no network guard (Claude in Chrome). */
  runDir?: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Desk {
  /** LinkedIn only: set once the agent has read the job on the page and it passed the fit gate. */
  private jobChecked = false;

  constructor(
    private db: DB,
    private config: Config,
    private profile: Profile,
    private p: Paths,
    readonly applicationId: number,
    private opts: DeskOptions = {},
  ) {}

  /** Whether this run is a LinkedIn application (decided once, at the start of the run). */
  isLinkedIn(): boolean {
    return isLinkedInApp(this.app());
  }

  private app(): Application {
    const a = getApplication(this.db, this.applicationId);
    if (!a) throw new Error(`Application ${this.applicationId} not found`);
    return a;
  }

  /**
   * The desk never hands out the submit step in dry run or review. Where the browser has no network guard
   * (Claude in Chrome) it also locks the run folder, so the tool-level hook refuses every later click, and
   * it logs the attempt.
   */
  private refuseSubmitStep(why: string): void {
    logSubmitAttempt(this.opts.runDir, `start_submit (${why})`);
    lockSubmitStep(this.opts.runDir, why);
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
    if (isLinkedInApp(a) && this.mode() !== "live") {
      // Claude in Chrome has no network guard like the Playwright path, so this check is the whole
      // protection: in dry run (and in review) a LinkedIn application is never submitted from here.
      const dry = this.mode() === "dry_run";
      this.refuseSubmitStep(dry ? "dry run" : "review");
      setStatus(this.db, a.id, dry ? "dry_run" : "awaiting_review", {
        reason: dry ? "dry run: form filled, not submitted" : "filled; waiting for your OK in the dashboard",
        evidence: JSON.stringify({ filled, at: new Date().toISOString() }),
      });
      return {
        proceed: false,
        mode: dry ? "dry_run" : "review",
        instruction: `${dry ? "DRY RUN" : "REVIEW MODE"} on LinkedIn. Do NOT click Submit application (or Review/Submit on the last Easy Apply step). Leave the form as it is and end the run.`,
      };
    }
    if (isLinkedInApp(a)) {
      const stop = linkedInStop(this.db);
      const why = !linkedInEnabled(this.config)
        ? "LinkedIn mode is off."
        : stop
          ? `LinkedIn mode is stopped: ${stop.reason}`
          : !this.jobChecked
            ? "Call job_details with what the job page shows first."
            : undefined;
      if (why)
        return {
          proceed: false,
          mode: "linkedin",
          instruction: `${why} Do not submit. End the run.`,
        };
    }
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
      this.refuseSubmitStep("dry run");
      setStatus(this.db, a.id, "dry_run", { reason: "dry run: form filled, not submitted", evidence });
      return {
        proceed: false,
        mode: "dry_run",
        instruction: "DRY RUN. Do not click Submit. Take a screenshot of the filled form, then end the run.",
      };
    }
    if (mode === "review") {
      this.refuseSubmitStep("review");
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
    if (input.outcome === "submitted" && this.mode() !== "live") {
      logSubmitAttempt(this.opts.runDir, "record_result(submitted)");
      throw new Error("record_result(submitted) in dry run or review mode: nothing may be submitted");
    }
    if (input.outcome === "submitted" && a.status !== "submitting")
      throw new Error("record_result(submitted) without start_submit approving it first");
    setStatus(this.db, a.id, input.outcome, {
      reason: input.evidence.slice(0, 500),
      evidence: input.evidence,
    });
    // A job that was handed back earlier (a rule, a question) and then went through is done.
    if (input.outcome === "submitted") closeHandoffs(this.db, a.id, "applied");
    else if (input.outcome === "unclear")
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
    const reason =
      isLinkedInApp(a) && looksLikeLinkedInWarning(input.notes) && toReason(input.category) === "other"
        ? "linkedin_limit"
        : toReason(input.category);
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
    if (
      isLinkedInApp(a) &&
      (STOP_CATEGORIES.includes(input.category) || looksLikeLinkedInWarning(input.notes))
    ) {
      stopLinkedIn(this.db, input.notes || input.category, a.id);
      return {
        ok: true,
        instruction:
          "LinkedIn mode is now stopped for all applications until the human looks. Do not click anything else on LinkedIn. End the run now.",
      };
    }
    return {
      ok: true,
      instruction:
        "Handed to the human (Finish yourself list). Take a screenshot, leave the page as it is and end.",
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

  // ---------- LinkedIn mode only ----------

  private linkedInApp(): Application {
    const a = this.app();
    if (!isLinkedInApp(a)) throw new Error("This tool is only for LinkedIn applications");
    return a;
  }

  /**
   * A random pause, decided here rather than by the agent, so the rhythm is never machine-regular:
   * "action" between clicks, "typing" between typed chunks, "page" after opening a new page.
   */
  async humanPause(kind: PaceKind): Promise<{ waitedMs: number; instruction?: string }> {
    this.linkedInApp();
    const ms = humanDelayMs(kind, this.opts.random);
    await (this.opts.sleep ?? realSleep)(ms);
    const stop = linkedInStop(this.db);
    return stop
      ? { waitedMs: ms, instruction: `LinkedIn mode was stopped (${stop.reason}). End the run now.` }
      : { waitedMs: ms };
  }

  /** How to type a longer answer: in chunks, with a "typing" pause between them. */
  typingPlan(text: string) {
    this.linkedInApp();
    const chunks = typingChunks(text);
    return {
      chunks,
      instruction:
        chunks.length > 1
          ? "Type each chunk with one type action, calling human_pause('typing') between chunks."
          : "Type it in one go.",
    };
  }

  /**
   * What the job page says (company, title, location, a little of the description). Saved on the
   * application and run through your fit gate before anything is filled in.
   */
  jobDetails(input: { company: string; title: string; location?: string; description?: string }) {
    const a = this.linkedInApp();
    updateJobFacts(this.db, a.id, {
      company: input.company.trim().slice(0, 200),
      title: input.title.trim().slice(0, 200),
      location: input.location?.trim().slice(0, 200),
      description: input.description?.slice(0, 4000),
    });
    const fit = checkFit(
      {
        company: input.company,
        title: input.title,
        location: input.location,
        description: input.description,
      },
      this.config.rules,
      this.profile,
    );
    if (!fit.fit) {
      setStatus(this.db, a.id, "skipped", { reason: fit.reason });
      return { fit: false, reason: fit.reason, instruction: "Not a fit. Do not apply. End the run." };
    }
    this.jobChecked = true;
    return { fit: true, instruction: "A fit. Carry on with Easy Apply or the company-site link." };
  }

  /**
   * LinkedIn sent the applicant to the company's own site. Greenhouse, Lever and Ashby continue with
   * QuietApply's normal flow (same answers, same rules); anything else goes to Finish yourself.
   */
  companySite(input: { url: string }) {
    const a = this.linkedInApp();
    const ref = detectAts(input.url);
    if (!ref) {
      const detail = `Applies on a site QuietApply does not support yet: ${input.url.slice(0, 200)}`;
      setStatus(this.db, a.id, "blocked", { reason: detail, blockedCategory: "unsupported_ats" });
      this.handoff("unsupported_ats", { detail, needed: "Apply on the company's site yourself." });
      return {
        continues: false,
        instruction: "Not a supported job site. Handed to the human. Leave the page and end the run.",
      };
    }
    const other = this.db
      .prepare("SELECT id FROM applications WHERE url = ? AND id != ?")
      .get(input.url, a.id) as { id: number } | undefined;
    if (other) {
      setStatus(this.db, a.id, "skipped", { reason: `same job is already in your list as #${other.id}` });
      return { continues: false, instruction: "Already in the list. End the run." };
    }
    const from = a.url;
    moveApplication(this.db, a.id, { url: input.url, ats: ref.ats });
    setStatus(this.db, a.id, "queued", {
      reason: `LinkedIn sent this to the company's ${ref.ats} page (from ${from}); continues with the normal flow`,
    });
    return {
      continues: true,
      instruction:
        "Noted. Stop here: QuietApply continues on the company site with its normal flow. Do not fill that form in this run. End the run.",
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
