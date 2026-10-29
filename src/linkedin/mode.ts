import type { Config } from "../core/config.js";
import { type DB, kvGet, kvSet, now } from "../core/db.js";
import { startOfToday } from "../core/limits.js";
import type { Application } from "../core/store.js";

/**
 * LinkedIn mode: off by default, opt-in, and deliberately small. The agent drives your own logged-in
 * browser through Claude in Chrome, paces itself like a person, never runs scripts or calls LinkedIn's
 * APIs, and stops for the day at the first warning, limit message or CAPTCHA.
 */

/** Shown (word for word) before LinkedIn mode can be turned on, in the dashboard and in the CLI. */
export const LINKEDIN_RISK = [
  "LinkedIn's User Agreement forbids bots and automated activity on LinkedIn, including applying for jobs with automation.",
  "LinkedIn can restrict or close accounts that it believes are automated. That can happen even with a small daily cap and human-like pacing.",
  "If you turn this on, you take that risk for your own account. QuietApply cannot undo a restriction.",
];

export const LINKEDIN_MAX_PER_DAY = 15;

/** The note on the in_progress event that marks one LinkedIn application opened by the agent. */
export const LINKEDIN_RUN_NOTE = "LinkedIn mode";

/** Handing back with one of these on LinkedIn means "stop all LinkedIn work until the human looks". */
export const STOP_CATEGORIES: readonly string[] = ["linkedin_limit", "linkedin_warning", "captcha", "otp"];

