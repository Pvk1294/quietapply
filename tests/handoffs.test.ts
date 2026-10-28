import { describe, expect, it } from "vitest";
import { Config, loadConfig } from "../src/core/config.js";
import { openDb } from "../src/core/db.js";
import { getHandoff, listHandoffs, openHandoff, toReason, unsupportedSite } from "../src/core/handoffs.js";
import { addApplication, getApplication, listQuestions } from "../src/core/store.js";
import { Desk } from "../src/mcp/desk.js";
import { loadProfile } from "../src/memory/profile.js";
import { answerQuestion } from "../src/memory/queue.js";
import { runOnce } from "../src/runner/run.js";
import { createApp } from "../src/server/app.js";
import { fixtureFetcher, fixtureUrl } from "./helpers/fixtures.js";
import { makeHome } from "./helpers/home.js";

const PORT = 4777;
const HOST = { host: `127.0.0.1:${PORT}` };
const WRITE = { ...HOST, "x-quietapply": "1", "content-type": "application/json" };

function queue(p: ReturnType<typeof makeHome>) {
  const db = openDb(p);
  const ids = {
    gh: addApplication(db, {
      company: "Acme Rockets",
      title: "Software Engineer, Payments",
      url: fixtureUrl("greenhouse-acme-job.html"),
      ats: "greenhouse",
      location: "Remote - US",
    }).id,
    lv: addApplication(db, {
      company: "Globex Corporation",
      title: "Backend Developer",
      url: fixtureUrl("lever-globex-apply.html"),
      ats: "lever",
      location: "Springfield",
    }).id,
    cap: addApplication(db, {
      company: "Initrode",
      title: "Data Engineer",
      url: fixtureUrl("greenhouse-captcha.html"),
      ats: "greenhouse",
    }).id,
    wd: addApplication(db, {
      company: "Wonka",
      title: "Engineer",
      url: "https://wonka.wd1.myworkdayjobs.com/en-US/jobs/job/1",
    }).id,
  };
  db.close();
  return ids;
}

describe("handoff reasons", () => {
  it("maps the older blocked categories onto the reasons", () => {
    expect(toReason("account_required")).toBe("login_required");
    expect(toReason("otp")).toBe("login_required");
    expect(toReason("email_only")).toBe("external_redirect");
    expect(toReason("no_ai_policy")).toBe("fit_gate");
    expect(toReason("site_error")).toBe("form_error");
    expect(toReason("file_upload_form")).toBe("file_upload");
    expect(toReason("linkedin_limit")).toBe("linkedin_limit");
    expect(toReason("something new")).toBe("other");
  });
  it("spots job sites that are not automated", () => {
    expect(unsupportedSite("https://acme.wd5.myworkdayjobs.com/x")).toBe("acme.wd5.myworkdayjobs.com");
    expect(unsupportedSite("https://boards.greenhouse.io/acme/jobs/1")).toBeUndefined();
  });
});

describe("handoff records from a run on the fixtures", () => {
  it("records a clear reason for every job it could not apply to", async () => {
    const p = makeHome({
      rules: Config.parse({ rules: { excludeTitles: ["engineer"] } }).rules,
    });
    const ids = queue(p);
    // Only Globex ("Backend Developer") passes the title rule; the rest are skipped by it, except we want
    // the other reasons too, so run once with the rule and once without.
    await runOnce({ p, fetcher: fixtureFetcher });
    const db = openDb(p);
    const fit = openHandoff(db, ids.cap);
    expect(fit).toMatchObject({ reason: "fit_gate", rule: 'title contains excluded word "engineer"' });
    expect(fit?.detail).toContain("Skipped by your rules");
    expect(getApplication(db, ids.lv)?.status).toBe("dry_run");
    db.close();
  });

  it("captcha, unknown question and unsupported site each get a record", async () => {
    const p = makeHome();
    const ids = queue(p);
    await runOnce({ p, fetcher: fixtureFetcher });
    const db = openDb(p);

    const captcha = openHandoff(db, ids.cap)!;
    expect(captcha.reason).toBe("captcha");
    expect(captcha.state).toBe("open");

    const workday = openHandoff(db, ids.wd)!;
    expect(workday.reason).toBe("unsupported_ats");
    expect(workday.detail).toContain("myworkdayjobs.com");
    expect(getApplication(db, ids.wd)?.status).toBe("blocked");

    const q = openHandoff(db, ids.gh)!;
    expect(q.reason).toBe("unknown_question");
    expect(q.detail).toContain("salary");
    // It keeps no record for jobs that went fine.
    expect(openHandoff(db, ids.lv)).toBeUndefined();

    // Answering every question releases the job and closes the record.
    for (const x of listQuestions(db)) answerQuestion(db, x.id, { answer: "an answer" });
    expect(openHandoff(db, ids.gh)).toBeUndefined();
    expect(getHandoff(db, q.id)?.state).toBe("resolved");
    db.close();
  });
});

