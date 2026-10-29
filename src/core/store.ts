import { type DB, now } from "./db.js";
import { sameQuestion } from "./text.js";

export const APP_STATUSES = [
  "queued",
  "skipped",
  "in_progress",
  "needs_answers",
  "awaiting_review",
  "submitting",
  "submitted",
  "dry_run",
  "blocked",
  "failed",
  "unclear",
] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

/** Why a form was handed back to the human. Taken from the causes seen in real runs. */
export const BLOCKED_CATEGORIES = [
  "captcha",
  "human_only",
  "email_only",
  "account_required",
  "otp",
  "file_upload_form",
  "site_error",
  "no_ai_policy",
  "missing_data",
  "linkedin_warning",
  "unsupported_site",
  "other",
] as const;
export type BlockedCategory = (typeof BLOCKED_CATEGORIES)[number];

export interface Application {
  id: number;
  company: string;
  title: string;
  url: string;
  ats: string;
  location: string | null;
  source: string;
  description: string | null;
  status: AppStatus;
  reason: string | null;
  blocked_category: string | null;
  evidence: string | null;
  review_approved: number;
  /** The fingerprint of what you approved in review (see core/safety.ts contentHash). */
  approved_hash: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

export interface NewApplication {
  company: string;
  title: string;
  url: string;
  ats?: string;
  location?: string | null;
  source?: string;
  description?: string | null;
}

export function addApplication(db: DB, a: NewApplication): { id: number; created: boolean } {
  const existing = db.prepare("SELECT id FROM applications WHERE url = ?").get(a.url) as
    | { id: number }
    | undefined;
  if (existing) return { id: existing.id, created: false };
  const t = now();
  const res = db
    .prepare(
      `INSERT INTO applications(company, title, url, ats, location, source, description, status, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      a.company,
      a.title,
      a.url,
      a.ats ?? "unknown",
      a.location ?? null,
      a.source ?? "manual",
      a.description ?? null,
      t,
      t,
    );
  const id = Number(res.lastInsertRowid);
  logEvent(db, id, "queued", a.source ? `found via ${a.source}` : undefined);
  return { id, created: true };
}

export function getApplication(db: DB, id: number): Application | undefined {
  return db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as Application | undefined;
}

export function listApplications(db: DB, opts: { status?: AppStatus[]; limit?: number } = {}): Application[] {
  const limit = opts.limit ?? 500;
  if (opts.status?.length) {
    const marks = opts.status.map(() => "?").join(",");
    return db
      .prepare(`SELECT * FROM applications WHERE status IN (${marks}) ORDER BY updated_at DESC LIMIT ?`)
      .all(...opts.status, limit) as unknown as Application[];
  }
  return db
    .prepare("SELECT * FROM applications ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as unknown as Application[];
}

export function setStatus(
  db: DB,
  id: number,
  status: AppStatus,
  extra: { reason?: string; blockedCategory?: string; evidence?: string } = {},
): void {
  const t = now();
  db.prepare(
    `UPDATE applications SET status = ?, reason = COALESCE(?, reason), blocked_category = ?,
       evidence = COALESCE(?, evidence), updated_at = ?,
       submitted_at = CASE WHEN ? = 'submitted' THEN ? ELSE submitted_at END
     WHERE id = ?`,
  ).run(
    status,
    extra.reason ?? null,
    extra.blockedCategory ?? null,
    extra.evidence ?? null,
    t,
    status,
    t,
    id,
  );
  logEvent(db, id, status, extra.reason);
}

/** Your OK in review, bound to the fingerprint of exactly what you saw. */
export function approveReview(db: DB, id: number, hash: string): void {
  db.prepare(
    "UPDATE applications SET review_approved = 1, approved_hash = ?, updated_at = ? WHERE id = ?",
  ).run(hash, now(), id);
  setStatus(db, id, "queued", { reason: "approved in review, will submit next run" });
}

/** The approval no longer matches what would be sent, so it is withdrawn and you are asked again. */
export function withdrawApproval(db: DB, id: number): void {
  db.prepare(
    "UPDATE applications SET review_approved = 0, approved_hash = NULL, updated_at = ? WHERE id = ?",
  ).run(now(), id);
}

/** Point an application at another URL (LinkedIn's "Apply on company website" leads to the company's own form). */
export function moveApplication(db: DB, id: number, to: { url: string; ats: string }): void {
  db.prepare("UPDATE applications SET url = ?, ats = ?, updated_at = ? WHERE id = ?").run(
    to.url,
    to.ats,
    now(),
    id,
  );
}

/** Fill in company, title and location once the agent has read them on the job page. */
export function updateJobFacts(
  db: DB,
  id: number,
  facts: { company: string; title: string; location?: string | null; description?: string | null },
): void {
  db.prepare(
    `UPDATE applications SET company = ?, title = ?, location = COALESCE(?, location),
       description = COALESCE(?, description), updated_at = ? WHERE id = ?`,
  ).run(facts.company, facts.title, facts.location ?? null, facts.description ?? null, now(), id);
}

function logEvent(db: DB, applicationId: number, status: string, note?: string): void {
  db.prepare("INSERT INTO application_events(application_id, status, note, at) VALUES(?, ?, ?, ?)").run(
    applicationId,
    status,
    note ?? null,
    now(),
  );
}

export function applicationEvents(db: DB, id: number): { status: string; note: string | null; at: string }[] {
  return db
    .prepare("SELECT status, note, at FROM application_events WHERE application_id = ? ORDER BY id")
    .all(id) as unknown as { status: string; note: string | null; at: string }[];
}

/** Submitted (or in-flight) applications since a moment, for daily and per-company caps. */
export function countSubmittedSince(db: DB, sinceIso: string, company?: string): number {
  const sql =
    "SELECT COUNT(*) AS n FROM applications WHERE status IN ('submitted','submitting','unclear') AND updated_at >= ?" +
    (company ? " AND lower(company) = lower(?)" : "");
  const row = (company ? db.prepare(sql).get(sinceIso, company) : db.prepare(sql).get(sinceIso)) as {
    n: number;
  };
  return row.n;
}

export function countEverSubmitted(db: DB): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'submitted'").get() as { n: number }
  ).n;
}

// ---------- questions ----------

export interface Question {
  id: number;
  application_id: number | null;
  question: string;
  context: string | null;
  options: string | null;
  field_type: string;
  status: "open" | "answered" | "dismissed";
  answer: string | null;
  memory_id: number | null;
  /** "ask": no answer yet. "confirm": a sensitive question with a stored answer you confirm per application. */
  kind: "ask" | "confirm";
  created_at: string;
  answered_at: string | null;
}

export interface NewQuestion {
  applicationId?: number | null;
  question: string;
  context?: string;
  options?: string[];
  fieldType?: string;
  /** "confirm": a sensitive question for one application; never merged with other applications' cards. */
  kind?: "ask" | "confirm";
}

/**
 * Queue a question for the human. If the same question is already open it is reused, so the dashboard
 * shows one card even when several applications are waiting on it.
 */
export function askQuestion(db: DB, q: NewQuestion): { id: number; duplicate: boolean } {
  const kind = q.kind ?? "ask";
  const open = db.prepare("SELECT id, question, kind FROM questions WHERE status = 'open'").all() as {
    id: number;
    question: string;
    kind: string;
  }[];
  const dup = open.find(
    (o) =>
      o.kind === kind &&
      sameQuestion(o.question, q.question) &&
      // A confirmation belongs to one application: the same question for another job is its own card.
      (kind === "ask" || (!!q.applicationId && questionApplications(db, o.id).includes(q.applicationId))),
  );
  if (dup) {
    if (q.applicationId) linkQuestion(db, dup.id, q.applicationId);
    return { id: dup.id, duplicate: true };
  }
  const res = db
    .prepare(
      `INSERT INTO questions(application_id, question, context, options, field_type, status, created_at, kind)
       VALUES(?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .run(
      q.applicationId ?? null,
      q.question.trim(),
      q.context ?? null,
      q.options?.length ? JSON.stringify(q.options) : null,
      q.fieldType ?? "text",
      now(),
      kind,
    );
  const id = Number(res.lastInsertRowid);
  if (q.applicationId) linkQuestion(db, id, q.applicationId);
  return { id, duplicate: false };
}

/** One question card can hold several applications that wait on the same answer. */
function linkQuestion(db: DB, questionId: number, applicationId: number): void {
  db.prepare("INSERT OR IGNORE INTO question_apps(question_id, application_id) VALUES(?, ?)").run(
    questionId,
    applicationId,
  );
}

export function questionApplications(db: DB, questionId: number): number[] {
  const rows = db
    .prepare("SELECT application_id FROM question_apps WHERE question_id = ?")
    .all(questionId) as {
    application_id: number;
  }[];
  return rows.map((r) => r.application_id);
}

export function listQuestions(db: DB, status: Question["status"] | "all" = "open"): Question[] {
  if (status === "all")
    return db.prepare("SELECT * FROM questions ORDER BY id DESC").all() as unknown as Question[];
  return db
    .prepare("SELECT * FROM questions WHERE status = ? ORDER BY id DESC")
    .all(status) as unknown as Question[];
}

export function getQuestion(db: DB, id: number): Question | undefined {
  return db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Question | undefined;
}

export function openQuestionsFor(db: DB, applicationId: number): Question[] {
  return db
    .prepare(
      `SELECT q.* FROM questions q JOIN question_apps qa ON qa.question_id = q.id
       WHERE qa.application_id = ? AND q.status = 'open' ORDER BY q.id`,
    )
    .all(applicationId) as unknown as Question[];
}

// ---------- runs ----------

export interface Run {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  provider: string;
  dry_run: number;
  trigger: string;
  summary: string | null;
  log_path: string | null;
}

export function startRun(db: DB, provider: string, dryRun: boolean, trigger: string): number {
  const res = db
    .prepare("INSERT INTO runs(started_at, status, provider, dry_run, trigger) VALUES(?, 'running', ?, ?, ?)")
    .run(now(), provider, dryRun ? 1 : 0, trigger);
  return Number(res.lastInsertRowid);
}

export function finishRun(db: DB, id: number, status: string, summary: string, logPath?: string): void {
  db.prepare("UPDATE runs SET finished_at = ?, status = ?, summary = ?, log_path = ? WHERE id = ?").run(
    now(),
    status,
    summary,
    logPath ?? null,
    id,
  );
}

export function listRuns(db: DB, limit = 50): Run[] {
  return db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit) as unknown as Run[];
}

// ---------- confirmations ----------

/** Sensitive questions you confirmed for one application (see config safety.alwaysAsk). */
export function confirmAnswer(
  db: DB,
  c: { applicationId: number; question: string; answer: string; memoryId: number },
): void {
  db.prepare(
    `INSERT INTO confirmations(application_id, question, answer, memory_id, at) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(application_id, question) DO UPDATE SET answer = excluded.answer,
       memory_id = excluded.memory_id, at = excluded.at`,
  ).run(c.applicationId, c.question.trim(), c.answer, c.memoryId, now());
}

export interface Confirmation {
  question: string;
  answer: string;
  memory_id: number | null;
}

/** Your confirmation of a sensitive question for one application: by its wording or by the answer cited. */
export function confirmationFor(
  db: DB,
  applicationId: number,
  question: string,
  memoryId?: number,
): Confirmation | undefined {
  const rows = db
    .prepare("SELECT question, answer, memory_id FROM confirmations WHERE application_id = ?")
    .all(applicationId) as unknown as Confirmation[];
  return rows.find(
    (r) => sameQuestion(r.question, question) || (memoryId !== undefined && r.memory_id === memoryId),
  );
}
