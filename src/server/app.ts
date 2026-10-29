import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { z } from "zod";
import { phoneOff, phoneOn, phoneStatus } from "../cli/phone.js";
import { Config, loadConfig, saveConfig } from "../core/config.js";
import { type DB, kvGet, openDb } from "../core/db.js";
import { closeHandoffs, getHandoff, type Handoff, listHandoffs, REASONS } from "../core/handoffs.js";
import { allowance, companyAllowed, startOfToday } from "../core/limits.js";
import { type Paths, packageRoot } from "../core/paths.js";
import { checkFit } from "../core/rules.js";
import { evidenceHash } from "../core/safety.js";
import {
  APP_STATUSES,
  type AppStatus,
  addApplication,
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
import { emailsFor } from "../email/apply.js";
import { cleanAddress } from "../email/compose.js";
import { declineEmail, emailStatus, smtpPreset, turnOffEmail, turnOnEmail } from "../email/mode.js";
import { forgetPassword, type SecretDeps, savePassword } from "../email/secret.js";
import {
  approveMessage,
  dismissMessage,
  MESSAGE_MAX_PER_DAY,
  MESSAGE_QUESTION,
  MESSAGE_RISK,
  messagesEnabled,
  messagesFor,
  messagesSentSince,
  turnOffMessages,
  turnOnMessages,
} from "../linkedin/messages.js";
import {
  clearLinkedInStop,
  LINKEDIN_MAX_PER_DAY,
  LINKEDIN_RISK,
  linkedInJobUrl,
  linkedInStatus,
  turnOffLinkedIn,
  turnOnLinkedIn,
} from "../linkedin/mode.js";
import { deleteAnswer, homeCountry, listAnswers, updateAnswer } from "../memory/answers.js";
import { loadProfile, PROFILE_FIELDS, type Profile } from "../memory/profile.js";
import { answerQuestion, dismissQuestion } from "../memory/queue.js";
import { discover } from "../runner/discover.js";
import { blockedRequests, screenshotFile, screenshotsFor } from "../runner/evidence.js";
import { isPaused } from "../runner/run.js";
import {
  type ScheduleEnv,
  scheduleInstalled,
  scheduleState,
  scheduleStatusLines,
  setAutoStart,
} from "../scheduler/index.js";
import { detectAts } from "../sources/detect.js";
import { defaultFetcher, type Fetcher } from "../sources/http.js";
import { checkAccess, originAllowed } from "./guard.js";

export interface AppOptions {
  p: Paths;
  port: number;
  /** Start a run in the background. Defaults to spawning `quietapply run`. */
  startRun?: () => void;
  fetcher?: Fetcher;
  /** The tailscale CLI for phone access. Undefined: look it up. Null: behave as if it is not installed. */
  tailscaleBin?: string | null;
  /** Where the SMTP password is kept. Tests pass a fake keychain. */
  secretDeps?: SecretDeps;
  /** The CLI entry the login item and schedule start. Default: this build's own. */
  cli?: string;
  /** Platform, command runner and home for "Run automatically". Tests pass a recorder. */
  scheduleEnv?: ScheduleEnv;
  /** Changing "Run automatically" is deferred so this response gets out first; tests run it at once. */
  defer?: (f: () => void) => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/** The dashboard API. It only listens on 127.0.0.1 and rejects requests from other origins. */
export function createApp(opts: AppOptions): Hono {
  const { p } = opts;
  const app = new Hono();
  let db: DB | undefined;
  const getDb = () => {
    db ??= openDb(p);
    return db;
  };

  // DNS-rebinding guard: only our own host names (see guard.ts for the tailnet case). CSRF guard: writes
  // need a custom header, which a cross-site form or simple fetch cannot send without a CORS preflight
  // (and we allow no CORS), and an Origin, when present, must be our own.
  app.use("*", async (c, next) => {
    const access = checkAccess(
      { host: c.req.header("host"), login: c.req.header("tailscale-user-login") },
      { p, port: opts.port },
    );
    if (!access.ok) return c.text(access.why, access.status);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (c.req.header("x-quietapply") !== "1") return c.text("Missing x-quietapply header", 403);
      if (origin && !originAllowed(origin, access)) return c.text("Forbidden origin", 403);
    }
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("cache-control", c.res.headers.get("cache-control") ?? "no-store");
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
    const submitted = new Set(apps.filter((x) => x.status === "submitted").map((x) => x.id));
    const openHandoffs = listHandoffs(d, "open").filter((h) => !submitted.has(h.application_id));
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
      linkedin: linkedInStatus(d, config),
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
    const screenshots = screenshotsFor(p, a.id).map((s) => ({
      ...s,
      url: `/api/applications/${a.id}/screenshots/${s.run}/${encodeURIComponent(s.file)}`,
      blockedRequests: blockedRequests(p, a.id, s.run),
    }));
    return c.json({
      ...a,
      events: applicationEvents(d, a.id),
      questions: openQuestionsFor(d, a.id),
      screenshots,
      contentHash: evidenceHash(a.evidence) ?? null,
      emails: emailsFor(d, a.id),
      messages: messagesFor(d, a.id),
    });
  });

  // The agent's screenshots of the form, from the application's run folders only.
  app.get("/api/applications/:id/screenshots/:run/:file", (c) => {
    const file = screenshotFile(
      p,
      Number(c.req.param("id")),
      Number(c.req.param("run")),
      c.req.param("file"),
    );
    if (!file) return c.json({ error: "not found" }, 404);
    c.header("content-type", MIME[extname(file).toLowerCase()] ?? "image/jpeg");
    c.header("cache-control", "private, max-age=3600");
    return c.body(readFileSync(file));
  });

  /** Queue one job by its link: a Greenhouse, Lever or Ashby job, or a LinkedIn job when LinkedIn mode is on. */
  app.post("/api/applications", async (c) => {
    const body = z
      .object({
        url: z.string().min(8).max(2000),
        company: z.string().optional(),
        title: z.string().optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "a job link is required" }, 400);
    const { url, company, title } = body.data;
    const linkedin = linkedInJobUrl(url);
    if (linkedin) {
      if (!linkedInStatus(getDb(), loadConfig(p)).enabled)
        return c.json({ error: "Turn on LinkedIn mode in Settings first." }, 400);
      const id = linkedin.match(/\d+/)![0];
      const r = addApplication(getDb(), {
        url: linkedin,
        company: company ?? "LinkedIn job",
        title: title ?? `LinkedIn job ${id}`,
        ats: "linkedin",
        source: "linkedin",
      });
      return c.json(r);
    }
    const ref = detectAts(url);
    if (!ref?.jobId)
      return c.json({ error: "That is not a Greenhouse, Lever, Ashby or LinkedIn job link." }, 400);
    return c.json(
      addApplication(getDb(), {
        url,
        company: company ?? ref.token.replace(/[-_]/g, " "),
        title: title ?? "Job",
        ats: ref.ats,
        source: "manual",
      }),
    );
  });

  app.post("/api/applications/:id/:action{approve|requeue|dismiss}", async (c) => {
    const d = getDb();
    const id = Number(c.req.param("id"));
    const a = getApplication(d, id);
    if (!a) return c.json({ error: "not found" }, 404);
    const action = c.req.param("action");
    if (action === "approve") {
      if (a.status !== "awaiting_review")
        return c.json({ error: "only applications waiting for review can be approved" }, 400);
      // The OK is bound to exactly what you looked at: the page sends the fingerprint it showed.
      const seen = ((await c.req.json().catch(() => ({}))) as { hash?: unknown }).hash;
      const current = evidenceHash(a.evidence);
      if (!current) return c.json({ error: "there is nothing recorded to approve yet" }, 400);
      if (seen !== current)
        return c.json({ error: "this application changed since you opened it. Look at it again" }, 409);
      approveReview(d, id, current);
    } else if (action === "requeue") {
      if (["submitted", "submitting", "unclear"].includes(a.status) && c.req.query("force") !== "1")
        return c.json({ error: "this one may already be submitted, so check the site first" }, 400);
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
      const profile = loadProfile(p);
      const fit = checkFit(a, loadConfig(p).rules, profile, homeCountry(d, profile));
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
        // An open record whose job was submitted since (re-queued by hand, older data) needs nothing.
        if (!a || (h.state === "open" && a.status === "submitted")) return [];
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
    if (!body.success) return c.json({ error: body.error.issues.map((i) => i.message).join(". ") }, 400);
    const config = loadConfig(p);
    const b = body.data;
    if (b.dryRun !== undefined) config.dryRun = b.dryRun;
    if (b.schedule) config.schedule = b.schedule;
    if (b.limits) config.limits = { ...config.limits, ...b.limits };
    if (b.rules) config.rules = { ...config.rules, ...b.rules };
    saveConfig(config, p);
    return c.json({ config: loadConfig(p) });
  });

  // "Run automatically while your computer is on": the dashboard at login and the run schedule.
  const autoStartInfo = () => {
    const config = loadConfig(p);
    const state = scheduleState(opts.scheduleEnv);
    const last = JSON.parse(kvGet(getDb(), "schedule:last") ?? "{}") as { slot?: string; status?: string };
    return {
      on: state.dashboard && state.runs,
      ...state,
      schedule: config.schedule,
      lines: scheduleStatusLines(state, config, last),
    };
  };
  app.get("/api/autostart", (c) => c.json({ ...autoStartInfo(), canChange: onThisMac(c) }));
  app.put("/api/autostart", async (c) => {
    if (!onThisMac(c)) return c.json({ error: "This can only be changed on the computer itself." }, 403);
    const body = z.object({ on: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "on (true or false) is required" }, 400);
    const cli = opts.cli ?? fileURLToPath(new URL("../cli/index.js", import.meta.url));
    // This dashboard may be the login item itself, which installing or removing restarts or stops, so
    // the answer goes out first and the change follows a moment later. The page then reads the state.
    let result: { ok: boolean; message: string } | undefined;
    (opts.defer ?? ((f) => setTimeout(f, 300)))(() => {
      result = setAutoStart(p, cli, body.data.on, opts.scheduleEnv);
    });
    return c.json({
      ok: result?.ok ?? true,
      message:
        result?.message ??
        (body.data.on
          ? "Turning on: the dashboard will start when you log in, and runs happen at the times below."
          : "Turning off: no login item and no schedule. Run now still works."),
    });
  });

  // Phone access over Tailscale. Anyone who can open the dashboard sees the state. Switching it on or off
  // and changing who may open it work only on this Mac: a request through Tailscale Serve carries the
  // tailnet host name and a Tailscale-User-Login header, and both are refused here.
  const phoneOpts = { p, port: opts.port, bin: opts.tailscaleBin };
  const onThisMac = (c: { req: { header: (n: string) => string | undefined } }) => {
    const access = checkAccess({ host: c.req.header("host") }, { p, port: opts.port });
    return access.ok && access.kind === "local" && !c.req.header("tailscale-user-login");
  };
  const NOT_HERE = "Phone access can only be changed on the Mac itself, at http://127.0.0.1.";

  app.get("/api/phone", async (c) => c.json({ ...(await phoneStatus(phoneOpts)), canChange: onThisMac(c) }));

  app.post("/api/phone", async (c) => {
    if (!onThisMac(c)) return c.json({ error: NOT_HERE }, 403);
    const body = z.object({ on: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Send on: true or false" }, 400);
    const r = body.data.on ? await phoneOn({ ...phoneOpts, checkUp: false }) : await phoneOff(phoneOpts);
    const status = await phoneStatus(phoneOpts);
    if (!r.ok)
      return c.json({ error: r.lines.filter(Boolean)[0] ?? "Tailscale said no", lines: r.lines }, 400);
    return c.json({ ...status, canChange: true });
  });

  const Logins = z.object({ logins: z.array(z.string().trim().toLowerCase().min(3).max(200)).max(20) });
  app.put("/api/phone/logins", async (c) => {
    if (!onThisMac(c)) return c.json({ error: NOT_HERE }, 403);
    const body = Logins.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Each login is an email address, at most 20" }, 400);
    const config = loadConfig(p);
    config.phone.allowedLogins = [...new Set(body.data.logins)];
    saveConfig(config, p);
    return c.json({ ...(await phoneStatus(phoneOpts)), canChange: true });
  });

  app.get("/api/linkedin", (c) =>
    c.json({
      ...linkedInStatus(getDb(), loadConfig(p)),
      risk: LINKEDIN_RISK,
      maxPerDay: LINKEDIN_MAX_PER_DAY,
    }),
  );

  const LinkedInBody = z.object({
    enabled: z.boolean().optional(),
    /** Must be true to turn it on: the user ticked "I accept this risk" under the risk statement. */
    acceptRisk: z.boolean().optional(),
    perDay: z.number().int().min(1).max(LINKEDIN_MAX_PER_DAY).optional(),
    chromeDevice: z.string().max(100).nullable().optional(),
  });
  app.put("/api/linkedin", async (c) => {
    const body = LinkedInBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success)
      return c.json({ error: `The daily LinkedIn cap is 1 to ${LINKEDIN_MAX_PER_DAY}.` }, 400);
    let config = loadConfig(p);
    const b = body.data;
    if (b.perDay !== undefined) config.linkedin.perDay = b.perDay;
    if (b.chromeDevice !== undefined) config.linkedin.chromeDevice = b.chromeDevice?.trim() || undefined;
    if (b.enabled === true && !config.sources.linkedin) {
      const r = turnOnLinkedIn(config, { acceptRisk: b.acceptRisk === true });
      if (!r.ok) return c.json({ error: r.error }, 400);
      config = r.config;
    } else if (b.enabled === false) config = turnOffLinkedIn(config);
    saveConfig(config, p);
    return c.json(linkedInStatus(getDb(), loadConfig(p)));
  });

  // ---------- recruiter messages (LinkedIn) ----------

  const messageInfo = () => {
    const config = loadConfig(p);
    return {
      enabled: messagesEnabled(config),
      acceptedAt: config.linkedin.messages.acceptedAt ?? null,
      declinedAt: config.linkedin.messages.declinedAt ?? null,
      perDay: config.linkedin.messages.perDay,
      maxPerDay: MESSAGE_MAX_PER_DAY,
      sentToday: messagesSentSince(getDb(), startOfToday()),
      question: MESSAGE_QUESTION,
      risk: MESSAGE_RISK,
    };
  };
  app.get("/api/linkedin/messages", (c) => c.json(messageInfo()));
  const MessagesBody = z.object({
    enabled: z.boolean().optional(),
    /** Must be true to turn messages on: the user said yes under the risk statement. */
    accept: z.boolean().optional(),
    perDay: z.number().int().min(1).max(MESSAGE_MAX_PER_DAY).optional(),
  });
  app.put("/api/linkedin/messages", async (c) => {
    const body = MessagesBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: `The daily message cap is 1 to ${MESSAGE_MAX_PER_DAY}.` }, 400);
    let config = loadConfig(p);
    const b = body.data;
    if (b.perDay !== undefined) config.linkedin.messages.perDay = b.perDay;
    if (b.enabled === true) {
      const r = turnOnMessages(config, { accept: b.accept === true });
      if (!r.ok) return c.json({ error: r.error }, 400);
      config = r.config;
    } else if (b.enabled === false) config = turnOffMessages(config);
    saveConfig(config, p);
    return c.json(messageInfo());
  });
  app.post("/api/messages/:id/:action{approve|dismiss}", async (c) => {
    const id = Number(c.req.param("id"));
    try {
      if (c.req.param("action") === "approve") {
        const hash = ((await c.req.json().catch(() => ({}))) as { hash?: string }).hash ?? "";
        return c.json(approveMessage(getDb(), id, hash));
      }
      dismissMessage(getDb(), id);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ---------- email applications ----------

  app.get("/api/email", (c) => c.json(emailStatus(getDb(), loadConfig(p), p, opts.secretDeps)));
  const EmailBody = z.object({
    enabled: z.boolean().optional(),
    /** Must be true to turn email on: the user said yes to the question under the risk statement. */
    accept: z.boolean().optional(),
    /** The user said no: stored with its time, nothing is ever sent. */
    decline: z.boolean().optional(),
    from: z.string().max(200).optional(),
    host: z.string().max(200).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    user: z.string().max(200).optional(),
    perDay: z.number().int().min(1).max(50).optional(),
    doNotContact: z.array(z.string().max(300)).max(1000).optional(),
  });
  app.put("/api/email", async (c) => {
    const body = EmailBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Check the email settings: something is not valid." }, 400);
    const b = body.data;
    let config = loadConfig(p);
    if (b.from !== undefined) {
      if (b.from && !cleanAddress(b.from)) return c.json({ error: "That is not an email address." }, 400);
      config.email.from = cleanAddress(b.from);
      const preset = config.email.from ? smtpPreset(config.email.from) : undefined;
      if (preset && !config.email.smtp.host) config.email.smtp = { ...config.email.smtp, ...preset };
      if (config.email.from && !config.email.smtp.user) config.email.smtp.user = config.email.from;
    }
    if (b.host !== undefined) config.email.smtp.host = b.host.trim() || undefined;
    if (b.port !== undefined) config.email.smtp.port = b.port;
    if (b.secure !== undefined) config.email.smtp.secure = b.secure;
    if (b.user !== undefined) config.email.smtp.user = b.user.trim() || undefined;
    if (b.perDay !== undefined) config.email.perDay = b.perDay;
    if (b.doNotContact !== undefined)
      config.doNotContact = [...new Set(b.doNotContact.map((x) => x.trim()).filter(Boolean))];
    if (b.enabled === true) {
      if (b.accept !== true) return c.json({ error: "Say yes to the question to turn email on." }, 400);
      config = turnOnEmail(config, { accept: true });
    } else if (b.enabled === false) config = turnOffEmail(config, p, opts.secretDeps);
    if (b.decline === true) config = declineEmail(config);
    saveConfig(config, p);
    return c.json(emailStatus(getDb(), loadConfig(p), p, opts.secretDeps));
  });
  app.post("/api/email/password", async (c) => {
    const body = z
      .object({ password: z.string().min(4).max(200) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Paste the app password from your mail provider." }, 400);
    const config = loadConfig(p);
    if (!config.email.smtp.user) return c.json({ error: "Save your address first." }, 400);
    try {
      const where = savePassword(p, config.email.smtp.user, body.data.password, opts.secretDeps);
      // The password itself is never sent back.
      return c.json({ ...emailStatus(getDb(), config, p, opts.secretDeps), storedIn: where });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
  app.delete("/api/email/password", (c) => {
    const config = loadConfig(p);
    forgetPassword(p, config.email.smtp.user, opts.secretDeps);
    return c.json(emailStatus(getDb(), config, p, opts.secretDeps));
  });

  app.post("/api/linkedin/resume", (c) => {
    clearLinkedInStop(getDb());
    return c.json(linkedInStatus(getDb(), loadConfig(p)));
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
