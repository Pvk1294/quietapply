import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, loadConfig } from "../core/config.js";
import { type DB, openDb } from "../core/db.js";
import { filledFromEvidence, recordHandoff, unsupportedSite } from "../core/handoffs.js";
import { allowance, companyAllowed, startOfToday } from "../core/limits.js";
import { acquireLock } from "../core/lock.js";
import { type Paths, packageRoot, paths } from "../core/paths.js";
import { checkFit } from "../core/rules.js";
import { injectionSignals } from "../core/safety.js";
import {
  type Application,
  finishRun,
  getApplication,
  listApplications,
  setStatus,
  startRun,
} from "../core/store.js";
import { applyByEmail, emailTarget } from "../email/apply.js";
import type { Sender } from "../email/send.js";
import { approvedMessages, messagesEnabled, messagesSentSince } from "../linkedin/messages.js";
import {
  isLinkedInApp,
  LINKEDIN_RUN_NOTE,
  linkedInEnabled,
  linkedInSetupProblem,
  linkedInStop,
  linkedInUsedToday,
  looksLikeLinkedInWarning,
  stopLinkedIn,
} from "../linkedin/mode.js";
import { Desk, type DeskOptions } from "../mcp/desk.js";
import { homeCountry } from "../memory/answers.js";
import { loadProfile, type Profile } from "../memory/profile.js";
import { getProvider } from "../providers/index.js";
import { npxCommand } from "../providers/spawn.js";
import type { AgentRunResult, McpServerSpec } from "../providers/types.js";
import { defaultFetcher, type Fetcher } from "../sources/http.js";
import { runFolder } from "./evidence.js";
import { expectedForm } from "./expected.js";
import { buildPrompt } from "./prompt.js";
import { scriptedAgent } from "./scripted-agent.js";

const SUMMARY_LABEL: Record<string, string> = {
  blocked: "to finish yourself",
  needs_answers: "waiting for answers",
  awaiting_review: "for review",
  dry_run: "dry run",
};

export const PLAYWRIGHT_MCP = "@playwright/mcp@0.0.83";

export interface RunOptions {
  trigger?: "manual" | "schedule" | "dashboard";
  /** Force a dry run even if config.dryRun is false. */
  dryRun?: boolean;
  /** Only this application. */
  applicationId?: number;
  /** At most this many applications in this run. */
  max?: number;
  p?: Paths;
  fetcher?: Fetcher;
  log?: (line: string) => void;
  /** Human-pause timing for LinkedIn runs (tests make it instant). */
  pace?: DeskOptions;
  /** How email applications are sent. Tests use an in-process fake SMTP server; the default is SMTP. */
  emailSender?: Sender;
}

export interface RunSummary {
  status: "completed" | "paused" | "busy" | "waiting_for_reset" | "nothing_to_do" | "failed";
  runId?: number;
  processed: { id: number; company: string; title: string; status: string; note: string }[];
  message: string;
}

export function isPaused(p: Paths = paths()): boolean {
  return existsSync(p.pauseFlag);
}

/** The browser-side guard that blocks every non-read request while dry run is on. */
export function dryRunGuardPath(): string {
  return join(packageRoot(), "browser", "dry-run-guard.cjs");
}

/** Crops page screenshots to the application form (loaded into Playwright MCP in every run). */
export function formShotPath(): string {
  return join(packageRoot(), "browser", "form-shot.cjs");
}

/**
 * MCP servers for one application: the desk (bound to it) and, unless Claude in Chrome is used, Playwright.
 * In dry run the Playwright browser also loads the network guard, so nothing can be sent even if the agent
 * clicks Submit. Screenshots and the log of blocked requests go to `outputDir` (the application's run folder).
 */
