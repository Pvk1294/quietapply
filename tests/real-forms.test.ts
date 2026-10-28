import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { openDb, openMemoryDb } from "../src/core/db.js";
import { addApplication, askQuestion, getApplication } from "../src/core/store.js";
import { parseForm } from "../src/forms/parse.js";
import { Desk } from "../src/mcp/desk.js";
import { lookupAnswer, saveAnswer } from "../src/memory/answers.js";
import { buildPrompt, MAX_PROMPT_OPTIONS } from "../src/runner/prompt.js";
import { dryRunGuardPath, mcpServers } from "../src/runner/run.js";
import { formUrl } from "../src/sources/greenhouse.js";
import { fixture } from "./helpers/fixtures.js";
import { JANE, makeHome } from "./helpers/home.js";

// Saved copies of three live forms from the night-2 dogfood run (Oct 2026): markup only, scripts, keys and
// descriptions removed, company names replaced (Hooli = a Greenhouse board, Vandelay = Lever, Pendant = Ashby).
const byLabel = (html: string) => {
  const form = parseForm(fixture(html));
  return { form, f: (start: string) => form.fields.find((x) => x.label.startsWith(start)) };
};

describe("real Greenhouse form (job-boards.greenhouse.io, React)", () => {
  const { form, f } = byLabel("greenhouse-hooli-real-form.html");

  it("names the upload fields after their question, not the Attach button", () => {
    expect(f("Resume/CV")).toMatchObject({ type: "file", required: true, name: "resume" });
    expect(f("Cover Letter")).toMatchObject({ type: "file", required: false });
    expect(form.fields.some((x) => x.label === "Attach")).toBe(false);
  });

  it("reads custom dropdowns as selects, with their required flag", () => {
    expect(f("Will you now or in the future require sponsorship")).toMatchObject({
      type: "select",
      required: true,
    });
    expect(f("Gender")).toMatchObject({ type: "select", required: false });
    expect(f("Country")).toMatchObject({ type: "select" });
  });

  it("finds every question and no CAPTCHA", () => {
    expect(form.fields).toHaveLength(19);
    expect(form.captcha).toBe(false);
  });
});

describe("real Lever form (jobs.lever.co/.../apply)", () => {
  const { form, f } = byLabel("lever-vandelay-real-form.html");

  it("finds the hidden resume input and the location field", () => {
    expect(f("Resume/CV")).toMatchObject({ type: "file", required: true, name: "resume" });
    expect(f("Current location")).toMatchObject({ type: "text", required: true, name: "location" });
  });

  it("does not take Lever's invisible submit-time hCaptcha for a visible challenge", () => {
    expect(fixture("lever-vandelay-real-form.html")).toContain('id="h-captcha"');
    expect(form.captcha).toBe(false);
  });

  it("reads a single consent checkbox once, ignoring its hidden twin", () => {
    const consent = f("Vandelay Industries has my consent");
    expect(consent).toMatchObject({ type: "checkbox", required: false });
    expect(consent?.options).toHaveLength(1);
  });

  it("reads radios, multi-checkboxes and long selects", () => {
    expect(f("Are you legally authorized")).toMatchObject({ type: "radio", options: ["Yes", "No"] });
    expect(f("Language Skill(s)")).toMatchObject({ type: "multiselect", required: true });
    expect(f("Which university")?.options?.length).toBe(39); // 40 kept in the fixture, minus the empty placeholder
  });
});

describe("real Ashby form (rendered jobs.ashbyhq.com/.../application)", () => {
  const { form, f } = byLabel("ashby-pendant-real-form.html");

  it("reads Yes/No button pairs as a required radio", () => {
    expect(f("Are you based in a EU or equivalent timezone?")).toMatchObject({
      type: "radio",
      required: true,
      options: ["Yes", "No"],
    });
  });

  it("reads system fields and custom questions", () => {
    expect(f("Resume")).toMatchObject({ type: "file", required: true, name: "_systemfield_resume" });
    expect(f("Cover letter")).toMatchObject({ type: "textarea", required: true });
    expect(f("X")).toMatchObject({ required: false });
    expect(form.fields).toHaveLength(14);
  });
});

describe("answer lookup on the real wordings", () => {
  const db = openMemoryDb();
  saveAnswer(db, {
    key: "referral",
    question: "How did you hear about this job?",
    answer: "Company careers page",
  });
  saveAnswer(db, { key: "country", question: "Which country do you live in?", answer: "United States" });
  const profile = { ...JANE, education: [{ school: "Springfield State University" }] };
  const look = (q: string) => lookupAnswer(db, profile, q);

  it("never answers a yes/no question with a profile value it mentions", () => {
    const r = look(
      "Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?",
    );
    expect(r.status).toBe("unknown");
  });

  it("finds the referral default for 'how you heard about this opportunity'", () => {
    expect(look("Please tell us how you heard about this opportunity.")).toMatchObject({
      status: "known",
      answer: "Company careers page",
    });
  });

  it("answers country of residence, school, years and preferred name", () => {
    expect(look("What is your current country of residence?")).toMatchObject({ answer: "United States" });
    expect(look("What country are you based in?")).toMatchObject({ answer: "United States" });
    expect(look("Which university are you currently attending or did you last attend?")).toMatchObject({
      memoryId: "profile:school",
      answer: "Springfield State University",
    });
    expect(look("How many years of relevant, post college work experience do you have?")).toMatchObject({
      memoryId: "profile:total_years",
      answer: "5",
    });
    expect(look("How many years of experience do you have with Ruby?").status).not.toBe("known");
    expect(look("What's the name you'd prefer us to use throughout the interview process?")).toMatchObject({
      memoryId: "profile:first_name",
      answer: "Jane",
    });
  });
});

