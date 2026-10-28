import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { Config, loadConfig, saveConfig } from "../src/core/config.js";
import { openDb } from "../src/core/db.js";
import { addApplication, getApplication, listQuestions, setStatus } from "../src/core/store.js";
import {
  humanDelayMs,
  linkedInJobUrl,
  linkedInStatus,
  linkedInStop,
  looksLikeLinkedInWarning,
  turnOffLinkedIn,
  turnOnLinkedIn,
  typingChunks,
} from "../src/linkedin/mode.js";
import { Desk } from "../src/mcp/desk.js";
import { agentArgs, allowedTools } from "../src/providers/claude-code.js";
import { runOnce } from "../src/runner/run.js";
import { createApp } from "../src/server/app.js";
import { FIXTURES, fixtureFetcher } from "./helpers/fixtures.js";
import { JANE, makeHome } from "./helpers/home.js";

const LI = join(FIXTURES, "../linkedin");
const liUrl = (f: string) => pathToFileURL(join(LI, f)).toString();
const accepted = { linkedin: { acceptedAt: "2026-10-28T09:00:00.000Z", perDay: 5 } };
const on = (extra: Partial<Config> = {}) =>
  makeHome({
    ...Config.parse({ sources: { linkedin: true }, ...accepted, ...extra }),
    provider: "fake",
  });
const pace = { sleep: async () => {}, random: () => 0.5 };

function queue(p: ReturnType<typeof makeHome>, file: string, n = 1) {
  const db = openDb(p);
  const id = addApplication(db, {
    company: "LinkedIn job",
    title: `LinkedIn job ${n}`,
    url: liUrl(file),
    ats: "linkedin",
    source: "linkedin",
  }).id;
  db.close();
  return id;
}

describe("LinkedIn helpers", () => {
  it("recognises LinkedIn job links only", () => {
    expect(linkedInJobUrl("https://www.linkedin.com/jobs/view/3912345678/?trk=x")).toBe(
      "https://www.linkedin.com/jobs/view/3912345678/",
    );
    expect(linkedInJobUrl("https://www.linkedin.com/jobs/search/?currentJobId=3912345678")).toBe(
      "https://www.linkedin.com/jobs/view/3912345678/",
    );
    expect(linkedInJobUrl("https://evil.example/linkedin.com/jobs/view/3912345678")).toBeUndefined();
    expect(linkedInJobUrl("https://jobs.lever.co/globex/1")).toBeUndefined();
  });

  it("spots warnings, limits and checks", () => {
    for (const t of [
      "We noticed some unusual activity",
      "Let's do a quick security check",
      "You've reached the Easy Apply limit for today",
      "Your account has been temporarily restricted",
      "Please verify you are a human",
    ])
      expect(looksLikeLinkedInWarning(t), t).toBe(true);
    expect(looksLikeLinkedInWarning("About the job: build React apps")).toBe(false);
  });

  it("pauses are random inside their range, and typing chunks rebuild the text", () => {
    for (const r of [0, 0.5, 0.999]) {
      const ms = humanDelayMs("action", () => r);
      expect(ms).toBeGreaterThanOrEqual(2000);
      expect(ms).toBeLessThanOrEqual(6000);
    }
    const long = "I like building products end to end. ".repeat(12).trim();
    const chunks = typingChunks(long);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(4);
    expect(chunks.join("")).toBe(long);
    expect(typingChunks("Yes")).toEqual(["Yes"]);
  });

  it("turning on needs the risk accepted, stores the time, and turning off clears it", () => {
    const c = Config.parse({});
    expect(turnOnLinkedIn(c, { acceptRisk: false }).ok).toBe(false);
    expect(turnOnLinkedIn({ ...c, provider: "codex" }, { acceptRisk: true }).ok).toBe(false);
    expect(turnOnLinkedIn({ ...c, auth: "api-key" }, { acceptRisk: true }).ok).toBe(false);
    const r = turnOnLinkedIn(c, { acceptRisk: true, at: new Date("2026-10-28T10:00:00Z") });
    if (!r.ok) throw new Error(r.error);
    expect(r.config.sources.linkedin).toBe(true);
    expect(r.config.linkedin.acceptedAt).toBe("2026-10-28T10:00:00.000Z");
    expect(turnOffLinkedIn(r.config).linkedin.acceptedAt).toBeUndefined();
  });
});