export function mcpServers(
  config: Config,
  p: Paths,
  applicationId: number,
  dryRun: boolean,
  outputDir?: string,
  linkedin = false,
): Record<string, McpServerSpec> {
  const guardLog = outputDir && join(outputDir, "blocked-requests.jsonl");
  const cli = join(packageRoot(), "dist", "cli", "index.js");
  const chrome = config.browser === "claude-in-chrome" || linkedin;
  const servers: Record<string, McpServerSpec> = {
    desk: {
      command: process.execPath,
      args: [cli, "mcp", "--application", String(applicationId), ...(dryRun ? ["--dry-run"] : [])],
      // With Claude in Chrome the desk also locks the run folder when it refuses the submit step (chrome-guard.ts).
      env: { QUIETAPPLY_HOME: p.home, ...(chrome && outputDir ? { QUIETAPPLY_RUN_DIR: outputDir } : {}) },
    },
  };
  // LinkedIn runs always use your own logged-in browser through Claude in Chrome.
  if (!chrome) {
    // Screenshots and page snapshots land in the application's own run folder, where the dashboard finds them.
    const args = ["-y", PLAYWRIGHT_MCP, "--output-dir", outputDir ?? join(p.logsDir, "playwright")];
    if (config.browser === "playwright-extension") args.push("--extension");
    else args.push("--user-data-dir", p.browserProfile);
    if (config.headless) args.push("--headless");
    args.push("--init-page", formShotPath());
    if (dryRun) args.push("--init-page", dryRunGuardPath(), "--block-service-workers");
    const npx = npxCommand();
    servers.playwright = {
      command: npx.command,
      args: [...npx.args, ...args],
      ...(dryRun && guardLog ? { env: { QUIETAPPLY_GUARD_LOG: guardLog } } : {}),
    };
  }
  return servers;
}

/**
 * One run: take queued applications, pass each through the fit gate and the caps, then hand it to the
 * agent with a small prompt. What the agent recorded through the desk is the result; anything it left
 * half-done is marked so it is never retried blindly.
 */