/** Words LinkedIn uses for warnings, limits and human checks. Seeing any of them stops LinkedIn mode. */
export const LINKEDIN_WARNING_RE =
  /(unusual activity|suspicious activity|security (check|verification)|quick security check|verify (you('| a)re|that you are) (a )?human|are you (a )?human|i'?m not a robot|captcha|account (has been |was |is )?(temporarily )?(restricted|limited|suspended)|temporarily (restricted|limited|blocked)|(reached|hit|exceeded) (the |your |today'?s )?(daily |weekly )?(easy apply |application |job application )?limit|too many (requests|applications|attempts)|try again later|automated (activity|behavio(u)?r|tools?)|we('| ha)ve restricted)/i;

const KV_STOP = "linkedin:stop";

export function isLinkedInUrl(url: string): boolean {
  try {
    return /(^|\.)linkedin\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function isLinkedInApp(app: Pick<Application, "ats" | "url">): boolean {
  return app.ats === "linkedin" || isLinkedInUrl(app.url);
}

/**
 * The canonical job URL for a LinkedIn job link (`/jobs/view/<id>` or a search page with `currentJobId`),
 * or undefined when the link is not a LinkedIn job.
 */
export function linkedInJobUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    return undefined;
  }
  if (!isLinkedInUrl(url.toString())) return undefined;
  const id =
    /\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/.exec(url.pathname)?.[1] ?? url.searchParams.get("currentJobId");
  return id && /^\d+$/.test(id) ? `https://www.linkedin.com/jobs/view/${id}/` : undefined;
}

export function looksLikeLinkedInWarning(text: string): boolean {
  return LINKEDIN_WARNING_RE.test(text);
}

export function linkedInEnabled(config: Config): boolean {
  return config.sources.linkedin && !!config.linkedin.acceptedAt;
}

/** Why LinkedIn mode cannot run with this setup, or undefined when it can. */
export function linkedInSetupProblem(config: Config): string | undefined {
  if (config.provider === "fake") return undefined;
  if (config.provider !== "claude-code")
    return "LinkedIn mode needs Claude Code: it drives your own browser through Claude in Chrome, which Codex cannot use.";
  if (config.auth !== "subscription")
    return "LinkedIn mode needs Claude Code signed in with a Claude plan: Claude in Chrome does not work with an API key.";
  return undefined;
}

/** Turn LinkedIn mode on. Only with the risk accepted; the time of acceptance is stored. */
export function turnOnLinkedIn(
  config: Config,
  opts: { acceptRisk: boolean; at?: Date },
): { ok: true; config: Config } | { ok: false; error: string } {
  if (!opts.acceptRisk)
    return { ok: false, error: "Read the risk statement and accept it to turn LinkedIn mode on." };
  const problem = linkedInSetupProblem(config);
  if (problem) return { ok: false, error: problem };
  return {
    ok: true,
    config: {
      ...config,
      sources: { ...config.sources, linkedin: true },
      linkedin: { ...config.linkedin, acceptedAt: (opts.at ?? new Date()).toISOString() },
    },
  };
}

/** Turn it off. The acceptance is cleared, so turning it on again asks again. */
export function turnOffLinkedIn(config: Config): Config {
  const { acceptedAt: _, ...rest } = config.linkedin;
  // Recruiter messages ride on LinkedIn mode: they go off with it and need their own yes again.
  const messages = { ...rest.messages, enabled: false, acceptedAt: undefined };
  return { ...config, sources: { ...config.sources, linkedin: false }, linkedin: { ...rest, messages } };
}

/** LinkedIn applications the agent opened today (dry runs count too: LinkedIn sees the visit either way). */
export function linkedInUsedToday(db: DB, at = new Date()): number {
  const row = db
    .prepare(
      "SELECT COUNT(DISTINCT application_id) AS n FROM application_events WHERE status = 'in_progress' AND note = ? AND at >= ?",
    )
    .get(LINKEDIN_RUN_NOTE, startOfToday(at)) as { n: number };
  return row.n;
}

export interface LinkedInStop {
  at: string;
  reason: string;
  applicationId?: number;
}

export function linkedInStop(db: DB): LinkedInStop | undefined {
  const raw = kvGet(db, KV_STOP);
  return raw ? ((JSON.parse(raw) as LinkedInStop | null) ?? undefined) : undefined;
}

/** Stop all LinkedIn work until the human has looked and pressed "Resume LinkedIn". */
export function stopLinkedIn(db: DB, reason: string, applicationId?: number): void {
  if (linkedInStop(db)) return;
  kvSet(db, KV_STOP, JSON.stringify({ at: now(), reason: reason.slice(0, 300), applicationId }));
}

export function clearLinkedInStop(db: DB): void {
  kvSet(db, KV_STOP, "null");
}

export interface LinkedInStatus {
  enabled: boolean;
  acceptedAt: string | null;
  perDay: number;
  usedToday: number;
  remainingToday: number;
  stopped: LinkedInStop | null;
  setupProblem: string | null;
  chromeDevice: string | null;
}

export function linkedInStatus(db: DB, config: Config, at = new Date()): LinkedInStatus {
  const used = linkedInUsedToday(db, at);
  return {
    enabled: linkedInEnabled(config),
    acceptedAt: config.linkedin.acceptedAt ?? null,
    perDay: config.linkedin.perDay,
    usedToday: used,
    remainingToday: Math.max(0, config.linkedin.perDay - used),
    stopped: linkedInStop(db) ?? null,
    setupProblem: linkedInSetupProblem(config) ?? null,
    chromeDevice: config.linkedin.chromeDevice ?? null,
  };
}

// ---------- acting like a person ----------

export type PaceKind = "action" | "typing" | "page";

/** Random pause ranges in milliseconds. Short enough to keep a run moving, long enough not to look scripted. */
export const PACE: Record<PaceKind, [number, number]> = {
  action: [2000, 6000],
  typing: [700, 2200],
  page: [5000, 12000],
};

export function humanDelayMs(kind: PaceKind, random: () => number = Math.random): number {
  const [min, max] = PACE[kind];
  return Math.round(min + random() * (max - min));
}

/**
 * Split text the way a person types it: short answers in one go, longer ones in two to four chunks that
 * end at word boundaries (sentence ends preferred). Joining the chunks gives back the exact text.
 */
export function typingChunks(text: string): string[] {
  if (text.length <= 80) return [text];
  const n = Math.min(4, Math.max(2, Math.ceil(text.length / 160)));
  const size = Math.ceil(text.length / n);
  const tokens = text.match(/\s*\S+\s*/g) ?? [text];
  const chunks: string[] = [];
  let cur = "";
  for (const t of tokens) {
    cur += t;
    const sentenceEnd = /[.!?]\s*$/.test(cur);
    if (chunks.length < n - 1 && (cur.length >= size || (sentenceEnd && cur.length >= size * 0.6))) {
      chunks.push(cur);
      cur = "";
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** The only Claude in Chrome tools a LinkedIn run may use: look, click, type, upload. No scripts, no network reads. */
export const LINKEDIN_CHROME_TOOLS = [
  "list_connected_browsers",
  "select_browser",
  "tabs_context_mcp",
  "tabs_create_mcp",
  "tabs_close_mcp",
  "navigate",
  "computer",
  "find",
  "read_page",
  "get_page_text",
  "file_upload",
].map((t) => `mcp__claude-in-chrome__${t}`);

/** Refused outright on LinkedIn runs (page scripts, network and console reads, instant form filling, batches). */
export const LINKEDIN_DENIED_CHROME_TOOLS = [
  "javascript_tool",
  "read_network_requests",
  "read_console_messages",
  "browser_batch",
  "form_input",
  "shortcuts_execute",
  "shortcuts_list",
  "gif_creator",
  "upload_image",
  "resize_window",
  "switch_browser",
].map((t) => `mcp__claude-in-chrome__${t}`);

/**
 * Claude in Chrome tools that can click or press keys without going through the `computer` tool (page
 * scripts, batches, saved shortcuts). They are off in dry run and review mode, so `computer` is the one
 * tool that can click, and the guard hook (browser/chrome-guard.cjs) watches it.
 */
export const CHROME_CLICK_TOOLS = ["javascript_tool", "browser_batch", "shortcuts_execute"].map(
  (t) => `mcp__claude-in-chrome__${t}`,
);