describe("Claude in Chrome for LinkedIn", () => {
  const base = {
    prompt: "x",
    mcpServers: { desk: { command: "node", args: [] } },
    browser: "claude-in-chrome" as const,
    linkedin: true,
    cwd: "/tmp",
    timeoutMs: 1,
    logPath: "/tmp/l",
  };
  it("allows only look/click/type tools and denies scripts and network reads", () => {
    const tools = allowedTools(base);
    expect(tools).toContain("mcp__claude-in-chrome__computer");
    expect(tools).not.toContain("mcp__claude-in-chrome__*");
    expect(tools.join()).not.toMatch(/javascript_tool|read_network_requests/);
    const args = agentArgs(base, "/tmp/mcp.json");
    expect(args).toContain("--chrome");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("javascript_tool");
  });
});

describe("LinkedIn runs on fixture pages", () => {
  it("does not touch LinkedIn jobs while the mode is off", async () => {
    const p = makeHome();
    const id = queue(p, "easy-apply.html");
    await runOnce({ p, fetcher: fixtureFetcher, pace });
    const db = openDb(p);
    expect(getApplication(db, id)).toMatchObject({ status: "skipped" });
    expect(getApplication(db, id)?.reason).toMatch(/LinkedIn mode is off/);
  });

  it("fills Easy Apply at a human pace from answer memory and asks what it does not know", async () => {
    const p = on();
    const id = queue(p, "easy-apply.html");
    const slept: number[] = [];
    await runOnce({
      p,
      fetcher: fixtureFetcher,
      pace: { sleep: async (ms) => void slept.push(ms), random: Math.random },
    });
    const db = openDb(p);
    // Unknown required question (React years) goes to the queue, never guessed.
    expect(getApplication(db, id)?.status).toBe("needs_answers");
    expect(listQuestions(db).map((q) => q.question)).toEqual([
      "How many years of work experience do you have with React?",
    ]);
    expect(getApplication(db, id)).toMatchObject({ company: "Hooli", title: "Frontend Engineer" });
    expect(slept.length).toBeGreaterThan(5);
    expect(slept.every((ms) => ms >= 700 && ms <= 12000)).toBe(true);
    expect(new Set(slept).size).toBeGreaterThan(1);
  });

  it("ends in a dry run with every value citing memory once the question is answered", async () => {
    const p = on();
    const id = queue(p, "easy-apply.html");
    await runOnce({ p, fetcher: fixtureFetcher, pace });
    const db = openDb(p);
    const q = listQuestions(db)[0]!;
    db.prepare("UPDATE questions SET status='answered', answer='4' WHERE id=?").run(q.id);
    // Same as answering in the dashboard.
    const { answerQuestion } = await import("../src/memory/queue.js");
    db.prepare("UPDATE questions SET status='open', answer=NULL WHERE id=?").run(q.id);
    answerQuestion(db, q.id, { answer: "4" });
    db.close();
    await runOnce({ p, fetcher: fixtureFetcher, pace });
    const db2 = openDb(p);
    const app = getApplication(db2, id)!;
    expect(app.status).toBe("dry_run");
    const filled = (JSON.parse(app.evidence!) as { filled: { source: string }[] }).filled;
    expect(filled.length).toBeGreaterThan(4);
    expect(filled.every((f) => /^(mem:\d+|profile:[a-z_]+|resume)$/.test(f.source))).toBe(true);
  });

  it("follows 'Apply on company website' to the normal Lever flow in the same run", async () => {
    const p = on();
    const id = queue(p, "company-site.html");
    await runOnce({ p, fetcher: fixtureFetcher, pace });
    const db = openDb(p);
    const app = getApplication(db, id)!;
    expect(app.ats).toBe("lever");
    expect(app.url).toContain("jobs.lever.co/globex");
    expect(["dry_run", "needs_answers"]).toContain(app.status);
  });

  it("stops at once on a warning, hands the job to Finish yourself and holds the rest", async () => {
    const p = on();
    const first = queue(p, "warning.html", 1);
    const second = queue(p, "easy-apply.html", 2);
    const summary = await runOnce({ p, fetcher: fixtureFetcher, pace });
    const db = openDb(p);
    expect(getApplication(db, first)).toMatchObject({
      status: "blocked",
      blocked_category: "linkedin_warning",
    });
    expect(linkedInStop(db)?.applicationId).toBe(first);
    expect(getApplication(db, second)?.status).toBe("queued");
    expect(summary.message).toMatch(/LinkedIn mode stopped/);
    // A later run does nothing on LinkedIn until the stop is cleared.
    db.close();
    await runOnce({ p, fetcher: fixtureFetcher, pace });
    const db2 = openDb(p);
    expect(getApplication(db2, second)?.status).toBe("queued");
  });

  it("holds jobs once the small daily cap is used", async () => {
    const p = on({ linkedin: { acceptedAt: "2026-10-28T09:00:00.000Z", perDay: 1 } });
    const a = queue(p, "easy-apply.html", 1);
    const b = queue(p, "easy-apply.html?x=2", 2);
    await runOnce({ p, fetcher: fixtureFetcher, pace });
    const db = openDb(p);
    expect(getApplication(db, a)?.status).not.toBe("queued");
    expect(getApplication(db, b)?.status).toBe("queued");
    expect(linkedInStatus(db, loadConfig(p))).toMatchObject({ usedToday: 1, remainingToday: 0 });
  });

  it("the desk refuses Submit on LinkedIn until the job was read, and when stopped", () => {
    const p = on({ dryRun: false });
    const db = openDb(p);
    const id = addApplication(db, {
      company: "Hooli",
      title: "Frontend Engineer",
      url: "https://www.linkedin.com/jobs/view/3912345678/",
      ats: "linkedin",
    }).id;
    const config = loadConfig(p);
    const desk = new Desk(
      db,
      { ...config, dryRun: false, limits: { ...config.limits, reviewFirst: 0 } },
      JANE,
      p,
      id,
      pace,
    );
    const filled = [{ field: "Email", value: "jane.doe@example.com", source: "profile:email" }];
    expect(desk.startSubmit(filled)).toMatchObject({ proceed: false, mode: "linkedin" });
    expect(desk.jobDetails({ company: "Hooli", title: "Frontend Engineer" })).toMatchObject({ fit: true });
    desk.markBlocked({ category: "other", notes: "You've reached the Easy Apply limit" });
    expect(getApplication(db, id)?.blocked_category).toBe("linkedin_warning");
    setStatus(db, id, "in_progress");
    expect(desk.startSubmit(filled)).toMatchObject({ proceed: false, mode: "linkedin" });
  });
});