export async function runOnce(opts: RunOptions = {}): Promise<RunSummary> {
  const p = opts.p ?? paths();
  const log = opts.log ?? (() => {});
  if (isPaused(p))
    return {
      status: "paused",
      processed: [],
      message: "Paused. Resume in the dashboard or with `quietapply resume`.",
    };
  const release = acquireLock(p.lock);
  if (!release) return { status: "busy", processed: [], message: "Another run is in progress." };

  const db = openDb(p);
  try {
    const config = loadConfig(p);
    const profile = loadProfile(p);
    const providerId = config.provider;
    // The scripted (fake) agent never submits, so it always runs as a dry run.
    const dryRun = opts.dryRun || config.dryRun || providerId === "fake";
    const runConfig: Config = { ...config, dryRun };
    const queue = pickQueue(db, opts);
    if (!queue.length) return { status: "nothing_to_do", processed: [], message: "No queued applications." };

    const runId = startRun(db, providerId, dryRun, opts.trigger ?? "manual");
    const processed: RunSummary["processed"] = [];
    let stopped: RunSummary["status"] | undefined;
    const limit = Math.min(opts.max ?? Number.POSITIVE_INFINITY, config.limits.perDay || 1);

    const notes: string[] = [];
    for (const app of queue) {
      if (processed.length >= limit) break;
      if (isPaused(p)) {
        stopped = "paused";
        break;
      }
      const linkedin = isLinkedInApp(app);
      if (linkedin) {
        // LinkedIn jobs are added by link, so title and company are only known once the agent reads the
        // page: the fit gate runs then, through job_details. Here: the switch, the setup, the stop and the cap.
        const gate = linkedInGate(db, config);
        if (gate.skip) {
          setStatus(db, app.id, "skipped", { reason: gate.skip });
          processed.push(row(app, "skipped", gate.skip));
          log(`skip  LinkedIn #${app.id}: ${gate.skip}`);
          continue;
        }
        if (gate.hold) {
          log(`wait  LinkedIn #${app.id}: ${gate.hold}`);
          if (!notes.includes(gate.hold)) notes.push(gate.hold);
          continue;
        }
      } else {
        const fit = checkFit(app, config.rules, profile, homeCountry(db, profile));
        if (!fit.fit) {
          setStatus(db, app.id, "skipped", { reason: fit.reason });
          recordHandoff(db, {
            applicationId: app.id,
            reason: "fit_gate",
            detail: `Skipped by your rules: ${fit.reason}.`,
            rule: fit.reason,
          });
          processed.push(row(app, "skipped", fit.reason));
          log(`skip  ${app.company} · ${app.title}: ${fit.reason}`);
          continue;
        }
      }
      if (!dryRun) {
        if (allowance(db, runConfig).remainingToday <= 0) {
          log("Daily limit reached, stopping.");
          break;
        }
        if (!linkedin && !companyAllowed(db, runConfig, app.company)) {
          setStatus(db, app.id, "skipped", {
            reason: `already ${config.limits.perCompany30d} applications to ${app.company} in 30 days`,
          });
          recordHandoff(db, {
            applicationId: app.id,
            reason: "cap",
            detail: `Already ${config.limits.perCompany30d} applications to ${app.company} in the last 30 days.`,
            rule: `at most ${config.limits.perCompany30d} per company per 30 days`,
          });
          processed.push(row(app, "skipped", "per-company limit"));
          continue;
        }
      }
      // Postings that ask for an email: written from your profile and memory, never by the agent.
      if (!linkedin && emailTarget(app)) {
        const r = await applyByEmail({ db, p, config: runConfig, profile, app, sender: opts.emailSender });
        processed.push(row(app, r.status, r.note));
        log(`email ${app.company} · ${app.title} → ${r.status}: ${r.note}`);
        continue;
      }
      const unsupported = unsupportedSite(app.url);
      if (unsupported) {
        const note = `${unsupported} is not automated yet.`;
        setStatus(db, app.id, "blocked", { reason: note, blockedCategory: "unsupported_ats" });
        recordHandoff(db, { applicationId: app.id, reason: "unsupported_ats", detail: note });
        processed.push(row(app, "blocked", note));
        log(`hand over ${app.company} · ${app.title}: ${note}`);
        continue;
      }
      // A posting that speaks to the AI is not opened by the AI: the person reads it first.
      const injected = injectionSignals(app.description);
      if (injected.length) {
        const note = `The posting has text aimed at an AI (${injected.join(", ")}).`;
        setStatus(db, app.id, "blocked", { reason: note, blockedCategory: "suspicious_page" });
        recordHandoff(db, {
          applicationId: app.id,
          reason: "suspicious_page",
          detail: note,
          needed: "Read the posting yourself before you apply.",
        });
        processed.push(row(app, "blocked", note));
        log(`hand over ${app.company} · ${app.title}: ${note}`);
        continue;
      }
      log(`apply ${app.company} · ${app.title}${linkedin ? " (LinkedIn)" : ""}`);
      setStatus(db, app.id, "in_progress", {
        reason: linkedin ? LINKEDIN_RUN_NOTE : dryRun ? "dry run" : undefined,
      });
      const result = await applyOne({
        db,
        p,
        config: runConfig,
        profile,
        app,
        fetcher: opts.fetcher ?? defaultFetcher,
        runId,
        linkedin,
        pace: opts.pace,
      });
      // A LinkedIn run that ended without recording anything but mentions a warning is treated as one.
      if (
        linkedin &&
        getApplication(db, app.id)?.status === "in_progress" &&
        looksLikeLinkedInWarning(result.text)
      ) {
        const detail = `LinkedIn showed a warning: ${result.text.slice(0, 200)}`;
        setStatus(db, app.id, "blocked", { reason: detail, blockedCategory: "linkedin_limit" });
        recordHandoff(db, {
          applicationId: app.id,
          reason: "linkedin_limit",
          detail,
          needed: "Look at your LinkedIn account, then resume LinkedIn mode in Settings.",
          filled: filledFromEvidence(getApplication(db, app.id)?.evidence ?? null),
        });
        stopLinkedIn(db, result.text, app.id);
      }
      const after = settle(db, app.id, result);
      processed.push(row(app, after.status, after.note));
      log(`      → ${after.status}${after.note ? `: ${after.note}` : ""}`);
      if (linkedin) {
        const stop = linkedInStop(db);
        const now = getApplication(db, app.id);
        if (stop) {
          const note =
            "LinkedIn mode stopped after a warning: look at Finish yourself, then resume it in Settings";
          log(`      ${note}`);
          if (!notes.includes(note)) notes.push(note);
        } else if (now?.status === "queued" && !isLinkedInApp(now)) {
          // "Apply on company website": the same job continues on Greenhouse, Lever or Ashby, in this run.
          log(`      continues on the company site: ${now.url}`);
          queue.push(now);
        }
      }
      if (result.status === "usage_limit") {
        stopped = "waiting_for_reset";
        break;
      }
    }

    // Recruiter messages you approved go out in their own short runs, after the applications.
    if (!stopped && !dryRun && messagesEnabled(config)) {
      const sent = await sendApprovedMessages({ db, p, config: runConfig, profile, runId, pace: opts.pace });
      if (sent) notes.push(`${sent} recruiter message${sent > 1 ? "s" : ""} handled`);
    }

    const status = stopped ?? "completed";
    const counts = processed.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    const message =
      status === "waiting_for_reset"
        ? "Usage limit reached. The next run after the reset carries on."
        : Object.entries(counts)
            .map(([k, v]) => `${v} ${SUMMARY_LABEL[k] ?? k.replace(/_/g, " ")}`)
            .concat(notes)
            .join(", ") || "Nothing processed.";
    finishRun(db, runId, status, message);
    return { status, runId, processed, message };
  } finally {
    db.close();
    release();
  }
}

