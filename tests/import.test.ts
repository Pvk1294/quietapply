import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveConfig } from "../src/core/config.js";
import { openDb } from "../src/core/db.js";
import { allowance, companyAllowed } from "../src/core/limits.js";
import { ensureHome, paths } from "../src/core/paths.js";
import { addApplication, alreadyApplied, listApplications } from "../src/core/store.js";
import { companyKey, titleKey } from "../src/core/text.js";
import { parseCsv } from "../src/import/csv.js";
import { importFolder } from "../src/import/index.js";
import { listAnswers, lookupAnswer } from "../src/memory/answers.js";
import { loadProfile } from "../src/memory/profile.js";
import { discover } from "../src/runner/discover.js";
import type { Fetcher } from "../src/sources/http.js";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "import", "old-runner");
const tmp = () => mkdtempSync(join(tmpdir(), "qa-import-"));

function freshHome() {
  const p = ensureHome(paths(tmp()));
  saveConfig({ ...defaultConfig(), provider: "fake" }, p);
  return p;
}

describe("csv", () => {
  it("reads quoted commas, doubled quotes and line breaks", () => {
    const rows = parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n\n3,\n');
    expect(rows).toEqual([
      { a: "x, y", b: 'say "hi"\nthere' },
      { a: "3", b: "" },
    ]);
  });
});

describe("quietapply import", () => {
  it("imports the profile, answers, applications and targets from the fake fixture", () => {
    const p = freshHome();
    const db = openDb(p);
    const s = importFolder(db, p, FIXTURE);
    expect(s.label).toBe("old runner");

    const profile = loadProfile(p);
    expect(profile).toMatchObject({
      name: "Jane Doe",
      phone: "+1 555 010 0199",
      location: "Springfield, United States",
      totalYears: 5,
    });
    expect(profile.links.github).toBe("https://github.com/janedoe-example");
    expect(listAnswers(db).find((a) => a.key === "country")?.answer).toBe("United States");

    expect(s.answers).toEqual({ added: 6, updated: 0, skipped: 1 });
    const notice = listAnswers(db).find((a) => a.key === "notice_period")!;
    expect(notice.source).toBe("import: old runner (asked 2026-09-16)");
    const globex = listAnswers(db).find((a) => a.question.startsWith("Do you know anyone"))!;
    expect(globex).toMatchObject({ scope: "company", scope_value: "Globex" });
    expect(lookupAnswer(db, profile, "Rate yourself 1-10 in data structures and algorithms")).toMatchObject({
      status: "known",
      answer: "8",
    });

    expect(s.applications).toEqual({ imported: 5, duplicates: 1, notApplied: 1, invalid: 1 });
    const apps = listApplications(db);
    expect(apps.every((a) => a.status === "submitted" && a.source === "import")).toBe(true);
    const acme = apps.find((a) => a.company === "Acme Rockets")!;
    expect(acme).toMatchObject({ ats: "lever", reason: "imported from old runner: Applied" });
    expect(acme.submitted_at).toBe("2026-09-16T17:15:00.000Z");
    expect(apps.find((a) => a.company === "Initrode")!.url).toBe(
      "import:old-runner/initrode/full-stack-developer/2026-10-12",
    );
    // Two applications that the tracker stored under one search-page link stay two applications.
    expect(
      apps.filter((a) => a.url.startsWith("https://jobboard.example.com/search")).map((a) => a.url),
    ).toEqual(
      expect.arrayContaining([
        "https://jobboard.example.com/search?q=backend",
        "https://jobboard.example.com/search?q=backend#soylent-corp/software-engineer",
      ]),
    );

    const config = loadConfig(p);
    expect(config.rules.roles).toEqual(["backend engineer", "software engineer"]);
    expect(config.rules.neverApply).toEqual(["Initech"]);
    expect(config.rules.experienceYears).toEqual({ min: 0, max: 6 });
    expect(config.companies.map((c) => `${c.ats}:${c.token}`)).toEqual([
      "greenhouse:globex",
      "lever:acmerockets",
      "ashby:hooli",
    ]);
    expect(s.warnings.some((w) => w.includes("example.com/careers"))).toBe(true);
    db.close();
  });

  it("adds nothing the second time", () => {
    const p = freshHome();
    const db = openDb(p);
    importFolder(db, p, FIXTURE);
    const again = importFolder(db, p, FIXTURE);
    expect(again.applications.imported).toBe(0);
    expect(again.applications.duplicates).toBe(6);
    expect(again.answers.added).toBe(0);
    expect(again.targets).toEqual({ roles: 0, excludeTitles: 0, locations: 0, neverApply: 0, companies: 0 });
    expect(listApplications(db)).toHaveLength(5);
    db.close();
  });

  it("writes nothing in a dry run", () => {
    const p = freshHome();
    const db = openDb(p);
    const s = importFolder(db, p, FIXTURE, { dryRun: true });
    expect(s.applications.imported).toBe(5);
    expect(listApplications(db)).toHaveLength(0);
    expect(listAnswers(db)).toHaveLength(0);
    expect(loadProfile(p).name).toBe("");
    expect(loadConfig(p).rules.roles).toEqual([]);
    db.close();
  });

  it("reads plain files with common field names when there is no mapping", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "applications.csv"),
      "Company,Role,Link,Applied,Status\nAcme,Engineer,https://jobs.lever.co/acme/1,2026-10-01,Applied\n",
    );
    writeFileSync(join(dir, "answers.json"), JSON.stringify([{ q: "Notice period?", a: "Immediately" }]));
    const p = freshHome();
    const db = openDb(p);
    // CSV headers are matched as written, so "Company" needs a mapping or the lower-case name.
    expect(importFolder(db, p, dir).applications.invalid).toBe(1);
    writeFileSync(
      join(dir, "applications.csv"),
      "company,role,link,applied,status\nAcme,Engineer,https://jobs.lever.co/acme/1,2026-10-01,Applied\n",
    );
    expect(importFolder(db, p, dir).applications.imported).toBe(1);
    expect(listAnswers(db)[0]).toMatchObject({ question: "Notice period?", answer: "Immediately" });
    db.close();
  });

  it("says what it expected when the folder holds nothing it knows", () => {
    const p = freshHome();
    const db = openDb(p);
    expect(() => importFolder(db, p, tmp())).toThrow(/Nothing to import/);
    db.close();
  });
});