describe("LinkedIn settings API", () => {
  const HOST = { host: "127.0.0.1:4777", "x-quietapply": "1", "content-type": "application/json" };
  it("needs the risk accepted, stores the time, caps at 15, and resumes after a stop", async () => {
    const p = makeHome();
    const app = createApp({ p, port: 4777 });
    const put = (b: unknown) =>
      app.request("/api/linkedin", { method: "PUT", headers: HOST, body: JSON.stringify(b) });
    expect((await put({ enabled: true })).status).toBe(400);
    expect((await put({ perDay: 16 })).status).toBe(400);
    const ok = await put({ enabled: true, acceptRisk: true, perDay: 3 });
    expect(await ok.json()).toMatchObject({ enabled: true, perDay: 3 });
    expect(loadConfig(p).linkedin.acceptedAt).toBeTruthy();
    const db = openDb(p);
    const { stopLinkedIn } = await import("../src/linkedin/mode.js");
    stopLinkedIn(db, "unusual activity");
    db.close();
    expect(
      ((await (await app.request("/api/linkedin", { headers: HOST })).json()) as { stopped: unknown })
        .stopped,
    ).toBeTruthy();
    const r = await app.request("/api/linkedin/resume", { method: "POST", headers: HOST });
    expect(((await r.json()) as { stopped: unknown }).stopped).toBeNull();
    await put({ enabled: false });
    expect(loadConfig(p).sources.linkedin).toBe(false);
    saveConfig(loadConfig(p), p);
  });

  it("adds a LinkedIn job by link only when the mode is on", async () => {
    const p = makeHome();
    const app = createApp({ p, port: 4777 });
    const add = () =>
      app.request("/api/applications", {
        method: "POST",
        headers: HOST,
        body: JSON.stringify({ url: "https://www.linkedin.com/jobs/view/3912345678/" }),
      });
    expect((await add()).status).toBe(400);
    await app.request("/api/linkedin", {
      method: "PUT",
      headers: HOST,
      body: JSON.stringify({ enabled: true, acceptRisk: true }),
    });
    expect((await add()).status).toBe(200);
  });
});