describe("desk tools write the reason in a structured form", () => {
  function desk() {
    const p = makeHome();
    const db = openDb(p);
    const id = addApplication(db, {
      company: "Acme Rockets",
      title: "Engineer",
      url: "https://example.com/j",
    }).id;
    return { db, id, desk: new Desk(db, loadConfig(p), loadProfile(p), p, id) };
  }

  it("mark_blocked keeps the reason, what is needed and the fields already filled", () => {
    const { db, id, desk: d } = desk();
    d.markBlocked({
      category: "account_required",
      notes: "The site wants a password.",
      needed: "Create the account, then apply.",
      filled: [{ field: "Email", value: "jane.doe@example.com" }],
    });
    expect(openHandoff(db, id)).toMatchObject({
      reason: "login_required",
      detail: "The site wants a password.",
      needed: "Create the account, then apply.",
      filled: [{ field: "Email", value: "jane.doe@example.com" }],
    });
    expect(getApplication(db, id)).toMatchObject({ status: "blocked", blocked_category: "login_required" });
  });

  it("report_outcome hands a job over even if the agent forgot mark_blocked, and never twice", () => {
    const { db, id, desk: d } = desk();
    d.reportOutcome({ outcome: "handed_over", reason: "file_upload", detail: "Special upload widget." });
    expect(openHandoff(db, id)).toMatchObject({ reason: "file_upload" });
    d.reportOutcome({ outcome: "handed_over", reason: "other", detail: "again" });
    expect(listHandoffs(db, "all").filter((h) => h.application_id === id && h.state === "open")).toHaveLength(
      1,
    );
    expect(openHandoff(db, id)?.reason).toBe("file_upload");
  });

  it("an unclear result and a cap are recorded with their reasons", () => {
    const { db, id, desk: d } = desk();
    d.recordResult({ outcome: "unclear", evidence: "The page just spun." });
    expect(openHandoff(db, id)).toMatchObject({ reason: "unclear_submit" });
  });
});