describe("imported history and the limits", () => {
  it("never applies twice to the same company and role, whatever the link", () => {
    const p = freshHome();
    const db = openDb(p);
    importFolder(db, p, FIXTURE);
    const again = addApplication(db, {
      company: "Globex",
      title: "Backend Engineer (Remote)",
      url: "https://boards.greenhouse.io/globex/jobs/9999999",
    });
    expect(
      alreadyApplied(db, { company: "Globex", title: "Backend Engineer (Remote)" }, again.id)?.company,
    ).toBe("Globex, Inc.");
    expect(alreadyApplied(db, { company: "Globex", title: "Frontend Engineer" })).toBeUndefined();
    expect(companyKey("Hooli, Inc. (YC W16)")).toBe(companyKey("hooli"));
    expect(titleKey("Software Engineer - Backend (Remote)")).toBe(titleKey("Software Engineer, Backend"));
    db.close();
  });

  it("counts imported applications for the per-company cap by the date they were sent", () => {
    const p = freshHome();
    const db = openDb(p);
    importFolder(db, p, FIXTURE);
    const config = loadConfig(p);
    const nov = new Date("2026-10-20T12:00:00Z");
    // Globex: one application on 10 Oct, cap 2 in 30 days.
    expect(
      companyAllowed(db, { ...config, limits: { ...config.limits, perCompany30d: 1 } }, "Globex", nov),
    ).toBe(false);
    expect(companyAllowed(db, config, "Globex", nov)).toBe(true);
    // Acme: 16 Sep is more than 30 days before 20 Oct.
    expect(
      companyAllowed(db, { ...config, limits: { ...config.limits, perCompany30d: 1 } }, "Acme Rockets", nov),
    ).toBe(true);
    // Imported history is not "sent today", and it does not end review mode.
    const a = allowance(db, config, nov);
    expect(a.remainingToday).toBe(config.limits.perDay);
    expect(a.reviewMode).toBe(true);
    db.close();
  });

  it("discover leaves out roles already applied to", async () => {
    const p = freshHome();
    const db = openDb(p);
    importFolder(db, p, FIXTURE);
    const fetcher: Fetcher = async () =>
      JSON.stringify({
        jobs: [
          {
            id: 1,
            title: "Backend Engineer",
            absolute_url: "https://boards.greenhouse.io/globex/jobs/1",
            location: { name: "Remote" },
            content: "",
          },
          {
            id: 2,
            title: "Software Engineer",
            absolute_url: "https://boards.greenhouse.io/globex/jobs/2",
            location: { name: "Remote" },
            content: "",
          },
        ],
      });
    const config = loadConfig(p);
    const s = await discover(
      db,
      {
        ...config,
        companies: [{ name: "Globex", ats: "greenhouse", token: "globex" }],
        rules: { ...config.rules, locations: [] },
      },
      loadProfile(p),
      fetcher,
    );
    expect(s.alreadyApplied).toBe(1);
    expect(s.added).toBe(1);
    db.close();
  });
});
