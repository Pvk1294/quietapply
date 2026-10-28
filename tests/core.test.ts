import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Config, defaultConfig, loadConfig, saveConfig } from "../src/core/config.js";
import { openDb, openMemoryDb } from "../src/core/db.js";
import { allowance, companyAllowed } from "../src/core/limits.js";
import { acquireLock } from "../src/core/lock.js";
import { ensureHome, paths } from "../src/core/paths.js";
import { checkFit, requiredYears } from "../src/core/rules.js";
import { addApplication, setStatus } from "../src/core/store.js";
import { Profile } from "../src/memory/profile.js";

const tmp = () => mkdtempSync(join(tmpdir(), "qa-test-"));

describe("config", () => {
  it("has safe defaults", () => {
    const c = defaultConfig();
    expect(c.dryRun).toBe(true);
    expect(c.limits).toMatchObject({ perDay: 15, reviewFirst: 10, perCompany30d: 2 });
    expect(c.sources.linkedin).toBe(false);
  });

  it("round-trips through YAML and keeps the data folder private", () => {
    const p = ensureHome(paths(tmp()));
    saveConfig({ ...defaultConfig(), provider: "codex" }, p);
    expect(loadConfig(p).provider).toBe("codex");
    if (process.platform !== "win32") expect(statSync(p.home).mode & 0o777).toBe(0o700);
  });

  it("keeps LinkedIn off unless the risk was accepted", () => {
    const p = ensureHome(paths(tmp()));
    writeFileSync(p.config, "sources:\n  linkedin: true\n");
    expect(loadConfig(p).sources.linkedin).toBe(false);
    writeFileSync(
      p.config,
      'sources:\n  linkedin: true\nlinkedin:\n  acceptedAt: "2026-10-28T09:00:00.000Z"\n',
    );
    expect(loadConfig(p).sources.linkedin).toBe(true);
    expect(loadConfig(p).linkedin.perDay).toBe(5);
  });

  it("caps LinkedIn at 15 a day", () => {
    expect(() => Config.parse({ linkedin: { perDay: 16 } })).toThrow();
    expect(() => Config.parse({ linkedin: { perDay: 0 } })).toThrow();
  });

  it("rejects malformed schedule times", () => {
    expect(() => Config.parse({ schedule: ["9am"] })).toThrow();
  });
});

describe("database", () => {
  it("creates the schema in the data folder", () => {
    const p = paths(tmp());
    const db = openDb(p);
    addApplication(db, { company: "Acme", title: "Engineer", url: "https://example.com/1" });
    db.close();
    expect(existsSync(p.db)).toBe(true);
    const again = openDb(p);
    expect(again.prepare("SELECT COUNT(*) AS n FROM applications").get()).toEqual({ n: 1 });
  });

  it("dedupes applications by URL", () => {
    const db = openMemoryDb();
    const a = addApplication(db, { company: "Acme", title: "Engineer", url: "https://example.com/1" });
    const b = addApplication(db, { company: "Acme", title: "Engineer", url: "https://example.com/1" });
    expect(b).toEqual({ id: a.id, created: false });
  });
});

describe("limits", () => {
  it("counts today's submissions against the daily cap and review mode", () => {
    const db = openMemoryDb();
    const c = Config.parse({ limits: { perDay: 2, reviewFirst: 1, perCompany30d: 1 } });
    expect(allowance(db, c)).toEqual({ remainingToday: 2, reviewMode: true });
    const id = addApplication(db, { company: "Acme", title: "Engineer", url: "https://example.com/1" }).id;
    setStatus(db, id, "submitted");
    expect(allowance(db, c)).toEqual({ remainingToday: 1, reviewMode: false });
    expect(companyAllowed(db, c, "acme")).toBe(false);
    expect(companyAllowed(db, c, "Globex")).toBe(true);
  });
});

describe("lock", () => {
  it("allows one holder at a time and takes over stale locks", () => {
    const file = join(tmp(), "runner.lock");
    const release = acquireLock(file);
    expect(release).toBeTypeOf("function");
    expect(acquireLock(file)).toBeNull();
    release!();
    writeFileSync(file, "999999");
    const again = acquireLock(file);
    expect(again).toBeTypeOf("function");
    expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    again!();
  });
});

describe("fit gate", () => {
  const rules = Config.parse({
    rules: {
      roles: ["engineer", "developer"],
      excludeTitles: ["intern", "principal"],
      locations: ["Springfield", "remote"],
      neverApply: ["Initech"],
    },
  }).rules;
  const profile = Profile.parse({
    totalYears: 4,
    skills: [{ name: "typescript" }, { name: "react" }, { name: "node.js" }],
  });

  it("passes a matching job", () => {
    expect(
      checkFit({ company: "Acme", title: "Software Engineer", location: "Remote - US" }, rules, profile).fit,
    ).toBe(true);
  });
  it.each([
    [{ company: "Initech", title: "Engineer" }, "never-apply"],
    [{ company: "Acme", title: "Product Manager" }, "matches none"],
    [{ company: "Acme", title: "Engineering Intern" }, "excluded"],
    [{ company: "Acme", title: "Engineer", location: "Shelbyville" }, "location"],
    [
      {
        company: "Acme",
        title: "Engineer",
        description: "Please do not use AI tools to write your answers.",
      },
      "AI",
    ],
    [
      { company: "Acme", title: "Engineer", description: "You have 8+ years of professional experience." },
      "8+ years",
    ],
    [
      {
        company: "Acme",
        title: "Engineer",
        description: "We use Python, Django, Kafka, Kubernetes and Terraform.",
      },
      "listed skills",
    ],
  ])("skips %o with a reason", (job, reason) => {
    const r = checkFit(job, rules, profile);
    expect(r.fit).toBe(false);
    if (!r.fit) expect(r.reason).toContain(reason);
  });
  it("reads required years", () => {
    expect(requiredYears("3-5 years of experience")).toBe(3);
    expect(requiredYears("at least 2 years of relevant industry experience")).toBe(2);
    expect(requiredYears("no experience needed")).toBeUndefined();
  });
});
