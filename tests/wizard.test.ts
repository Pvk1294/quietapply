import { describe, expect, it } from "vitest";
import { loadState } from "../src/cli/wizard/context.js";
import { runWizard } from "../src/cli/wizard/index.js";
import { defaultsPrompter, SetupCancelled } from "../src/cli/wizard/prompter.js";
import { aiStep, INSTALL_HELP } from "../src/cli/wizard/steps/ai.js";
import { answersStep } from "../src/cli/wizard/steps/answers.js";
import { loginsStep } from "../src/cli/wizard/steps/logins.js";
import { resumeStep } from "../src/cli/wizard/steps/resume.js";
import { safetyStep } from "../src/cli/wizard/steps/safety.js";
import { RECOMMENDED, sourcesStep } from "../src/cli/wizard/steps/sources.js";
import { levelsForYears, targetsStep } from "../src/cli/wizard/steps/targets.js";
import { loadConfig } from "../src/core/config.js";
import { listAnswers, lookupAnswer } from "../src/memory/answers.js";
import { loadProfile } from "../src/memory/profile.js";
import { makeCtx, RESUME, scripted, stubProvider } from "./helpers/wizard.js";

describe("wizard step 1: AI", () => {
  it("shows the official install commands, then picks up Claude Code once it is installed", async () => {
    const ui = scripted([["Neither Claude Code nor Codex", "again"]]);
    const ctx = makeCtx(ui, {
      providers: {
        "claude-code": stubProvider("claude-code", [
          { installed: false },
          { installed: true, version: "2.0.0", loggedIn: true, authMethod: "subscription" },
        ]),
        codex: stubProvider("codex", [{ installed: false }]),
      },
    });
    await aiStep.run(ctx);
    expect(ui.shown.join("\n")).toContain(INSTALL_HELP);
    expect(ctx.config).toMatchObject({ provider: "claude-code", auth: "subscription" });
  });

  it("explains how to sign in and checks again", async () => {
    const ui = scripted([
      ["Which AI", "codex"],
      ["Sign in, then come back", "again"],
    ]);
    const ctx = makeCtx(ui, {
      providers: {
        "claude-code": stubProvider("claude-code", [{ installed: false }]),
        codex: stubProvider("codex", [
          { installed: true, version: "0.50.0", loggedIn: false },
          { installed: true, version: "0.50.0", loggedIn: false },
          { installed: true, version: "0.50.0", loggedIn: true, authMethod: "api-key" },
        ]),
      },
    });
    await aiStep.run(ctx);
    expect(ui.shown.join("\n")).toContain("codex login");
    expect(ctx.config).toMatchObject({ provider: "codex", auth: "api-key", browser: "playwright-profile" });
    expect(ui.shown.join("\n")).toContain("billed to that key");
  });

  it("lets you go on without an AI (demo agent)", async () => {
    const ui = scripted([["Neither Claude Code nor Codex", "demo"]]);
    const ctx = makeCtx(ui, {
      providers: {
        "claude-code": stubProvider("claude-code", [{ installed: false }]),
        codex: stubProvider("codex", [{ installed: false }]),
      },
    });
    await aiStep.run(ctx);
    expect(ctx.config.provider).toBe("fake");
  });
});

