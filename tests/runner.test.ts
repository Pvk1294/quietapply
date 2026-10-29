import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Config } from "../src/core/config.js";
import { openDb } from "../src/core/db.js";
import { evidenceHash } from "../src/core/safety.js";
import {
  addApplication,
  approveReview,
  getApplication,
  listQuestions,
  listRuns,
  setStatus,
} from "../src/core/store.js";
import { Desk } from "../src/mcp/desk.js";
import { answerQuestion } from "../src/memory/queue.js";
import { discover } from "../src/runner/discover.js";
import { buildPrompt } from "../src/runner/prompt.js";
import { runOnce, settle } from "../src/runner/run.js";
import { fixtureFetcher, fixtureUrl } from "./helpers/fixtures.js";
import { JANE, makeHome } from "./helpers/home.js";

function queueFixtures(p: ReturnType<typeof makeHome>) {
  const db = openDb(p);
  const gh = addApplication(db, {
    company: "Acme Rockets",
    title: "Software Engineer, Payments",
    url: fixtureUrl("greenhouse-acme-job.html"),
    ats: "greenhouse",
    location: "Remote - US",
  }).id;
  const lv = addApplication(db, {
    company: "Globex Corporation",
    title: "Backend Developer",
    url: fixtureUrl("lever-globex-apply.html"),
    ats: "lever",
    location: "Springfield",
  }).id;
  const ab = addApplication(db, {
    company: "Umbrella Labs",
    title: "Full-Stack Engineer",
    url: fixtureUrl("ashby-umbrella-application.html"),
    ats: "ashby",
    location: "Remote",
  }).id;
  const cap = addApplication(db, {
    company: "Initrode",
    title: "Data Engineer",
    url: fixtureUrl("greenhouse-captcha.html"),
    ats: "greenhouse",
  }).id;
  db.close();
  return { gh, lv, ab, cap };
}

describe("run loop (dry run on fixture pages)", () => {
  it("fills what it knows, asks what it does not, hands CAPTCHAs back, and never submits", async () => {
    const p = makeHome();
    const ids = queueFixtures(p);
    const summary = await runOnce({ p, fetcher: fixtureFetcher });
    expect(summary.status).toBe("completed");

    const db = openDb(p);
    expect(getApplication(db, ids.lv)?.status).toBe("dry_run");
    expect(getApplication(db, ids.ab)?.status).toBe("dry_run");
    expect(getApplication(db, ids.gh)?.status).toBe("needs_answers");
    expect(getApplication(db, ids.cap)).toMatchObject({ status: "blocked", blocked_category: "captcha" });

    // Every filled value cites a memory id.
    const evidence = JSON.parse(getApplication(db, ids.ab)!.evidence!) as {
      filled: { field: string; value: string; source: string }[];
    };
    const byField = Object.fromEntries(evidence.filled.map((f) => [f.field, f]));
    expect(byField["Where are you currently located?"]).toMatchObject({
      value: "Springfield, Oregon",
      source: "profile:location",
    });
    expect(byField["Do you require visa sponsorship?"]).toMatchObject({ value: "No" });
    expect(byField["When can you start?"]?.value).toBe("30 days");
    expect(byField.Resume).toMatchObject({ source: "resume" });
    expect(evidence.filled.every((f) => /^(mem:\d+|profile:[a-z_]+|resume)$/.test(f.source))).toBe(true);

    const questions = listQuestions(db).map((q) => q.question);
    expect(questions).toEqual(
      expect.arrayContaining([
        "What are your salary expectations?",
        "Which Acme rocket have you flown, and what would you change about it?",
      ]),
    );
    expect(listRuns(db)[0]).toMatchObject({ status: "completed", dry_run: 1 });

    // Answer the questions in the dashboard → the application is queued again and goes through next run.
    for (const q of listQuestions(db))
      answerQuestion(db, q.id, {
        answer: q.question.includes("salary") ? "USD 120,000" : "The Roadrunner Mk II; I would add a brake.",
      });
    expect(getApplication(db, ids.gh)?.status).toBe("queued");
    db.close();

    const second = await runOnce({ p, fetcher: fixtureFetcher });
    expect(second.processed).toHaveLength(1);
    const db2 = openDb(p);
    expect(getApplication(db2, ids.gh)?.status).toBe("dry_run");
    db2.close();
  });

  it("does nothing while paused, and refuses to run twice at once", async () => {
    const p = makeHome();
    queueFixtures(p);
    writeFileSync(p.pauseFlag, "");
    expect((await runOnce({ p, fetcher: fixtureFetcher })).status).toBe("paused");
  });

  it("skips jobs that fail the fit gate, with the reason", async () => {
    const p = makeHome({ rules: Config.parse({ rules: { neverApply: ["Globex Corporation"] } }).rules });
    const ids = queueFixtures(p);
    await runOnce({ p, fetcher: fixtureFetcher });
    const db = openDb(p);
    expect(getApplication(db, ids.lv)).toMatchObject({
      status: "skipped",
      reason: "company is on your never-apply list",
    });
  });

  it("marks a run that died after Submit was approved as unclear, never retried", () => {
    const p = makeHome();
    const db = openDb(p);
    const id = addApplication(db, { company: "Acme", title: "Engineer", url: "https://example.com/x" }).id;
    setStatus(db, id, "submitting");
    expect(settle(db, id, { status: "timed_out", text: "", exitCode: null }).status).toBe("unclear");
    const other = addApplication(db, {
      company: "Acme",
      title: "Engineer 2",
      url: "https://example.com/y",
    }).id;
    setStatus(db, other, "in_progress");
    expect(settle(db, other, { status: "usage_limit", text: "limit", exitCode: 1 }).status).toBe("queued");
  });
});

