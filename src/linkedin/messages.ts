import type { Config } from "../core/config.js";
import { type DB, now } from "../core/db.js";
import { startOfToday } from "../core/limits.js";
import { contentHash } from "../core/safety.js";
import type { Application } from "../core/store.js";
import { onDoNotContact } from "../email/apply.js";
import { firstName, type Profile } from "../memory/profile.js";
import { linkedInEnabled, linkedInStop } from "./mode.js";

/** Asked after LinkedIn mode is on, as its own yes. */
export const MESSAGE_QUESTION = "May QuietApply message recruiters on your behalf?";

/** The extra risk, in plain words. */
export const MESSAGE_RISK = [
  "This adds risk to your LinkedIn account on top of LinkedIn mode. Messages from automation are what LinkedIn looks for most, and people can report a message they did not want.",
  "After an application is sent, QuietApply may write one short message (40 to 90 words, from your profile only) to the recruiter or hiring manager shown on the job page. At most one message per person, ever, and 3 a day by default. No follow-ups.",
  "Your first 10 messages wait for your OK in the dashboard, where you see the exact text. It stops at once on any LinkedIn warning, limit or check. Turn it off any time in Settings.",
];

export const MESSAGE_MAX_PER_DAY = 10;
export const MESSAGE_MIN_WORDS = 40;
export const MESSAGE_MAX_WORDS = 90;

export interface MessageRecord {
  id: number;
  application_id: number;
  recipient_name: string;
  profile_url: string;
  text: string;
  hash: string;
  status: "dry_run" | "awaiting_review" | "approved" | "sending" | "sent" | "failed" | "refused";
  approved_hash: string | null;
  note: string | null;
  created_at: string;
  sent_at: string | null;
}

export function messagesEnabled(config: Config): boolean {
  return linkedInEnabled(config) && config.linkedin.messages.enabled && !!config.linkedin.messages.acceptedAt;
}

export function turnOnMessages(
  config: Config,
  opts: { accept: boolean; at?: Date },
): { ok: true; config: Config } | { ok: false; error: string } {
  if (!linkedInEnabled(config)) return { ok: false, error: "Turn on LinkedIn mode first." };
  if (!opts.accept) return { ok: false, error: "Read the risk and say yes to turn messages on." };
  const messages = {
    ...config.linkedin.messages,
    enabled: true,
    acceptedAt: (opts.at ?? new Date()).toISOString(),
    declinedAt: undefined,
  };
  return { ok: true, config: { ...config, linkedin: { ...config.linkedin, messages } } };
}

export function declineMessages(config: Config, at = new Date()): Config {
  const messages = {
    ...config.linkedin.messages,
    enabled: false,
    acceptedAt: undefined,
    declinedAt: at.toISOString(),
  };
  return { ...config, linkedin: { ...config.linkedin, messages } };
}

