import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeCompanies } from "../src/cli/init.js";
import { importResume, seedDefaults } from "../src/cli/setup.js";
import { openDb } from "../src/core/db.js";
import { ensureHome, paths } from "../src/core/paths.js";
import { lookupAnswer } from "../src/memory/answers.js";
import { loadProfile } from "../src/memory/profile.js";
import type { Provider } from "../src/providers/types.js";
import { applyUrl, detectAts } from "../src/sources/detect.js";

const resume = join(import.meta.dirname, "../fixtures/persona/jane-doe-resume.txt");

describe("init core", () => {
  it("copies the resume into the data folder and saves a profile", async () => {
    const p = ensureHome(paths(mkdtempSync(join(tmpdir(), "qa-init-"))));
    const { profile, usedAgent } = await importResume(resume, p);
    expect(usedAgent).toBe(false);
    expect(existsSync(join(p.resumeDir, "resume.txt"))).toBe(true);
    expect(loadProfile(p)).toMatchObject({ name: "Jane Doe", resumeFile: "resume.txt" });
    expect(profile.skills.length).toBeGreaterThan(5);
  });

  it("uses the agent's structured profile when the provider returns one", async () => {
    const p = ensureHome(paths(mkdtempSync(join(tmpdir(), "qa-init-"))));
    const agent: Provider = {
      id: "claude-code",
      label: "stub",
      detect: async () => ({ installed: true, notes: [] }),
      complete: async () =>
        'Here you go: {"headline":"Full-stack engineer","totalYears":5,"skills":[{"name":"typescript","years":5}]}',
      runAgent: async () => ({ status: "completed", text: "", exitCode: 0 }),
    };
    const { profile, usedAgent } = await importResume(resume, p, agent);
    expect(usedAgent).toBe(true);
    expect(profile).toMatchObject({
      name: "Jane Doe",
      totalYears: 5,
      skills: [{ name: "typescript", years: 5 }],
    });
  });

  it("seeds only the safe defaults without asking", () => {
    const p = ensureHome(paths(mkdtempSync(join(tmpdir(), "qa-init-"))));
    const db = openDb(p);
    expect(seedDefaults(db)).toBeGreaterThan(3);
    expect(lookupAnswer(db, loadProfile(p), "Veteran Status")).toMatchObject({
      answer: "I prefer not to answer",
    });
    expect(lookupAnswer(db, loadProfile(p), "What is your notice period?").status).not.toBe("known");
  });
});

describe("ATS detection", () => {
  it.each([
    [
      "https://boards.greenhouse.io/acme/jobs/4012345",
      { ats: "greenhouse", token: "acme", jobId: "4012345" },
    ],
    ["https://job-boards.greenhouse.io/acme", { ats: "greenhouse", token: "acme" }],
    [
      "https://boards.greenhouse.io/embed/job_app?for=acme&token=42",
      { ats: "greenhouse", token: "acme", jobId: "42" },
    ],
    ["https://jobs.lever.co/globex/1b2c3d4e-0000-4000-8000-000000000001", { ats: "lever", token: "globex" }],
    ["https://jobs.eu.lever.co/globex", { ats: "lever", token: "globex", region: "eu" }],
    ["jobs.ashbyhq.com/umbrella/7f3e", { ats: "ashby", token: "umbrella", jobId: "7f3e" }],
  ])("%s", (url, want) => {
    expect(detectAts(url)).toMatchObject(want);
  });
  it("ignores other sites", () => {
    expect(detectAts("https://example.com/careers")).toBeUndefined();
  });
  it("points Lever and Ashby jobs at their application page", () => {
    expect(applyUrl("https://jobs.lever.co/globex/abc")).toBe("https://jobs.lever.co/globex/abc/apply");
    expect(applyUrl("https://jobs.ashbyhq.com/umbrella/7f3e")).toBe(
      "https://jobs.ashbyhq.com/umbrella/7f3e/application",
    );
    expect(applyUrl("https://boards.greenhouse.io/acme/jobs/1")).toBe(
      "https://boards.greenhouse.io/acme/jobs/1",
    );
  });
  it("adds companies from careers URLs without duplicates", () => {
    const out = mergeCompanies(
      [],
      ["https://boards.greenhouse.io/acme", "https://boards.greenhouse.io/acme/jobs/1", "nope"],
    );
    expect(out).toEqual([{ name: "acme", ats: "greenhouse", token: "acme" }]);
  });
});
