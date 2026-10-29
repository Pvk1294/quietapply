import { type DB, now } from "./db.js";
import type { Application } from "./store.js";

/**
 * Why a job was skipped or stopped, in the words of the "Finish yourself" page. Every skip and every
 * hand-back writes one of these records, so nothing is dropped without a reason you can read.
 */
export const HANDOFF_REASONS = [
  "captcha",
  "login_required",
  "unknown_question",
  "file_upload",
  "unsupported_ats",
  "external_redirect",
  "linkedin_limit",
  "fit_gate",
  "cap",
  "form_error",
  "unclear_submit",
  "other",
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

interface ReasonInfo {
  label: string;
  /** What you can do about it, shown under the group heading. */
  help: string;
  /** Needs a person (as opposed to a rule or a limit doing its job). Counted in "N need you". */
  needsYou: boolean;
  /** Retry may help once something changed; the server checks the condition (see retryBlocker). */
  retryable: boolean;
}

export const REASONS: Record<HandoffReason, ReasonInfo> = {
  captcha: {
    label: "CAPTCHA or human check",
    help: "The site wants proof you are a person. Open the job and apply yourself.",
    needsYou: true,
    retryable: false,
  },
  login_required: {
    label: "Login or account needed",
    help: "The site wants an account, a password or a code sent to you.",
    needsYou: true,
    retryable: false,
  },
  unknown_question: {
    label: "A question with no answer yet",
    help: "Answer it in Questions and the job goes back in the queue by itself. Retry works once nothing is open.",
    needsYou: true,
    retryable: true,
  },
  file_upload: {
    label: "File upload problem",
    help: "The form wants a file it could not give (a special upload, a cover letter, a portfolio). Fix your files, then retry, or finish it yourself.",
    needsYou: true,
    retryable: true,
  },
  unsupported_ats: {
    label: "Job site not supported yet",
    help: "Workday and similar sites are not automated yet.",
    needsYou: true,
    retryable: false,
  },
  external_redirect: {
    label: "Sent to another site or email",
    help: "The posting leaves the job board (apply by email, an outside page).",
    needsYou: true,
    retryable: false,
  },
  linkedin_limit: {
    label: "LinkedIn limit or warning",
    help: "LinkedIn showed a limit or a warning. Stop and check your account before anything else.",
    needsYou: true,
    retryable: false,
  },
  fit_gate: {
    label: "Did not pass your rules",
    help: "A rule in Settings kept it out. Change the rule and retry, or leave it.",
    needsYou: false,
    retryable: true,
  },
  cap: {
    label: "Daily or per-company limit",
    help: "A limit was reached. Retry when the limit has room again.",
    needsYou: false,
    retryable: true,
  },
  form_error: {
    label: "Form error",
    help: "The form broke or the run failed. Retry once. If it keeps happening, finish it yourself.",
    needsYou: false,
    retryable: true,
  },
  unclear_submit: {
    label: "Unclear whether it was sent",
    help: "Submit may or may not have gone through. Check the site or your email before doing anything.",
    needsYou: true,
    retryable: false,
  },
  other: {
    label: "Something else",
    help: "Read the note and decide.",
    needsYou: true,
    retryable: false,
  },
};

/** Older `mark_blocked` categories, mapped to the reasons above. */
const LEGACY: Record<string, HandoffReason> = {
  captcha: "captcha",
  human_only: "other",
  email_only: "external_redirect",
  account_required: "login_required",
  otp: "login_required",
  file_upload_form: "file_upload",
  site_error: "form_error",
  no_ai_policy: "fit_gate",
  missing_data: "unknown_question",
  linkedin_warning: "linkedin_limit",
  unsupported_site: "unsupported_ats",
  other: "other",
};

export function toReason(input: string): HandoffReason {
  if ((HANDOFF_REASONS as readonly string[]).includes(input)) return input as HandoffReason;
  return LEGACY[input] ?? "other";
}

export interface FilledValue {
  field: string;
  value: string;
  source?: string;
}

export interface Handoff {
  id: number;
  application_id: number;
  reason: HandoffReason;
  detail: string;
  needed: string;
  rule: string | null;
  filled: FilledValue[];
  state: "open" | "applied" | "not_interested" | "retried" | "resolved" | "superseded";
  created_at: string;
  resolved_at: string | null;
}

export interface NewHandoff {
  applicationId: number;
  reason: HandoffReason;
  /** Plain words: what happened. */
  detail: string;
  /** Plain words: what you need to do. Defaults to the group help text. */
  needed?: string;
  /** For fit_gate: the rule that hit, e.g. `title contains excluded word "intern"`. */
  rule?: string;
  filled?: FilledValue[];
}

interface Row {
  id: number;
  application_id: number;
  reason: string;
  detail: string;
  needed: string;
  rule: string | null;
  filled: string;
  state: Handoff["state"];
  created_at: string;
  resolved_at: string | null;
}

const toHandoff = (r: Row): Handoff => ({
  ...r,
  reason: toReason(r.reason),
  filled: JSON.parse(r.filled) as FilledValue[],
});

/**
 * Open a record for an application. An open one with the same reason is updated in place; one with a
 * different reason is replaced (and marked superseded, so it is not counted twice).
 */
export function recordHandoff(db: DB, h: NewHandoff): number {
  const t = now();
  const same = db
    .prepare("SELECT id FROM handoffs WHERE application_id = ? AND state = 'open' AND reason = ?")
    .get(h.applicationId, h.reason) as { id: number } | undefined;
  if (same) {
    db.prepare("UPDATE handoffs SET detail = ?, needed = ?, rule = ?, filled = ? WHERE id = ?").run(
      h.detail.slice(0, 500),
      (h.needed ?? REASONS[h.reason].help).slice(0, 500),
      h.rule ?? null,
      JSON.stringify(h.filled ?? []),
      same.id,
    );
    return same.id;
  }
  db.prepare(
    "UPDATE handoffs SET state = 'superseded', resolved_at = ? WHERE application_id = ? AND state = 'open'",
  ).run(t, h.applicationId);
  const res = db
    .prepare(
      `INSERT INTO handoffs(application_id, reason, detail, needed, rule, filled, state, created_at)
       VALUES(?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(
      h.applicationId,
      h.reason,
      h.detail.slice(0, 500),
      (h.needed ?? REASONS[h.reason].help).slice(0, 500),
      h.rule ?? null,
      JSON.stringify(h.filled ?? []),
      t,
    );
  return Number(res.lastInsertRowid);
}

export function openHandoff(db: DB, applicationId: number): Handoff | undefined {
  const r = db
    .prepare("SELECT * FROM handoffs WHERE application_id = ? AND state = 'open' ORDER BY id DESC LIMIT 1")
    .get(applicationId) as Row | undefined;
  return r && toHandoff(r);
}

export function getHandoff(db: DB, id: number): Handoff | undefined {
  const r = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Row | undefined;
  return r && toHandoff(r);
}

export function listHandoffs(db: DB, state: Handoff["state"] | "all" = "open"): Handoff[] {
  const rows = (state === "all"
    ? db.prepare("SELECT * FROM handoffs ORDER BY id DESC").all()
    : db.prepare("SELECT * FROM handoffs WHERE state = ? ORDER BY id DESC").all(state)) as unknown as Row[];
  return rows.map(toHandoff);
}

/** Close the open record(s) of an application. */
export function closeHandoffs(db: DB, applicationId: number, state: Exclude<Handoff["state"], "open">): void {
  db.prepare(
    "UPDATE handoffs SET state = ?, resolved_at = ? WHERE application_id = ? AND state = 'open'",
  ).run(state, now(), applicationId);
}

/** Parse the `filled` list the agent passed or that start_submit stored as evidence. */
export function filledFromEvidence(evidence: string | null): FilledValue[] {
  if (!evidence) return [];
  try {
    const e = JSON.parse(evidence) as { filled?: FilledValue[]; prefilled?: Record<string, string> };
    if (e.filled) return e.filled.filter((f) => f.field && f.value);
    return Object.entries(e.prefilled ?? {}).map(([field, value]) => ({ field, value }));
  } catch {
    return [];
  }
}

/** Hosts of job sites that are not automated yet. */
const UNSUPPORTED_HOST =
  /(^|\.)(myworkdayjobs\.com|workday\.com|icims\.com|taleo\.net|successfactors\.(com|eu)|oraclecloud\.com|jobvite\.com|brassring\.com|ultipro\.com)$/i;

export function unsupportedSite(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return UNSUPPORTED_HOST.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** The tail of an application row that the dashboard shows for a handoff. */
export type HandoffApp = Pick<Application, "id" | "company" | "title" | "url" | "ats" | "status">;
