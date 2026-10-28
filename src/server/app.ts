import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { Config, loadConfig, saveConfig } from "../core/config.js";
import { type DB, kvGet, openDb } from "../core/db.js";
import { closeHandoffs, getHandoff, type Handoff, listHandoffs, REASONS } from "../core/handoffs.js";
import { allowance, companyAllowed, startOfToday } from "../core/limits.js";
import { type Paths, packageRoot } from "../core/paths.js";
import { checkFit } from "../core/rules.js";
import {
  APP_STATUSES,
  type AppStatus,
  applicationEvents,
  approveReview,
  countSubmittedSince,
  getApplication,
  listApplications,
  listQuestions,
  listRuns,
  openQuestionsFor,
  questionApplications,
  setStatus,
} from "../core/store.js";
import { deleteAnswer, listAnswers, updateAnswer } from "../memory/answers.js";
import { loadProfile, PROFILE_FIELDS, type Profile } from "../memory/profile.js";
import { answerQuestion, dismissQuestion } from "../memory/queue.js";
import { discover } from "../runner/discover.js";
import { isPaused } from "../runner/run.js";
import { scheduleInstalled } from "../scheduler/index.js";
import { defaultFetcher, type Fetcher } from "../sources/http.js";

export interface AppOptions {
  p: Paths;
  port: number;
  /** Start a run in the background. Defaults to spawning `quietapply run`. */
  startRun?: () => void;
  fetcher?: Fetcher;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** The dashboard API. It only listens on 127.0.0.1 and rejects requests from other origins. */
export function createApp(opts: AppOptions): Hono {
  const { p } = opts;
  const app = new Hono();
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  let db: DB | undefined;
  const getDb = () => {
    db ??= openDb(p);
    return db;
  };

  // DNS-rebinding guard: only our own host names. CSRF guard: writes need a custom header, which a
  // cross-site form or simple fetch cannot send without a CORS preflight (and we allow no CORS).
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!allowedHosts.has(host)) return c.text("Forbidden host", 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (c.req.header("x-quietapply") !== "1") return c.text("Missing x-quietapply header", 403);
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, "")))
        return c.text("Forbidden origin", 403);
    }
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
  });

  const running = () => existsSync(p.lock);

  app.get("/api/summary", (c) => {
    const d = getDb();
    const config = loadConfig(p);
    const profile = loadProfile(p);
    const apps = listApplications(d, { limit: 100_000 });
    const counts = Object.fromEntries(APP_STATUSES.map((s) => [s, 0])) as Record<AppStatus, number>;
    for (const a of apps) counts[a.status]++;
    const a = allowance(d, config);
    const last = JSON.parse(kvGet(d, "schedule:last") ?? "{}") as { slot?: string };
    const today = startOfToday();
    const doneToday = apps.filter(
      (x) => ["submitted", "dry_run", "awaiting_review"].includes(x.status) && x.updated_at >= today,
    ).length;
    const handoffsToday = listHandoffs(d, "all").filter(
      (h) => h.created_at >= today && h.state !== "superseded",
    );
    const openHandoffs = listHandoffs(d, "open");
    return c.json({
      today: {
        done: doneToday,
        couldnt: handoffsToday.length,
        needYou: handoffsToday.filter((h) => h.state === "open" && REASONS[h.reason].needsYou).length,
      },
      handoffs: {
        open: openHandoffs.length,
        needYou: openHandoffs.filter((h) => REASONS[h.reason].needsYou).length,
      },
      profileName: profile.name,
      provider: config.provider,
      browser: config.browser,
      dryRun: config.dryRun,
      paused: isPaused(p),
      running: running(),
      reviewMode: a.reviewMode,
      reviewFirst: config.limits.reviewFirst,
      perDay: config.limits.perDay,
      submittedToday: countSubmittedSince(d, startOfToday()),
      remainingToday: a.remainingToday,
      openQuestions: listQuestions(d, "open").length,
      counts,
      schedule: config.schedule,
      scheduleInstalled: scheduleInstalled(),
      lastSlot: last.slot ?? null,
      lastRun: listRuns(d, 1)[0] ?? null,
      companies: config.companies.length,
    });
  });

  app.get("/api/applications", (c) => {
    const d = getDb();
    const status = c.req.query("status");
    const wanted = status
      ? (status.split(",").filter((s) => (APP_STATUSES as readonly string[]).includes(s)) as AppStatus[])
      : undefined;
    const apps = listApplications(d, { status: wanted, limit: 1000 }).map((a) => ({
      ...a,
      description: undefined,
      openQuestions: openQuestionsFor(d, a.id).length,
    }));
    return c.json(apps);
  });

  app.get("/api/applications/:id", (c) => {
    const d = getDb();
    const a = getApplication(d, Number(c.req.param("id")));
    if (!a) return c.json({ error: "not found" }, 404);
    return c.json({ ...a, events: applicationEvents(d, a.id), questions: openQuestionsFor(d, a.id) });
  });

  app.post("/api/applications/:id/:action{approve|requeue|dismiss}", (c) => {
    const d = getDb();
    const id = Number(c.req.param("id"));
    const a = getApplication(d, id);
    if (!a) return c.json({ error: "not found" }, 404);
    const action = c.req.param("action");
    if (action === "approve") {
      if (a.status !== "awaiting_review")
        return c.json({ error: "only applications waiting for review can be approved" }, 400);
      approveReview(d, id);
    } else if (action === "requeue") {
      if (["submitted", "submitting", "unclear"].includes(a.status) && c.req.query("force") !== "1")
        return c.json({ error: "this one may already be submitted; check the site first" }, 400);
      setStatus(d, id, "queued", { reason: "queued again by you" });
      closeHandoffs(d, id, "retried");
    } else {
      setStatus(d, id, "skipped", { reason: "dismissed by you" });
      closeHandoffs(d, id, "not_interested");
    }
    return c.json(getApplication(d, id));
  });

  // ---------- Finish yourself ----------

  /** Your own details, ready to copy into a form. */
  const detailsToCopy = (profile: Profile) =>
    PROFILE_FIELDS.map((f) => ({ label: f.field.replace(/_/g, " "), value: f.value(profile) })).filter(
      (x): x is { label: string; value: string } => !!x.value,
    );

  /** Why a retry would not help right now, or undefined when it may. */
  const retryBlocker = (d: DB, h: Handoff): string | undefined => {
    const a = getApplication(d, h.application_id);
    if (!a) return "the job is gone";
    if (!REASONS[h.reason].retryable) return "Retrying would not change anything for this reason.";
    if (h.reason === "unknown_question" && openQuestionsFor(d, a.id).length)
      return "Answer the open question(s) first.";
    if (h.reason === "fit_gate") {
      const fit = checkFit(a, loadConfig(p).rules, loadProfile(p));
      if (!fit.fit) return `Still blocked by your rules: ${fit.reason}.`;
    }
    if (h.reason === "cap" && !loadConfig(p).dryRun) {
      const config = loadConfig(p);
      if (allowance(d, config).remainingToday <= 0) return "Today's limit is used up.";
      if (!companyAllowed(d, config, a.company)) return `The limit for ${a.company} is still used up.`;
    }
    return undefined;
  };

  app.get("/api/handoffs", (c) => {
    const d = getDb();
    const profile = loadProfile(p);
    const mine = detailsToCopy(profile);
    const state = c.req.query("state") === "all" ? "all" : "open";
    return c.json(
      listHandoffs(d, state).flatMap((h) => {
        const a = getApplication(d, h.application_id);
        if (!a) return [];
        const blocker = h.state === "open" ? retryBlocker(d, h) : "Already handled.";
        return [
          {
            ...h,
            label: REASONS[h.reason].label,
            help: REASONS[h.reason].help,
            needsYou: REASONS[h.reason].needsYou,
            canRetry: !blocker,
            retryBlocker: blocker ?? null,
            application: {
              id: a.id,
              company: a.company,
              title: a.title,
              url: a.url,
              ats: a.ats,
              status: a.status,
            },
            questions: openQuestionsFor(d, a.id).map((q) => q.question),
            mine,
          },
        ];
      }),
    );
  });

  app.post("/api/handoffs/:id/:action{applied|not_interested|retry}", (c) => {
    const d = getDb();
    const h = getHandoff(d, Number(c.req.param("id")));
    if (!h) return c.json({ error: "not found" }, 404);
    if (h.state !== "open") return c.json({ error: "already handled" }, 409);
    const action = c.req.param("action") as "applied" | "not_interested" | "retry";
    if (action === "retry") {
      const why = retryBlocker(d, h);
      if (why) return c.json({ error: why }, 400);
      setStatus(d, h.application_id, "queued", { reason: "queued again by you" });
      closeHandoffs(d, h.application_id, "retried");
    } else if (action === "applied") {
      // Not "submitted": that would count against the daily cap and the review-first count, which are
      // about what the agent sent.
      setStatus(d, h.application_id, "skipped", { reason: "you applied yourself" });
      closeHandoffs(d, h.application_id, "applied");
    } else {
      setStatus(d, h.application_id, "skipped", { reason: "not interested (you)" });
      closeHandoffs(d, h.application_id, "not_interested");
    }
    return c.json(getHandoff(d, h.id));
  });

  app.get("/api/questions", (c) => {
    const d = getDb();
    const status = (c.req.query("status") ?? "open") as "open" | "answered" | "all";
    return c.json(
      listQuestions(d, status).map((q) => ({
        ...q,
        options: q.options ? (JSON.parse(q.options) as string[]) : [],
        applications: questionApplications(d, q.id)
          .map((id) => getApplication(d, id))
          .filter(Boolean)
          .map((a) => ({ id: a!.id, company: a!.company, title: a!.title })),
      })),
    );
  });

  const AnswerBody = z.object({
    answer: z.string().min(1).max(5000),
    scope: z.enum(["global", "company"]).default("global"),
  });
  app.post("/api/questions/:id/answer", async (c) => {
    const body = AnswerBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "answer is required" }, 400);
    try {
      const r = answerQuestion(getDb(), Number(c.req.param("id")), body.data);
      return c.json({ memoryId: r.memory.id, released: r.released });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post("/api/questions/:id/dismiss", (c) => {
    dismissQuestion(getDb(), Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  app.get("/api/memory", (c) => c.json(listAnswers(getDb())));
  app.put("/api/memory/:id", async (c) => {
    const body = z
      .object({ answer: z.string().min(1).max(5000) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "answer is required" }, 400);
    const a = updateAnswer(getDb(), Number(c.req.param("id")), body.data);
    return a ? c.json(a) : c.json({ error: "not found" }, 404);
  });
  app.delete("/api/memory/:id", (c) => c.json({ ok: deleteAnswer(getDb(), Number(c.req.param("id"))) }));

  app.get("/api/runs", (c) => c.json(listRuns(getDb(), 100)));

  app.post("/api/run", (c) => {
    if (isPaused(p)) return c.json({ error: "paused" }, 409);
    if (running()) return c.json({ error: "a run is already in progress" }, 409);
    (opts.startRun ?? defaultStartRun(p))();
    return c.json({ started: true });
  });

  app.post("/api/pause", async (c) => {
    const body = z.object({ paused: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "paused: boolean required" }, 400);
    if (body.data.paused) writeFileSync(p.pauseFlag, new Date().toISOString());
    else rmSync(p.pauseFlag, { force: true });
    return c.json({ paused: isPaused(p) });
  });

  app.post("/api/discover", async (c) => {
    const s = await discover(getDb(), loadConfig(p), loadProfile(p), opts.fetcher ?? defaultFetcher);
    return c.json(s);
  });

  app.get("/api/settings", (c) => {
    const config = loadConfig(p);
    const profile = loadProfile(p);
    return c.json({
      config,
      profile: {
        name: profile.name,
        email: profile.email,
        location: profile.location,
        resumeFile: profile.resumeFile,
      },
      home: p.home,
    });
  });

  const SettingsBody = z.object({
    dryRun: z.boolean().optional(),
    schedule: Config.shape.schedule.optional(),
    limits: z
      .object({
        perDay: z.number().int().min(0).max(100),
        reviewFirst: z.number().int().min(0),
        perCompany30d: z.number().int().min(0),
      })
      .partial()
      .optional(),
    rules: z
      .object({
        roles: z.array(z.string()),
        locations: z.array(z.string()),
        neverApply: z.array(z.string()),
        excludeTitles: z.array(z.string()),
      })
      .partial()
      .optional(),
  });
  app.put("/api/settings", async (c) => {
    const body = SettingsBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues.map((i) => i.message).join("; ") }, 400);
    const config = loadConfig(p);
    const b = body.data;
    if (b.dryRun !== undefined) config.dryRun = b.dryRun;
    if (b.schedule) config.schedule = b.schedule;
    if (b.limits) config.limits = { ...config.limits, ...b.limits };
    if (b.rules) config.rules = { ...config.rules, ...b.rules };
    saveConfig(config, p);
    return c.json({ config: loadConfig(p) });
  });

  // Static dashboard (built by Vite into dist/web).
  const webRoot = join(packageRoot(), "dist", "web");
  app.get("*", (c) => {
    const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(webRoot, rel);
    if (!file.startsWith(webRoot) || !existsSync(file) || rel === "/" || !extname(file))
      file = join(webRoot, "index.html");
    if (!existsSync(file)) return c.text("Dashboard not built. Run `npm run build`.", 500);
    c.header("content-type", MIME[extname(file)] ?? "application/octet-stream");
    if (file.includes(`${join("assets", "")}`))
      c.header("cache-control", "public, max-age=31536000, immutable");
    return c.body(readFileSync(file));
  });

  return app;
}

function defaultStartRun(p: Paths): () => void {
  return () => {
    const cli = join(packageRoot(), "dist", "cli", "index.js");
    const child = spawn(process.execPath, [cli, "run"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, QUIETAPPLY_HOME: p.home },
    });
    child.unref();
  };
}
