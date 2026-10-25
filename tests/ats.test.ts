import { describe, expect, it } from "vitest";
import { parseForm } from "../src/forms/parse.js";
import { listAshby } from "../src/sources/ashby.js";
import { greenhouseQuestions, listGreenhouse } from "../src/sources/greenhouse.js";
import { listLever } from "../src/sources/lever.js";
import { fixture, fixtureFetcher } from "./helpers/fixtures.js";

describe("Greenhouse", () => {
  it("lists jobs from the public board API", async () => {
    const jobs = await listGreenhouse(fixtureFetcher, "acmerockets");
    expect(jobs).toHaveLength(4);
    expect(jobs[0]).toMatchObject({
      ats: "greenhouse",
      company: "Acme Rockets",
      title: "Software Engineer, Payments",
      location: "Remote - US",
      remote: true,
    });
    expect(jobs[0]!.description).toContain("3+ years of professional experience");
    expect(jobs[0]!.description).not.toContain("<li>");
  });

  it("reads the exact application questions, including EEO", async () => {
    const qs = await greenhouseQuestions(fixtureFetcher, "acmerockets", "5000001");
    expect(qs.map((q) => q.label)).toContain(
      "Will you now or in the future require sponsorship for employment visa status?",
    );
    expect(qs.find((q) => q.name === "resume")).toMatchObject({ type: "file", required: true });
    expect(qs.find((q) => q.label === "Gender")).toMatchObject({ type: "select", required: false });
  });

  it("parses the form on the job page", () => {
    const form = parseForm(fixture("greenhouse-acme-job.html"));
    expect(form.captcha).toBe(false);
    const byName = Object.fromEntries(form.fields.map((f) => [f.name, f]));
    expect(byName.first_name).toEqual({
      label: "First Name",
      name: "first_name",
      type: "text",
      required: true,
    });
    expect(byName.phone).toMatchObject({ label: "Phone", required: false });
    expect(byName.question_1003).toMatchObject({ type: "select", options: ["Yes", "No"], required: true });
    expect(byName.question_1005).toMatchObject({ type: "textarea", required: true });
    expect(byName.veteran_status?.options).toHaveLength(3);
    expect(form.fields).toHaveLength(13);
  });

  it("spots a visible CAPTCHA", () => {
    expect(parseForm(fixture("greenhouse-captcha.html")).captcha).toBe(true);
  });
});

describe("Lever", () => {
  it("lists jobs from the public postings API", async () => {
    const jobs = await listLever(fixtureFetcher, "globex", "Globex Corporation");
    expect(jobs.map((j) => j.title)).toEqual(["Backend Developer", "Engineering Intern"]);
    expect(jobs[0]!.description).toContain("2+ years of experience with Node.js");
  });

  it("parses the application page", () => {
    const form = parseForm(fixture("lever-globex-apply.html"));
    const byName = Object.fromEntries(form.fields.map((f) => [f.name, f]));
    expect(byName.name).toMatchObject({ label: "Full name", required: true });
    expect(byName["urls[LinkedIn]"]).toMatchObject({ label: "LinkedIn URL", required: false });
    expect(byName["cards[c1a][field0]"]).toMatchObject({
      label: "What is your notice period?",
      required: true,
    });
    expect(byName["cards[c1a][field1]"]).toMatchObject({
      label: "Are you willing to relocate to Springfield?",
      type: "radio",
      options: ["Yes", "No"],
      required: true,
    });
    expect(byName.comments).toMatchObject({
      type: "textarea",
      label: "Add a cover letter or anything else you want to share.",
    });
  });
});

describe("Ashby", () => {
  it("lists listed jobs from the public posting API", async () => {
    const jobs = await listAshby(fixtureFetcher, "umbrella", "Umbrella Labs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: "Full-Stack Engineer", remote: true });
  });

  it("parses a rendered application page", () => {
    const form = parseForm(fixture("ashby-umbrella-application.html"));
    const byName = Object.fromEntries(form.fields.map((f) => [f.name, f]));
    expect(byName._systemfield_name).toMatchObject({ label: "Name", required: true });
    expect(byName.q_sponsorship).toMatchObject({
      label: "Do you require visa sponsorship?",
      type: "radio",
      required: true,
    });
    expect(byName.q_start).toMatchObject({ label: "When can you start?", required: true });
    expect(byName.q_agree).toMatchObject({ type: "checkbox", required: true });
    expect(byName.q_agree!.label).toContain("I agree to Umbrella Labs storing");
  });
});
