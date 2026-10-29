import { createHash } from "node:crypto";
import { norm } from "./text.js";

/**
 * Small safety checks the desk runs in code, whatever the agent was told:
 * - a fingerprint of exactly what you approved in review, so a changed form or email needs a new OK
 * - a scan of job-page text for instructions aimed at the AI (prompt injection)
 * - an allowlist of hosts where Submit may be clicked
 * - questions that always come back to you, even when an answer is stored
 */

// ---------- approval bound to content ----------

/**
 * A stable fingerprint of what is about to be sent: the filled form values (field and value, in any
 * order) or an email (to, subject, body, attachment). Approving in review stores this; a later submit
 * with a different fingerprint needs your OK again.
 */
export function contentHash(content: unknown): string {
  return createHash("sha256").update(canonical(content)).digest("hex").slice(0, 32);
}

function canonical(content: unknown): string {
  if (Array.isArray(content)) {
    // Filled fields: only what reaches the site counts (field and value), sorted so order does not matter.
    const rows = content.map((f) => {
      const r = f as { field?: string; value?: string };
      return [String(r.field ?? "").trim(), String(r.value ?? "")];
    });
    rows.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : 1));
    return JSON.stringify(rows);
  }
  if (content && typeof content === "object") {
    const o = content as Record<string, unknown>;
    return JSON.stringify(
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]]),
    );
  }
  return JSON.stringify(content ?? null);
}

/** The fingerprint of what an application's evidence says will be sent, or undefined when there is nothing. */
export function evidenceHash(evidence: string | null | undefined): string | undefined {
  if (!evidence) return undefined;
  try {
    const e = JSON.parse(evidence) as { filled?: unknown[]; email?: unknown };
    if (e.email) return contentHash(e.email);
    if (Array.isArray(e.filled)) return contentHash(e.filled);
  } catch {
    // not JSON: nothing approvable
  }
  return undefined;
}

// ---------- prompt injection on job pages ----------

/** Phrases that speak to an AI rather than to a candidate. Job ads have no reason to contain them. */
const INJECTION: { name: string; re: RegExp }[] = [
  {
    name: "tells the AI to ignore its instructions",
    re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|directions?)\b/i,
  },
  {
    name: "addresses an AI or language model",
    re: /\bif you are (an? )?(ai|a\.i\.|bot|llm|large language model|language model|chatgpt|claude|gpt|automated (agent|tool|system))\b/i,
  },
  { name: "mentions a system prompt", re: /\b(system|developer) (prompt|message|instructions)\b/i },
  { name: "tries to give the AI a new role", re: /\byou are now\b|\bact as (an? )?(ai|assistant|admin)/i },
  {
    name: "chat-format control tokens",
    re: /<\|(im_start|im_end|system|endoftext)\|>|\[\/?INST\]|<\/?(system|assistant)>/i,
  },
  {
    name: "asks the AI to call tools or reveal data",
    re: /\b(call|use|invoke) the [\w-]+ tool\b|\b(reveal|print|send|output) (your|the) (prompt|instructions|api key|password|memory)\b/i,
  },
  {
    name: "asks the AI to hide something from the person",
    re: /\b(do not|don't) (tell|inform|show|mention (this )?to) the (user|human|candidate|applicant)\b/i,
  },
];

/** What on a job page looks like it is talking to the AI. Empty when nothing does. */
export function injectionSignals(text: string | null | undefined): string[] {
  if (!text) return [];
  const t = text.replace(/\s+/g, " ");
  return INJECTION.filter((p) => p.re.test(t)).map((p) => p.name);
}

// ---------- where Submit may be clicked ----------

/** The job sites QuietApply applies on. LinkedIn only counts in LinkedIn mode (checked by the caller). */
const ATS_HOSTS = [
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "job-boards.eu.greenhouse.io",
  "boards.eu.greenhouse.io",
  "jobs.lever.co",
  "jobs.eu.lever.co",
  "jobs.ashbyhq.com",
];
const LINKEDIN_HOSTS = ["www.linkedin.com", "linkedin.com"];

/**
 * Whether Submit may be clicked on this page: a Greenhouse, Lever or Ashby host, or the host of the job
 * link itself (a company's own careers site that embeds its ATS form), or LinkedIn in LinkedIn mode.
 * Anything else is a redirect to a site QuietApply does not know, and goes to Finish yourself.
 */
export function submitHostAllowed(
  pageUrl: string,
  jobUrl: string,
  opts: { linkedin?: boolean } = {},
): { ok: true; host: string } | { ok: false; host: string } {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return { ok: false, host: pageUrl.slice(0, 200) };
  }
  const host = page.hostname.toLowerCase();
  // The job link's own site is trusted as it is (same scheme and host); a known job site only over HTTPS.
  const job = (() => {
    try {
      return new URL(jobUrl);
    } catch {
      return undefined;
    }
  })();
  if (job && job.protocol === page.protocol && job.hostname.toLowerCase() === host) return { ok: true, host };
  const https = page.protocol === "https:";
  const ok = https && (ATS_HOSTS.includes(host) || (!!opts.linkedin && LINKEDIN_HOSTS.includes(host)));
  return { ok, host };
}

// ---------- questions that always come back to you ----------

export const SENSITIVE_CATEGORIES = [
  "work_authorization",
  "demographics",
  "criminal_history",
  "legal_attestation",
  "nda_consent",
] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

export const SENSITIVE_LABEL: Record<SensitiveCategory, string> = {
  work_authorization: "Work authorization or visa sponsorship",
  demographics: "Demographics and EEO (gender, race, veteran, disability, orientation)",
  criminal_history: "Criminal history or background checks",
  legal_attestation: "Legal statements you sign (I certify, I attest)",
  nda_consent: "NDAs, non-competes, agreements and consent boxes",
};

const SENSITIVE: Record<SensitiveCategory, RegExp[]> = {
  work_authorization: [
    /(legally )?(authori[sz]ed|eligible|permitted) to work/,
    /work (authori[sz]ation|permit|eligibility)/,
    /right to work/,
    /sponsor/,
    /\bvisa\b/,
    /immigration/,
  ],
  demographics: [
    /\bgender\b/,
    /^sex$/,
    /\brace\b/,
    /ethnic/,
    /hispanic|latin[oa]/,
    /veteran/,
    /disabilit/,
    /sexual orientation/,
    /transgender/,
    /\bpronouns?\b/,
  ],
  criminal_history: [/criminal/, /convict/, /felon/, /misdemeanou?r/, /background (check|screen)/, /arrest/],
  legal_attestation: [
    /\b(i )?(certify|attest|affirm|declare)\b/,
    /under penalty/,
    /true (correct )?and (complete|accurate)/,
    /accurate to the best of/,
  ],
  nda_consent: [
    /non ?disclosure|\bnda\b/,
    /non ?compete|non ?solicit/,
    /(employment|restrictive|confidentiality) (agreement|covenant)/,
    /\bconsent\b/,
    /^i (agree|acknowledge|accept)/,
    /privacy (policy|notice)/,
  ],
};

/** Which sensitive category a form question falls in, if any. */
export function sensitiveCategory(question: string): SensitiveCategory | undefined {
  const n = norm(question);
  return SENSITIVE_CATEGORIES.find((c) => SENSITIVE[c].some((re) => re.test(n)));
}