describe("Finish yourself API", () => {
  async function setup() {
    const p = makeHome();
    const ids = queue(p);
    await runOnce({ p, fetcher: fixtureFetcher });
    const app = createApp({ p, port: PORT });
    const get = async (path: string) => (await app.request(path, { headers: HOST })).json();
    const post = (path: string) => app.request(path, { method: "POST", headers: WRITE });
    return { p, ids, get, post };
  }
  type H = {
    id: number;
    reason: string;
    canRetry: boolean;
    retryBlocker: string | null;
    mine: { label: string; value: string }[];
    questions: string[];
    application: { id: number; url: string };
  };

  it("lists open records with the copyable values, and only offers Retry where it can help", async () => {
    const { ids, get } = await setup();
    const list = (await get("/api/handoffs")) as H[];
    const by = (id: number) => list.find((h) => h.application.id === id)!;
    expect(by(ids.cap).canRetry).toBe(false);
    expect(by(ids.wd).canRetry).toBe(false);
    expect(by(ids.gh).canRetry).toBe(false);
    expect(by(ids.gh).retryBlocker).toContain("Answer");
    expect(by(ids.gh).questions.length).toBeGreaterThan(0);
    expect(by(ids.cap).mine).toEqual(
      expect.arrayContaining([{ label: "email", value: "jane.doe@example.com" }]),
    );
    expect(by(ids.cap).application.url).toContain("greenhouse-captcha");
  });

  it("refuses Retry for a CAPTCHA, and allows it once the question is answered", async () => {
    const { p, ids, get, post } = await setup();
    const list = (await get("/api/handoffs")) as H[];
    const cap = list.find((h) => h.application.id === ids.cap)!;
    expect((await post(`/api/handoffs/${cap.id}/retry`)).status).toBe(400);
    expect(getApplication(openDb(p), ids.cap)?.status).toBe("blocked");

    // After answering, the question handoff is closed by itself; a form error can be retried by hand.
    const db = openDb(p);
    const d = new Desk(db, loadConfig(p), loadProfile(p), p, ids.lv);
    d.recordResult({ outcome: "failed", evidence: "The form reloaded with an error." });
    db.close();
    const fe = ((await get("/api/handoffs")) as H[]).find((h) => h.application.id === ids.lv)!;
    expect(fe).toMatchObject({ reason: "form_error", canRetry: true });
    expect((await post(`/api/handoffs/${fe.id}/retry`)).status).toBe(200);
    const db2 = openDb(p);
    expect(getApplication(db2, ids.lv)?.status).toBe("queued");
    expect(openHandoff(db2, ids.lv)).toBeUndefined();
    db2.close();
  });

  it("'I applied myself' and 'Not interested' close the record without counting as a submission", async () => {
    const { p, ids, get, post } = await setup();
    const list = (await get("/api/handoffs")) as H[];
    const cap = list.find((h) => h.application.id === ids.cap)!;
    const wd = list.find((h) => h.application.id === ids.wd)!;
    expect((await post(`/api/handoffs/${cap.id}/applied`)).status).toBe(200);
    expect((await post(`/api/handoffs/${wd.id}/not_interested`)).status).toBe(200);
    expect((await post(`/api/handoffs/${wd.id}/applied`)).status).toBe(409);
    const db = openDb(p);
    expect(getHandoff(db, cap.id)?.state).toBe("applied");
    expect(getHandoff(db, wd.id)?.state).toBe("not_interested");
    expect(getApplication(db, ids.cap)).toMatchObject({ status: "skipped", reason: "you applied yourself" });
    db.close();
    expect(((await get("/api/handoffs")) as H[]).map((h) => h.id)).not.toContain(cap.id);
  });

  it("Today gets one summary: done, couldn't do, how many need you", async () => {
    const { get } = await setup();
    const s = (await get("/api/summary")) as { today: { done: number; couldnt: number; needYou: number } };
    // Globex + Acme(needs answers is not done) → one dry run; captcha, workday, question = 3 handoffs, all need you.
    expect(s.today).toEqual({ done: 1, couldnt: 3, needYou: 3 });
  });

  it("a rule that hit can be retried once the rule is changed", async () => {
    const p = makeHome({ rules: Config.parse({ rules: { neverApply: ["Globex Corporation"] } }).rules });
    const ids = queue(p);
    await runOnce({ p, fetcher: fixtureFetcher });
    const app = createApp({ p, port: PORT });
    const h = ((await (await app.request("/api/handoffs", { headers: HOST })).json()) as H[]).find(
      (x) => x.application.id === ids.lv,
    )!;
    expect(h).toMatchObject({ reason: "fit_gate", canRetry: false });
    expect(h.retryBlocker).toContain("never-apply");
    const r = await app.request("/api/settings", {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ rules: { neverApply: [] } }),
    });
    expect(r.status).toBe(200);
    const again = ((await (await app.request("/api/handoffs", { headers: HOST })).json()) as H[]).find(
      (x) => x.application.id === ids.lv,
    )!;
    expect(again.canRetry).toBe(true);
  });
});