describe("desk safety", () => {
  it("dry run, review mode and live mode decide differently at Submit", () => {
    const p = makeHome({ dryRun: false });
    const db = openDb(p);
    const config = Config.parse({ dryRun: false, limits: { reviewFirst: 1, perDay: 5, perCompany30d: 2 } });
    const id = addApplication(db, { company: "Acme", title: "Engineer", url: "https://example.com/1" }).id;
    const desk = new Desk(db, config, JANE, p, id);
    const filled = [{ field: "Email", value: "jane.doe@example.com", source: "profile:email" }];

    expect(desk.startSubmit(filled)).toMatchObject({ proceed: false, mode: "review" });
    expect(getApplication(db, id)?.status).toBe("awaiting_review");

    approveReview(db, id, evidenceHash(getApplication(db, id)!.evidence)!);
    // A real submit needs the page address, so the desk can check the site.
    expect(desk.startSubmit(filled)).toMatchObject({ proceed: false, mode: "invalid" });
    expect(desk.startSubmit(filled, "https://example.com/1")).toMatchObject({ proceed: true });
    expect(getApplication(db, id)?.status).toBe("submitting");
    desk.recordResult({ outcome: "submitted", evidence: "Thank you for applying" });
    expect(getApplication(db, id)?.status).toBe("submitted");
    // What was typed is kept after Submit, with the confirmation added.
    const kept = JSON.parse(getApplication(db, id)!.evidence!);
    expect(kept.result).toBe("Thank you for applying");
    expect(kept.filled.length).toBe(filled.length);

    const dry = new Desk(db, { ...config, dryRun: true }, JANE, p, id);
    expect(dry.startSubmit(filled)).toMatchObject({ proceed: false, mode: "dry_run" });
  });

  it("refuses values that cite no memory id (invented answers)", () => {
    const p = makeHome();
    const db = openDb(p);
    const id = addApplication(db, { company: "Acme", title: "Engineer", url: "https://example.com/1" }).id;
    const desk = new Desk(db, Config.parse({}), JANE, p, id);
    const r = desk.startSubmit([
      { field: "Salary", value: "a lot", source: "my guess" },
      { field: "Notice", value: "30 days", source: "mem:99999" },
    ]);
    expect(r).toMatchObject({ proceed: false, mode: "invalid" });
    if (!r.proceed) expect(r.problems).toHaveLength(2);
  });

  it("cannot record a submission that start_submit did not approve", () => {
    const p = makeHome();
    const db = openDb(p);
    const id = addApplication(db, { company: "Acme", title: "Engineer", url: "https://example.com/1" }).id;
    const desk = new Desk(db, Config.parse({}), JANE, p, id);
    expect(() => desk.recordResult({ outcome: "submitted", evidence: "ok" })).toThrow();
  });

  it("strips personal data from site notes", () => {
    const p = makeHome();
    const db = openDb(p);
    const id = addApplication(db, { company: "Acme", title: "Engineer", url: "https://example.com/1" }).id;
    new Desk(db, Config.parse({}), JANE, p, id).addSiteNote({
      host: "jobs.example.com",
      note: "Upload field is a dropzone; jane.doe@example.com +1 555 010 0199",
    });
    const note = readFileSync(`${p.siteNotes}/jobs.example.com.md`, "utf8");
    expect(note).toContain("[email]");
    expect(note).toContain("[number]");
    expect(note).not.toContain("jane.doe");
  });
});

describe("discovery and prompt", () => {
  it("queues only fitting jobs from the public APIs", async () => {
    const p = makeHome();
    const db = openDb(p);
    const config = Config.parse({
      companies: [
        { name: "Acme Rockets", ats: "greenhouse", token: "acmerockets" },
        { name: "Globex Corporation", ats: "lever", token: "globex" },
        { name: "Umbrella Labs", ats: "ashby", token: "umbrella" },
        { name: "Broken Co", ats: "lever", token: "doesnotexist" },
      ],
      rules: {
        roles: ["engineer", "developer"],
        excludeTitles: ["intern", "principal"],
        locations: ["remote", "Springfield"],
      },
    });
    const s = await discover(db, config, JANE, fixtureFetcher);
    expect(s.found).toBe(7);
    expect(s.added).toBe(3); // Payments engineer, Backend developer, Full-stack engineer
    expect(s.errors).toHaveLength(1);
    expect(Object.keys(s.skipped).join(" ")).toMatch(/AI tools/);
    expect((await discover(db, config, JANE, fixtureFetcher)).alreadyKnown).toBe(3);
  });

  it("builds a prompt with only the answers this form needs", () => {
    const p = makeHome();
    const db = openDb(p);
    const id = addApplication(db, {
      company: "Globex Corporation",
      title: "Backend Developer",
      url: "https://jobs.lever.co/globex/x",
      ats: "lever",
    }).id;
    const app = getApplication(db, id)!;
    const prompt = buildPrompt({
      db,
      p,
      app,
      profile: JANE,
      mode: "dry_run",
      form: {
        fields: [{ label: "Email", name: "email", type: "text", required: true }],
        captcha: false,
        accountRequired: false,
      },
    });
    expect(prompt).toContain("Never invent anything");
    expect(prompt).toContain("# Lever");
    expect(prompt).toContain('"memoryId": "profile:email"');
    expect(prompt).toContain("30 days"); // core answer
    expect(prompt).not.toContain("Veteran"); // not asked by this form
    expect(prompt).toContain("do NOT click Submit");
    expect(prompt).toContain("click the field's upload button first"); // Codex dry run hit this
    expect(prompt.length).toBeLessThan(12_000);
  });
});
