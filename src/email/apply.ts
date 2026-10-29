import { existsSync } from "node:fs";
import type { Config } from "../core/config.js";
import { type DB, now } from "../core/db.js";
import { closeHandoffs, type FilledValue, recordHandoff } from "../core/handoffs.js";
import { allowance, daysAgo, startOfToday } from "../core/limits.js";
import type { Paths } from "../core/paths.js";
import { contentHash } from "../core/safety.js";
import {
  type Application,
  type AppStatus,
  getApplication,
  setStatus,
  withdrawApproval,
} from "../core/store.js";
import type { Profile } from "../memory/profile.js";
import { type ApplicationEmail, cleanAddress, composeApplicationEmail } from "./compose.js";
import { readPassword } from "./secret.js";
import { attachmentPath, type Sender, smtpSender } from "./send.js";

export interface EmailRecord {
  id: number;
  application_id: number;
  to_addr: string;
  subject: string;
  body: string;
  attachment: string | null;
  hash: string;
  status: "dry_run" | "awaiting_review" | "sending" | "sent" | "failed";
  message_id: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

export function emailsFor(db: DB, applicationId: number): EmailRecord[] {
  return db
    .prepare("SELECT * FROM emails WHERE application_id = ? ORDER BY id")
    .all(applicationId) as unknown as EmailRecord[];
}

/** Emails actually handed to the mail server (sent, or in flight) since a moment. */
export function emailsSentSince(db: DB, sinceIso: string, to?: string): number {
  const sql =
    "SELECT COUNT(*) AS n FROM emails WHERE status IN ('sent','sending') AND created_at >= ?" +
    (to ? " AND lower(to_addr) = lower(?)" : "");
  const row = (to ? db.prepare(sql).get(sinceIso, to) : db.prepare(sql).get(sinceIso)) as { n: number };
  return row.n;
}

export function emailsEverSent(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM emails WHERE status = 'sent'").get() as { n: number }).n;
}

/**
 * Whether a person or address is on your do-not-contact list. An entry can be a full address, a domain
 * ("acme.com" or "@acme.com"), a LinkedIn profile link or a name.
 */
export function onDoNotContact(config: Config, ...values: (string | undefined | null)[]): boolean {
  const list = config.doNotContact.map((x) => x.trim().toLowerCase().replace(/\/+$/, "")).filter(Boolean);
  return values.some((v) => {
    const t = (v ?? "").trim().toLowerCase().replace(/\/+$/, "");
    if (!t) return false;
    const domain = t.includes("@") ? t.split("@")[1] : undefined;
    return list.some((x) => x === t || (!!domain && (x === domain || x === `@${domain}`)));
  });
}

/** Where an application should be emailed, if it is an email application. */
export function emailTarget(app: Pick<Application, "apply_email" | "url">): string | undefined {
  return app.apply_email ?? (/^mailto:/i.test(app.url) ? cleanAddress(app.url) : undefined);
}

/** The email as copy-ready values for Finish yourself. */
export function emailAsValues(e: ApplicationEmail): FilledValue[] {
  return [
    { field: "To", value: e.to },
    { field: "Subject", value: e.subject },
    { field: "Body", value: e.body },
    ...(e.attachment ? [{ field: "Attach", value: `your resume (${e.attachment})` }] : []),
  ];
}

function saveDraft(db: DB, appId: number, e: ApplicationEmail, status: EmailRecord["status"]): number {
  // One unsent draft per application: a newer one replaces it, sent ones are kept for the record.
  db.prepare("DELETE FROM emails WHERE application_id = ? AND status IN ('dry_run','awaiting_review')").run(
    appId,
  );
  const res = db
    .prepare(
      `INSERT INTO emails(application_id, to_addr, subject, body, attachment, hash, status, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(appId, e.to, e.subject, e.body, e.attachment, contentHash(e), status, now());
  return Number(res.lastInsertRowid);
}

export interface EmailOutcome {
  status: AppStatus;
  note: string;
}

/**
 * Apply to one job by email. Nothing is sent unless email is turned on (with your yes), dry run is off,
 * the review OK covers this exact email, and the caps and the do-not-contact list allow it. Every email
 * that reaches the mail server is recorded with To, Subject, Body and Message-ID.
 */
export async function applyByEmail(o: {
  db: DB;
  p: Paths;
  config: Config;
  profile: Profile;
  app: Application;
  /** Tests pass a sender bound to an in-process fake SMTP server. */
  sender?: Sender;
}): Promise<EmailOutcome> {
  const { db, config, app } = o;
  const to = emailTarget(app);
  if (!to) throw new Error("not an email application");
  const email = composeApplicationEmail(db, o.profile, app, to);
  const evidence = JSON.stringify({ email, at: now() });
  const handBack = (
    status: AppStatus,
    reason: "email_only" | "fit_gate" | "cap" | "file_upload" | "form_error",
    detail: string,
    needed?: string,
    rule?: string,
  ): EmailOutcome => {
    setStatus(db, app.id, status, {
      reason: detail,
      blockedCategory: status === "blocked" ? reason : undefined,
      evidence,
    });
    recordHandoff(db, { applicationId: app.id, reason, detail, needed, rule, filled: emailAsValues(email) });
    return { status, note: detail };
  };

  if (!config.email.enabled)
    return handBack(
      "blocked",
      "email_only",
      `The posting asks for an email to ${to}. Email applications are off, so the text is ready to copy.`,
      "Send it from your own mail with your resume attached, or turn on email applications in Settings.",
    );
  if (onDoNotContact(config, to))
    return handBack(
      "skipped",
      "fit_gate",
      `${to} is on your do-not-contact list.`,
      undefined,
      "do-not-contact list",
    );
  if (emailsSentSince(db, daysAgo(30), to) > 0)
    return handBack(
      "skipped",
      "cap",
      `An application was already emailed to ${to} in the last 30 days.`,
      undefined,
      "at most one email to the same address in 30 days",
    );

  if (config.dryRun) {
    saveDraft(db, app.id, email, "dry_run");
    setStatus(db, app.id, "dry_run", { reason: `dry run: email to ${to} written, not sent`, evidence });
    return { status: "dry_run", note: "email written, not sent (dry run)" };
  }

  // Review: the first emails wait for your OK, and the OK covers exactly this text.
  if (emailsEverSent(db) < config.limits.reviewFirst) {
    const fresh = getApplication(db, app.id)!;
    if (!(fresh.review_approved && fresh.approved_hash === contentHash(email))) {
      const changed = !!fresh.review_approved;
      if (changed) withdrawApproval(db, app.id);
      saveDraft(db, app.id, email, "awaiting_review");
      setStatus(db, app.id, "awaiting_review", {
        reason: changed
          ? "the email changed since you approved it, so it waits for your OK again"
          : `email to ${to} written, waiting for your OK in the dashboard`,
        evidence,
      });
      return { status: "awaiting_review", note: "email waits for your OK" };
    }
  }

  if (
    emailsSentSince(db, startOfToday()) >= config.email.perDay ||
    allowance(db, config).remainingToday <= 0
  ) {
    setStatus(db, app.id, "queued", { reason: "today's email limit is reached, it goes out on a later day" });
    return { status: "queued", note: "email limit for today" };
  }

  const file = attachmentPath(o.p, email);
  if (!file || !existsSync(file))
    return handBack(
      "blocked",
      "file_upload",
      "There is no resume file to attach.",
      "Run quietapply init --resume <file>.",
    );

  let sender = o.sender;
  if (!sender) {
    const password = config.email.smtp.user ? readPassword(o.p, config.email.smtp.user) : undefined;
    if (!password || !config.email.smtp.host || !config.email.from)
      return handBack(
        "blocked",
        "email_only",
        "Email is on, but the mail server, your address or the app password is missing.",
        "Finish the Email card in Settings, or send this one yourself.",
      );
    sender = smtpSender(config, password);
  }

  // Marked before sending, so an unclear result is never sent twice.
  setStatus(db, app.id, "submitting", { reason: `sending the email to ${to}`, evidence });
  db.prepare("DELETE FROM emails WHERE application_id = ? AND status IN ('dry_run','awaiting_review')").run(
    app.id,
  );
  const rowId = Number(
    db
      .prepare(
        `INSERT INTO emails(application_id, to_addr, subject, body, attachment, hash, status, created_at)
         VALUES(?, ?, ?, ?, ?, ?, 'sending', ?)`,
      )
      .run(app.id, email.to, email.subject, email.body, email.attachment, contentHash(email), now())
      .lastInsertRowid,
  );
  try {
    const { messageId } = await sender(email, { from: config.email.from ?? "", attachmentPath: file });
    db.prepare("UPDATE emails SET status = 'sent', message_id = ?, sent_at = ? WHERE id = ?").run(
      messageId,
      now(),
      rowId,
    );
    setStatus(db, app.id, "submitted", {
      reason: `emailed to ${to}`,
      evidence: JSON.stringify({ email, messageId, at: now() }),
    });
    closeHandoffs(db, app.id, "applied");
    return { status: "submitted", note: `emailed to ${to}` };
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    db.prepare("UPDATE emails SET status = 'failed', error = ? WHERE id = ?").run(message, rowId);
    return handBack("failed", "form_error", `The mail server did not take the email: ${message}`);
  }
}