describe("prompt size on a real form", () => {
  it("cuts long dropdowns short so the prompt stays small", () => {
    const p = makeHome();
    const db = openDb(p);
    const id = addApplication(db, {
      company: "Vandelay Industries",
      title: "Backend Engineer",
      url: "https://jobs.lever.co/vandelay/1",
      ats: "lever",
    }).id;
    const form = parseForm(fixture("lever-vandelay-real-form.html"));
    // The live form listed 3,301 universities; simulate it.
    const uni = form.fields.find((x) => x.label.startsWith("Which university"))!;
    uni.options = Array.from({ length: 3301 }, (_, i) => `University number ${i}`);
    const prompt = buildPrompt({
      db,
      p,
      app: getApplication(db, id)!,
      profile: JANE,
      mode: "dry_run",
      form,
    });
    expect(prompt.length).toBeLessThan(20_000);
    expect(prompt).toContain("3276 more on the page");
    expect(prompt).not.toContain(`University number ${MAX_PROMPT_OPTIONS}"`);
    db.close();
  });
});

describe("Greenhouse boards on a company's own careers site", () => {
  it("uses the embeddable Greenhouse form instead of the company page", () => {
    expect(
      formUrl("stripe", { id: 6176758, absolute_url: "https://stripe.com/jobs/search?gh_jid=6176758" }),
    ).toBe("https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=6176758");
    const own = "https://job-boards.greenhouse.io/hooli/jobs/123";
    expect(formUrl("hooli", { id: 123, absolute_url: own })).toBe(own);
  });
});

describe("dry-run network guard", () => {
  const guard = createRequire(import.meta.url)(dryRunGuardPath()) as {
    shouldBlock: (method: string, url: string, body?: string) => boolean;
  };

  it("lets reads through and blocks every write", () => {
    expect(guard.shouldBlock("GET", "https://jobs.lever.co/x/1/apply")).toBe(false);
    expect(guard.shouldBlock("POST", "https://jobs.lever.co/x/1/apply", "name=Jane")).toBe(true);
    expect(guard.shouldBlock("POST", "https://grnhse-prod.s3.amazonaws.com/")).toBe(true);
    expect(guard.shouldBlock("PUT", "https://example.com/upload")).toBe(true);
  });

  it("allows Ashby's read-only GraphQL queries but not its autosave, upload or submit", () => {
    const gql = "https://jobs.ashbyhq.com/api/non-user-graphql";
    const query = JSON.stringify({ operationName: "ApiJobPosting", query: "query ApiJobPosting { x }" });
    const mutation = JSON.stringify({
      operationName: "ApiSetFormValue",
      query: "mutation ApiSetFormValue { x }",
    });
    expect(guard.shouldBlock("POST", `${gql}?op=ApiJobPosting`, query)).toBe(false);
    expect(guard.shouldBlock("POST", `${gql}?op=ApiSetFormValue`, mutation)).toBe(true);
    expect(guard.shouldBlock("POST", `${gql}?op=ApiCreateFileUploadHandle`, query)).toBe(true);
    expect(guard.shouldBlock("POST", `${gql}?op=ApiSubmitSingleApplicationFormAction`, query)).toBe(true);
    expect(
      guard.shouldBlock(
        "POST",
        `${gql}?op=ApiJobPosting`,
        mutation.replace("ApiSetFormValue", "ApiJobPosting"),
      ),
    ).toBe(true);
  });

  it("is loaded into Playwright in dry run only, and logs to the application's folder", () => {
    const p = makeHome({ provider: "claude-code" });
    const config = loadConfig(p);
    const dry = mcpServers(config, p, 1, true, "/tmp/run-1/app-1").playwright!;
    expect(dry.args).toEqual(
      expect.arrayContaining(["--init-page", dryRunGuardPath(), "--block-service-workers"]),
    );
    expect(dry.args).toEqual(expect.arrayContaining(["--output-dir", "/tmp/run-1/app-1"]));
    expect(dry.env?.QUIETAPPLY_GUARD_LOG).toBe("/tmp/run-1/app-1/blocked-requests.jsonl");
    const live = mcpServers(config, p, 1, false, "/tmp/run-1/app-1").playwright!;
    expect(live.args).not.toContain("--init-page");
  });
});

describe("progress when questions are open", () => {
  it("records what was filled so far, without submitting", () => {
    const p = makeHome({ provider: "claude-code", dryRun: false });
    const db = openDb(p);
    const id = addApplication(db, {
      company: "Hooli",
      title: "Backend Engineer",
      url: "https://x",
      ats: "greenhouse",
    }).id;
    const desk = new Desk(db, loadConfig(p), JANE, p, id);
    askQuestion(db, { applicationId: id, question: "Have you previously worked at Hooli?" });
    const r = desk.startSubmit([{ field: "Email", value: "jane.doe@example.com", source: "profile:email" }]);
    expect(r).toMatchObject({ proceed: false, mode: "questions" });
    const app = getApplication(db, id)!;
    expect(app.status).not.toBe("submitting");
    expect(JSON.parse(app.evidence!)).toMatchObject({ partial: true, filled: [{ field: "Email" }] });
    db.close();
  });
});
