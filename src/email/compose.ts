import type { DB } from "../core/db.js";
import type { Application } from "../core/store.js";
import { listAnswers } from "../memory/answers.js";
import type { Profile } from "../memory/profile.js";

export interface ApplicationEmail {
  to: string;
  subject: string;
  body: string;
  /** File name of the resume in the data folder's resume/ directory, attached as it is. */
  attachment: string | null;
}

/** A plain email address (a mailto: link is fine), lowercased, or undefined when the text is not one. */
export function cleanAddress(text: string | undefined | null): string | undefined {
  const t = (text ?? "")
    .trim()
    .replace(/^mailto:/i, "")
    .split("?")[0]!;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(t) ? t.toLowerCase() : undefined;
}

/**
 * The address a posting asks applications to be sent to ("send your resume to jobs@acme.com",
 * "apply by email: jobs@acme.com"). Only an address in such a sentence counts: a contact address for
 * questions or accommodations does not make a posting email-only.
 */
export function applyEmailIn(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, " ");
  const patterns = [
    /\b(?:send|email|e-mail|mail|forward|submit)\b[^.]{0,60}?\b(?:resume|r[eé]sum[eé]|cv|application|portfolio|cover letter)\b[^.]{0,40}?\bto\b:?\s*(?:us at\s*)?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i,
    /\bapply (?:by|via) e-?mail\b[^.]{0,40}?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i,
    /\bto apply,? (?:please )?(?:e-?mail|write to)\b:?\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) return m[1].replace(/\.$/, "").toLowerCase();
  }
  return undefined;
}

function stored(db: DB, key: string, company: string): string | undefined {
  const all = listAnswers(db).filter((a) => a.key === key);
  const mine = all.find(
    (a) => a.scope === "company" && a.scope_value?.toLowerCase() === company.toLowerCase(),
  );
  return (mine ?? all.find((a) => a.scope === "global"))?.answer.trim() || undefined;
}

/**
 * The email for one application, built only from your profile and your stored answers: no AI writes
 * it, so it cannot contain anything you did not give QuietApply. Short and plain, resume attached.
 */
export function composeApplicationEmail(
  db: DB,
  profile: Profile,
  app: Pick<Application, "title" | "company">,
  to: string,
): ApplicationEmail {
  const role = app.title.trim() || "open";
  const lines: string[] = [
    "Dear hiring team,",
    "",
    `I would like to apply for the ${role} role at ${app.company}.`,
  ];

  const about: string[] = [];
  if (profile.headline && profile.totalYears !== undefined)
    about.push(`I am a ${profile.headline} with ${profile.totalYears} years of experience.`);
  else if (profile.headline) about.push(`I am a ${profile.headline}.`);
  const latest = profile.experience[0];
  if (latest?.title && latest.company)
    about.push(
      `${/present|now|current/i.test(latest.end ?? "") ? "I currently work" : "Most recently I worked"} as ${latest.title} at ${latest.company}.`,
    );
  if (about.length) lines.push(about.join(" "));

  const letter = stored(db, "cover_letter", app.company);
  if (letter) lines.push("", letter.slice(0, 1500));

  const notice = stored(db, "notice_period", app.company);
  lines.push(
    "",
    `My resume is attached.${notice ? ` My notice period is ${notice.replace(/\.$/, "")}.` : ""}`,
  );

  const links = [profile.links.linkedin, profile.links.github, profile.links.portfolio].filter(
    (l): l is string => !!l,
  );
  if (links.length) lines.push("", ...links);

  lines.push("", "Kind regards,", profile.name, ...[profile.phone, profile.email].filter(Boolean));
  return {
    to,
    subject: `Application: ${role}, ${profile.name}`,
    body: lines.join("\n"),
    attachment: profile.resumeFile ?? null,
  };
}