export function turnOffMessages(config: Config): Config {
  const messages = { ...config.linkedin.messages, enabled: false, acceptedAt: undefined };
  return { ...config, linkedin: { ...config.linkedin, messages } };
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * The message, from your profile only: one paragraph of 40 to 90 words. No AI writes it, so it holds
 * nothing you did not give QuietApply, and the same inputs always give the same text.
 */
export function composeRecruiterMessage(
  profile: Profile,
  app: Pick<Application, "title" | "company">,
  recipientName: string,
): string {
  const hi = recipientName.trim().split(/\s+/)[0] || "there";
  const parts = [
    `Hi ${hi}, I just applied for the ${app.title} role at ${app.company} and wanted to say hello.`,
  ];
  const latest = profile.experience[0];
  if (profile.headline && profile.totalYears !== undefined)
    parts.push(`I am a ${profile.headline} with ${profile.totalYears} years of experience.`);
  else if (profile.headline) parts.push(`I am a ${profile.headline}.`);
  if (latest?.title && latest.company)
    parts.push(
      `${/present|now|current/i.test(latest.end ?? "") ? "I currently work" : "Most recently I worked"} as ${latest.title} at ${latest.company}.`,
    );
  const close = `If it helps, I am happy to share more about my background. Thank you for your time, ${firstName(profile) || profile.name}.`;
  const fillers = [
    profile.summary.split(/(?<=[.!?])\s+/)[0]?.trim(),
    "My application and resume are with your team, so this note is only a short hello.",
    `I would welcome the chance to talk about how I could help the team at ${app.company}.`,
  ].filter((x): x is string => !!x && words(x) <= 35);
  let text = [...parts, close].join(" ");
  for (const f of fillers) {
    if (words(text) >= MESSAGE_MIN_WORDS) break;
    const next = [...parts, f, close].join(" ");
    if (words(next) <= MESSAGE_MAX_WORDS) {
      parts.push(f);
      text = next;
    }
  }
  // Keep within the limit even with very long titles or names: drop middle sentences first.
  while (words(text) > MESSAGE_MAX_WORDS && parts.length > 1) {
    parts.splice(parts.length - 1, 1);
    text = [...parts, close].join(" ");
  }
  return text.replace(/\s+/g, " ").trim();
}

/** A LinkedIn profile link in one shape, so "one message per person" holds however it was written. */
export function normalizeProfileUrl(url: string): string | undefined {
  try {
    const u = new URL(url.trim());
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return undefined;
    const m = u.pathname.match(/^\/in\/([^/]+)/i);
    return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1]!).toLowerCase()}` : undefined;
  } catch {
    return undefined;
  }
}

export function messagesFor(db: DB, applicationId: number): MessageRecord[] {
  return db
    .prepare("SELECT * FROM messages WHERE application_id = ? ORDER BY id")
    .all(applicationId) as unknown as MessageRecord[];
}

export function getMessage(db: DB, id: number): MessageRecord | undefined {
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRecord | undefined;
}

/** Messages that went out (or are going out) to this person, ever. */
export function messagedBefore(db: DB, profileUrl: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM messages WHERE profile_url = ? AND status IN ('sending','sent') LIMIT 1")
    .get(profileUrl);
}

export function messagesSentSince(db: DB, sinceIso: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE status IN ('sending','sent') AND created_at >= ?")
      .get(sinceIso) as { n: number }
  ).n;
}

export function messagesEverSent(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent'").get() as { n: number }).n;
}

export function approvedMessages(db: DB): MessageRecord[] {
  return db
    .prepare("SELECT * FROM messages WHERE status = 'approved' ORDER BY id")
    .all() as unknown as MessageRecord[];
}

function setMessage(
  db: DB,
  id: number,
  status: MessageRecord["status"],
  extra: { note?: string; approvedHash?: string | null } = {},
) {
  db.prepare(
    `UPDATE messages SET status = ?, note = COALESCE(?, note),
       approved_hash = CASE WHEN ? THEN ? ELSE approved_hash END,
       sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END WHERE id = ?`,
  ).run(
    status,
    extra.note ?? null,
    extra.approvedHash !== undefined ? 1 : 0,
    extra.approvedHash ?? null,
    status,
    now(),
    id,
  );
}

/** Why no message may go to this person now, or undefined when one may. */
export function messageBlocker(
  db: DB,
  config: Config,
  recipientName: string,
  profileUrl: string,
): string | undefined {
  if (!messagesEnabled(config)) return "recruiter messages are off";
  const stop = linkedInStop(db);
  if (stop) return `LinkedIn mode is stopped: ${stop.reason}`;
  if (onDoNotContact(config, profileUrl, recipientName)) return "this person is on your do-not-contact list";
  if (messagedBefore(db, profileUrl))
    return "this person was already messaged once (one message per person, ever)";
  if (messagesSentSince(db, startOfToday()) >= config.linkedin.messages.perDay)
    return `today's limit of ${config.linkedin.messages.perDay} messages is reached`;
  return undefined;
}