/** Whether a LinkedIn application may start now: `skip` ends it, `hold` leaves it queued for later. */
function linkedInGate(db: DB, config: Config): { skip?: string; hold?: string } {
  if (!linkedInEnabled(config))
    return { skip: "LinkedIn mode is off. Turn it on in Settings to apply to LinkedIn jobs" };
  const problem = linkedInSetupProblem(config);
  if (problem) return { skip: problem };
  if (linkedInStop(db)) return { hold: "LinkedIn mode is stopped after a warning" };
  if (linkedInUsedToday(db) >= config.linkedin.perDay)
    return { hold: `LinkedIn daily cap of ${config.linkedin.perDay} reached` };
  return {};
}

function pickQueue(db: DB, opts: RunOptions): Application[] {
  if (opts.applicationId) {
    const a = getApplication(db, opts.applicationId);
    return a && a.status === "queued" ? [a] : [];
  }
  // Approved reviews first, then oldest first.
  return listApplications(db, { status: ["queued"], limit: 1000 }).sort(
    (a, b) => b.review_approved - a.review_approved || a.created_at.localeCompare(b.created_at),
  );
}

async function applyOne(o: {
  db: DB;
  p: Paths;
  config: Config;
  profile: Profile;
  app: Application;
  fetcher: Fetcher;
  runId: number;
  linkedin: boolean;
  pace?: DeskOptions;
}): Promise<AgentRunResult> {
  const work = runFolder(o.p, o.runId, o.app.id);
  const desk = new Desk(o.db, o.config, o.profile, o.p, o.app.id, { ...o.pace, runDir: work });
  if (o.config.provider === "fake") {
    try {
      return { status: "completed", text: await scriptedAgent(desk, o.fetcher), exitCode: 0 };
    } catch (err) {
      return { status: "failed", text: (err as Error).message, exitCode: 1 };
    }
  }
  // Never fetch LinkedIn pages from here: on LinkedIn only the agent looks, in your own browser.
  const form = o.linkedin ? undefined : await expectedForm(o.fetcher, o.app.url);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  // Browser tools may only upload files inside the run's working folder, so stage a copy of the resume there.
  let resumePath: string | undefined;
  if (o.profile.resumeFile && existsSync(join(o.p.resumeDir, o.profile.resumeFile))) {
    resumePath = join(work, o.profile.resumeFile);
    copyFileSync(join(o.p.resumeDir, o.profile.resumeFile), resumePath);
  }
  const prompt = buildPrompt({
    db: o.db,
    p: o.p,
    app: o.app,
    profile: o.profile,
    mode: desk.mode(),
    form,
    resumePath,
    linkedin: o.linkedin
      ? {
          remainingToday: Math.max(0, o.config.linkedin.perDay - linkedInUsedToday(o.db) + 1),
          chromeDevice: o.config.linkedin.chromeDevice,
        }
      : undefined,
  });
  // The agent's desk server opens its own connection to the database; close nothing here, SQLite WAL
  // lets both processes work on the same file.
  const browser = o.linkedin ? "claude-in-chrome" : o.config.browser;
  return getProvider(o.config.provider).runAgent({
    prompt,
    mcpServers: mcpServers(o.config, o.p, o.app.id, o.config.dryRun, work, o.linkedin),
    browser,
    linkedin: o.linkedin,
    // No network guard exists in Claude in Chrome: in dry run and review the hook guards the browser instead.
    chromeGuardDir: browser === "claude-in-chrome" && desk.mode() !== "live" ? work : undefined,
    cwd: work,
    timeoutMs: o.config.limits.runTimeoutMinutes * 60_000,
    logPath: join(work, "transcript.jsonl"),
    model: o.config.model,
  });
}