describe("wizard step 2: resume and profile", () => {
  it("reads the resume, pre-fills every field and saves the person's fixes", async () => {
    const ui = scripted([
      ["Path to your resume", RESUME],
      ["Phone", "+1 555 010 0100"],
      ["City", "Springfield"],
      ["Country you live in", "United States"],
      ["Is your work history right?", "add"],
      ["Job title", "Intern"],
      ["Company", "Vandelay Industries"],
      ["Start", "Jun 2019"],
      ["End", "Aug 2019"],
      ["Skills", "TypeScript, Python, Go"],
      ["Total years", "5"],
    ]);
    const ctx = makeCtx(ui);
    await resumeStep.run(ctx);
    const p = loadProfile(ctx.dirs);
    expect(p).toMatchObject({
      name: "Jane Doe",
      email: "jane.doe@example.com",
      phone: "+1 555 010 0100",
      city: "Springfield",
      country: "United States",
      location: "Springfield, United States",
      totalYears: 5,
      resumeFile: "resume.txt",
    });
    expect(p.links.github).toBe("https://github.com/janedoe-example");
    expect(p.experience.map((e) => e.company)).toEqual([
      "Initech",
      "Globex Corporation",
      "Vandelay Industries",
    ]);
    expect(p.skills.map((s) => s.name)).toEqual(["TypeScript", "Python", "Go"]);
    expect(p.education[0]?.school).toContain("Springfield State University");
    expect(ui.unused()).toEqual([]);
  });

  it("rejects an email that is not one", async () => {
    const ui = scripted([
      ["Path to your resume", RESUME],
      ["Email", "not-an-email"],
    ]);
    await expect(resumeStep.run(makeCtx(ui))).rejects.toThrow(/doesn't look like an email/);
  });
});

describe("wizard step 3: standard answers", () => {
  it("stores work authorisation and sponsorship per country, and salary with currency", async () => {
    const ui = scripted([
      ["Which countries", ["India", "United States"]],
      ["Can you work in India?", "citizen"],
      ["Can you work in United States?", "visa"],
      ["visa sponsorship to work in United States", true],
      ["Notice period", "60 days"],
      ["Currency", "INR"],
      ["Current yearly salary", "18,00,000"],
      ["Expected yearly salary", "25,00,000"],
      ["relocating", "Yes, within my country"],
      ["work arrangements", ["remote", "hybrid"]],
      ["travel", "Up to 25%"],
      ["Cover letters", "template"],
      ["base cover letter", "I build reliable web products and would like to do that for your team."],
    ]);
    const ctx = makeCtx(ui);
    await answersStep.run(ctx);
    const ask = (q: string) => lookupAnswer(ctx.db, ctx.profile, q);
    expect(ask("Are you legally authorized to work in India?")).toMatchObject({
      status: "known",
      answer: "Yes",
    });
    expect(ask("Are you legally authorized to work in the United States?")).toMatchObject({ answer: "Yes" });
    expect(ask("Will you now or in the future require sponsorship to work in the U.S.?")).toMatchObject({
      answer: "Yes",
    });
    expect(ask("Do you require visa sponsorship to work in India?")).toMatchObject({ answer: "No" });
    // Forms that name no country get the summary.
    expect(ask("Do you require visa sponsorship?")).toMatchObject({
      answer: "Yes for United States; no elsewhere",
    });
    expect(ask("What are your salary expectations?")).toMatchObject({ answer: "INR 25,00,000 per year" });
    expect(ask("Current CTC")).toMatchObject({ answer: "INR 18,00,000 per year", sensitive: true });
    expect(ask("What is your notice period?")).toMatchObject({ answer: "60 days" });
    expect(ask("Gender")).toMatchObject({ answer: "I prefer not to answer" });
    expect(ask("Cover letter")).toMatchObject({ status: "known" });
    expect(ctx.config.rules.countries).toEqual(["India", "United States"]);
    expect(ctx.config.rules.locations).toContain("remote");
    expect(ctx.config.coverLetterStyle).toBe("template");
    expect(ui.unused()).toEqual([]);
  });

  it("pre-fills from saved answers the second time", async () => {
    const first = scripted([
      ["Which countries", ["India"]],
      ["Notice period", "other"],
      ["notice period or earliest start date", "Available from 1 March 2027"],
    ]);
    const ctx = makeCtx(first);
    await answersStep.run(ctx);
    const again = scripted([]);
    await answersStep.run({ ...ctx, ui: again });
    expect(lookupAnswer(ctx.db, ctx.profile, "Earliest start date")).toMatchObject({
      answer: "Available from 1 March 2027",
    });
    expect(listAnswers(ctx.db).filter((a) => a.key === "notice_period")).toHaveLength(1);
  });

  it("never stores guessed answers when nobody is there to answer (--yes)", async () => {
    const ctx = makeCtx(defaultsPrompter());
    expect(await answersStep.run(ctx)).toBe("skipped");
    expect(listAnswers(ctx.db)).toEqual([]);
  });
});

describe("wizard step 4: targets", () => {
  it("suggests levels from experience and the current employer for never-apply", async () => {
    const ui = scripted([
      ["Job titles", "software engineer, backend developer"],
      ["Cities", "Bengaluru, Pune"],
      ["Minimum yearly salary", "2500000"],
      ["currency", "INR"],
      ["Industries", ["fintech", "devtools"]],
      ["Most applications per day", "8"],
    ]);
    const ctx = makeCtx(ui);
    ctx.profile.totalYears = 4;
    ctx.profile.experience = [
      { company: "Initech", title: "Software Engineer", end: "Present", highlights: [] },
    ];
    await targetsStep.run(ctx);
    expect(ctx.config.rules).toMatchObject({
      roles: ["software engineer", "backend developer"],
      seniority: ["mid", "senior"],
      locations: ["Bengaluru", "Pune", "remote"],
      neverApply: ["Initech"],
      minSalary: { amount: 2500000, currency: "INR" },
    });
    expect(ctx.config.preferences.industries).toEqual(["fintech", "devtools"]);
    expect(ctx.config.limits.perDay).toBe(8);
  });

  it("maps years of experience to levels", () => {
    expect(levelsForYears(0)).toEqual(["intern", "entry"]);
    expect(levelsForYears(12)).toContain("director");
    expect(levelsForYears(undefined)).toEqual([]);
  });
});

describe("wizard step 5: where to apply", () => {
  it("adds the best starter companies and companies from pasted careers URLs", async () => {
    const ui = scripted([
      ["companies from QuietApply's checked list", "best"],
      [
        "Paste careers-page URLs",
        "https://boards.greenhouse.io/acmerockets, https://globex.example/careers, https://nothing.example/careers",
      ],
      ["Paste careers-page URLs", ""],
    ]);
    const ctx = makeCtx(ui);
    ctx.config.rules.roles = ["software engineer"];
    ctx.config.rules.countries = ["India"];
    await sourcesStep.run(ctx);
    const names = ctx.config.companies.map((c) => c.name);
    expect(names).toContain("Acme Rockets");
    expect(ctx.config.companies).toContainEqual({ name: "Globex", ats: "lever", token: "globex" });
    expect(ctx.config.companies.length).toBe(RECOMMENDED + 2);
    expect(ctx.config.sources.linkedin).toBe(false);
    const log = ui.shown.join("\n");
    expect(log).toContain("User Agreement (section 8.2)");
    expect(log).toContain("no Greenhouse, Lever or Ashby job board found");
  });

  it("only suggests companies on the job sites that are switched on", async () => {
    const ui = scripted([
      ["Job sites", ["ashby"]],
      ["companies from QuietApply's checked list", "best"],
    ]);
    const ctx = makeCtx(ui);
    await sourcesStep.run(ctx);
    expect(ctx.config.companies.length).toBeGreaterThan(0);
    expect(new Set(ctx.config.companies.map((c) => c.ats))).toEqual(new Set(["ashby"]));
  });
});

describe("wizard steps 6 and 7: logins and safety", () => {
  it("explains logins without asking for any password", async () => {
    const ui = scripted([]);
    await loginsStep.run(makeCtx(ui));
    expect(ui.shown.join("\n")).toContain("never asks for or stores passwords");
    expect(ui.asked.some((q) => /password/i.test(q))).toBe(false);
  });

  it("keeps dry run on, runs the doctor and installs the schedule only when asked", async () => {
    const ui = scripted([["Run automatically", true]]);
    const ctx = makeCtx(ui);
    ctx.config.companies = [{ name: "Acme Rockets", ats: "greenhouse", token: "acmerockets" }];
    await safetyStep.run(ctx);
    expect(loadConfig(ctx.dirs)).toMatchObject({ dryRun: true, limits: { reviewFirst: 10 } });
    expect(ctx.calls).toEqual(["doctor", "schedule", "discover"]);

    const no = makeCtx(
      scripted([
        ["Run automatically", false],
        ["matching open jobs", false],
      ]),
    );
    await safetyStep.run(no);
    expect(no.calls).toEqual(["doctor"]);
  });
});

describe("the whole wizard", () => {
  it("can be quit halfway and continues where it stopped", async () => {
    const first = scripted([
      ["Path to your resume", RESUME],
      ["Which countries", ["India"]],
      ["Job titles", new SetupCancelled()],
    ]);
    const ctx = makeCtx(first);
    expect(await runWizard(ctx)).toBe("stopped");
    expect(loadState(ctx.dirs).done).toEqual(["ai", "resume", "answers"]);
    expect(first.shown.at(-1)).toContain('Stopped during "What to apply for"');

    const second = scripted([
      ["finished 3 of 7 steps", "continue"],
      ["Job titles", "data engineer"],
    ]);
    const ctx2 = makeCtx(second, {}, {}, ctx.dirs);
    expect(await runWizard(ctx2)).toBe("done");
    expect(second.asked).not.toContain("Full name");
    expect(loadState(ctx.dirs).done).toHaveLength(7);
    expect(loadConfig(ctx.dirs).rules).toMatchObject({ roles: ["data engineer"], countries: ["India"] });
    expect(loadProfile(ctx.dirs).name).toBe("Jane Doe");
  });

  it("lets you change one part after setup is complete", async () => {
    const ctx = makeCtx(scripted([["Path to your resume", RESUME]]));
    await runWizard(ctx);
    const ui = scripted([
      ["Setup is complete", "one"],
      ["Which part?", "logins"],
    ]);
    await runWizard(makeCtx(ui, {}, {}, ctx.dirs));
    expect(ui.asked).toContain("Got it?");
    expect(ui.asked).not.toContain("Job titles to look for (comma separated)");
  });

  it("runs every step with defaults under --yes and leaves the answers for later", async () => {
    const ctx = makeCtx(defaultsPrompter(), {}, { resume: RESUME });
    await runWizard(ctx);
    expect(loadProfile(ctx.dirs).name).toBe("Jane Doe");
    expect(loadState(ctx.dirs).done).not.toContain("answers");
    expect(loadConfig(ctx.dirs).dryRun).toBe(true);
    expect(ctx.calls).toEqual(["doctor"]);
  });
});