/**
 * The agent saw who is hiring for a job it applied to. A draft is written from your profile and its fate
 * is decided here, never by the agent: dry run keeps it as a draft, review waits for your OK, and the
 * rest are approved for a separate, human-paced message run.
 */
export function draftMessage(
  db: DB,
  config: Config,
  profile: Profile,
  app: Application,
  input: { name: string; profileUrl: string },
): { status: MessageRecord["status"] | "none"; id?: number; reason: string } {
  if (!messagesEnabled(config)) return { status: "none", reason: "recruiter messages are off" };
  const url = normalizeProfileUrl(input.profileUrl);
  if (!url) return { status: "none", reason: "not a LinkedIn profile link" };
  const name = input.name.trim().slice(0, 120);
  const text = composeRecruiterMessage(profile, app, name);
  const insert = (status: MessageRecord["status"], note: string) => {
    const res = db
      .prepare(
        `INSERT INTO messages(application_id, recipient_name, profile_url, text, hash, status, note, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(app.id, name, url, text, contentHash(text), status, note, now());
    return { status, id: Number(res.lastInsertRowid), reason: note };
  };
  if (config.dryRun) return insert("dry_run", "dry run: written, never sent");
  if (app.status !== "submitted")
    return { status: "none", reason: "only after the application is submitted" };
  const blocked = messageBlocker(db, config, name, url);
  if (blocked) return insert("refused", blocked);
  if (messagesEverSent(db) < config.limits.reviewFirst)
    return insert("awaiting_review", "waits for your OK in the dashboard");
  const r = insert("approved", "approved by the rules, sent in a separate human-paced run");
  setMessage(db, r.id, "approved", { approvedHash: contentHash(text) });
  return r;
}

/** Your OK in the dashboard, bound to the exact text you saw. */
export function approveMessage(db: DB, id: number, hash: string): MessageRecord {
  const m = getMessage(db, id);
  if (!m) throw new Error("No such message");
  if (m.status !== "awaiting_review") throw new Error("Only messages waiting for your OK can be approved");
  if (hash !== m.hash) throw new Error("The message changed since you opened it. Look at it again");
  setMessage(db, id, "approved", { approvedHash: hash, note: "approved by you" });
  return getMessage(db, id)!;
}

export function dismissMessage(db: DB, id: number): void {
  setMessage(db, id, "refused", { note: "dismissed by you" });
}

/**
 * The message run asks to send one approved message. Every rule is checked again here: the text must be
 * exactly what was approved, and the person, the caps and the LinkedIn stop must still allow it.
 */
export function startMessage(
  db: DB,
  config: Config,
  id: number,
): { send: true; text: string } | { send: false; reason: string } {
  const m = getMessage(db, id);
  if (!m) return { send: false, reason: "no such message" };
  if (config.dryRun) return { send: false, reason: "dry run: nothing is sent" };
  if (m.status !== "approved") return { send: false, reason: `the message is ${m.status}, not approved` };
  if (m.approved_hash !== contentHash(m.text)) {
    setMessage(db, id, "awaiting_review", {
      approvedHash: null,
      note: "changed after the OK, so it waits again",
    });
    return { send: false, reason: "the text is not what was approved" };
  }
  const blocked = messageBlocker(db, config, m.recipient_name, m.profile_url);
  if (blocked) {
    setMessage(db, id, "refused", { note: blocked });
    return { send: false, reason: blocked };
  }
  setMessage(db, id, "sending", { note: "being typed by the agent" });
  return { send: true, text: m.text };
}

export function finishMessage(db: DB, id: number, outcome: "sent" | "failed", note: string): void {
  const m = getMessage(db, id);
  if (!m) throw new Error("No such message");
  if (outcome === "sent" && m.status !== "sending")
    throw new Error("record_message(sent) without prepare_message approving it first");
  setMessage(db, id, outcome, { note: note.slice(0, 300) });
}