/**
 * One Claude in Chrome run per approved recruiter message, within the daily cap. The agent can only send
 * the exact approved text: prepare_message checks every rule again before it hands the text over.
 */
async function sendApprovedMessages(o: {
  db: DB;
  p: Paths;
  config: Config;
  profile: Profile;
  runId: number;
  pace?: DeskOptions;
}): Promise<number> {
  if (o.config.provider !== "claude-code") return 0; // Claude in Chrome only
  let handled = 0;
  for (const m of approvedMessages(o.db)) {
    if (linkedInStop(o.db)) break;
    if (messagesSentSince(o.db, startOfToday()) >= o.config.linkedin.messages.perDay) break;
    const work = join(runFolder(o.p, o.runId, m.application_id), `message-${m.id}`);
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const prompt = [
      readFileSync(join(packageRoot(), "prompts", "message.md"), "utf8"),
      "## This run",
      "```json",
      JSON.stringify(
        {
          messageId: m.id,
          recipient: m.recipient_name,
          profileUrl: m.profile_url,
          browserDeviceId:
            o.config.linkedin.chromeDevice ?? "not set: if more than one browser is connected, end the run",
        },
        null,
        2,
      ),
      "```",
    ].join("\n\n");
    await getProvider(o.config.provider).runAgent({
      prompt,
      mcpServers: mcpServers(o.config, o.p, m.application_id, false, work, true),
      browser: "claude-in-chrome",
      linkedin: true,
      cwd: work,
      timeoutMs: 10 * 60_000,
      logPath: join(work, "transcript.jsonl"),
      model: o.config.model,
    });
    handled++;
  }
  return handled;
}

/** Turn whatever state the agent left into a final status. */
export function settle(db: DB, id: number, result: AgentRunResult): { status: string; note: string } {
  const app = getApplication(db, id)!;
  const short = result.text.split("\n")[0]?.slice(0, 200) ?? "";
  if (app.status === "submitting") {
    // Submit was approved but no result was recorded: it may or may not have gone through.
    const detail = `run ended after Submit was approved (${result.status}), check before retrying`;
    setStatus(db, id, "unclear", { reason: detail });
    recordHandoff(db, {
      applicationId: id,
      reason: "unclear_submit",
      detail,
      filled: filledFromEvidence(app.evidence),
    });
    return { status: "unclear", note: "check the site before retrying" };
  }
  if (app.status === "in_progress") {
    if (result.status === "usage_limit") {
      setStatus(db, id, "queued", { reason: "usage limit reached, retried next run" });
      return { status: "queued", note: "usage limit" };
    }
    const detail = `${result.status}: ${short || "the agent recorded nothing"}`;
    setStatus(db, id, "failed", { reason: detail });
    recordHandoff(db, {
      applicationId: id,
      reason: "form_error",
      detail,
      filled: filledFromEvidence(app.evidence),
    });
    return { status: "failed", note: short };
  }
  return { status: app.status, note: app.reason ?? short };
}

function row(app: Application, status: string, note: string) {
  return { id: app.id, company: app.company, title: app.title, status, note };
}
