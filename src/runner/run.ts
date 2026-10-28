import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Config, loadConfig } from "../core/config.js";
import { type DB, openDb } from "../core/db.js";
import { allowance, companyAllowed } from "../core/limits.js";
import { acquireLock } from "../core/lock.js";
import { type Paths, packageRoot, paths } from "../core/paths.js";
import { checkFit } from "../core/rules.js";
import {
  type Application,
  finishRun,
  getApplication,
  listApplications,
  setStatus,
  startRun,
} from "../core/store.js";
import { Desk } from "../mcp/desk.js";
import { loadProfile, type Profile } from "../memory/profile.js";
import { getProvider } from "../providers/index.js";
import type { AgentRunResult, McpServerSpec } from "../providers/types.js";
import { defaultFetcher, type Fetcher } from "../sources/http.js";
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
): Record<string, McpServerSpec> {
  const guardLog = outputDir && join(outputDir, "blocked-requests.jsonl");
  const cli = join(packageRoot(), "dist", "cli", "index.js");
  const servers: Record<string, McpServerSpec> = {
    desk: {
      command: process.execPath,
      args: [cli, "mcp", "--application", String(applicationId), ...(dryRun ? ["--dry-run"] : [])],
      env: { QUIETAPPLY_HOME: p.home },
    },
  };
  if (config.browser !== "claude-in-chrome") {
    // Screenshots and page snapshots land in the application's own run folder, where the dashboard finds them.
    const args = ["-y", PLAYWRIGHT_MCP, "--output-dir", outputDir ?? join(p.logsDir, "playwright")];
    if (config.browser === "playwright-extension") args.push("--extension");
    else args.push("--user-data-dir", p.browserProfile);
    if (config.headless) args.push("--headless");
    if (dryRun) args.push("--init-page", dryRunGuardPath(), "--block-service-workers");
    servers.playwright = {
      command: "npx",
      args,
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

    for (const app of queue) {
      if (processed.length >= limit) break;
      if (isPaused(p)) {
        stopped = "paused";
        break;
      }
      const fit = checkFit(app, config.rules, profile);
      if (!fit.fit) {
        setStatus(db, app.id, "skipped", { reason: fit.reason });
        processed.push(row(app, "skipped", fit.reason));
        log(`skip  ${app.company} · ${app.title}: ${fit.reason}`);
        continue;
      }
      if (!dryRun) {
        if (allowance(db, runConfig).remainingToday <= 0) {
          log("Daily limit reached; stopping.");
          break;
        }
        if (!companyAllowed(db, runConfig, app.company)) {
          setStatus(db, app.id, "skipped", {
            reason: `already ${config.limits.perCompany30d} applications to ${app.company} in 30 days`,
          });
          processed.push(row(app, "skipped", "per-company limit"));
          continue;
        }
      }
      log(`apply ${app.company} · ${app.title}`);
      setStatus(db, app.id, "in_progress", { reason: dryRun ? "dry run" : undefined });
      const result = await applyOne({
        db,
        p,
        config: runConfig,
        profile,
        app,
        fetcher: opts.fetcher ?? defaultFetcher,
        runId,
      });
      const after = settle(db, app.id, result);
      processed.push(row(app, after.status, after.note));
      log(`      → ${after.status}${after.note ? `: ${after.note}` : ""}`);
      if (result.status === "usage_limit") {
        stopped = "waiting_for_reset";
        break;
      }
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
            .join(", ") || "Nothing processed.";
    finishRun(db, runId, status, message);
    return { status, runId, processed, message };
  } finally {
    db.close();
    release();
  }
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
}): Promise<AgentRunResult> {
  const desk = new Desk(o.db, o.config, o.profile, o.p, o.app.id);
  if (o.config.provider === "fake") {
    try {
      return { status: "completed", text: await scriptedAgent(desk, o.fetcher), exitCode: 0 };
    } catch (err) {
      return { status: "failed", text: (err as Error).message, exitCode: 1 };
    }
  }
  const form = await expectedForm(o.fetcher, o.app.url);
  const work = join(o.p.logsDir, `run-${o.runId}`, `app-${o.app.id}`);
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
  });
  // The agent's desk server opens its own connection to the database; close nothing here, SQLite WAL
  // lets both processes work on the same file.
  return getProvider(o.config.provider).runAgent({
    prompt,
    mcpServers: mcpServers(o.config, o.p, o.app.id, o.config.dryRun, work),
    browser: o.config.browser,
    cwd: work,
    timeoutMs: o.config.limits.runTimeoutMinutes * 60_000,
    logPath: join(work, "transcript.jsonl"),
    model: o.config.model,
  });
}

/** Turn whatever state the agent left into a final status. */
export function settle(db: DB, id: number, result: AgentRunResult): { status: string; note: string } {
  const app = getApplication(db, id)!;
  const short = result.text.split("\n")[0]?.slice(0, 200) ?? "";
  if (app.status === "submitting") {
    // Submit was approved but no result was recorded: it may or may not have gone through.
    setStatus(db, id, "unclear", {
      reason: `run ended after Submit was approved (${result.status}); check before retrying`,
    });
    return { status: "unclear", note: "check the site before retrying" };
  }
  if (app.status === "in_progress") {
    if (result.status === "usage_limit") {
      setStatus(db, id, "queued", { reason: "usage limit reached; retried next run" });
      return { status: "queued", note: "usage limit" };
    }
    setStatus(db, id, "failed", { reason: `${result.status}: ${short || "the agent recorded nothing"}` });
    return { status: "failed", note: short };
  }
  return { status: app.status, note: app.reason ?? short };
}

function row(app: Application, status: string, note: string) {
  return { id: app.id, company: app.company, title: app.title, status, note };
}
