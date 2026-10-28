import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "../src/cli/init.js";
import { loadConfig } from "../src/core/config.js";
import { openDb } from "../src/core/db.js";
import { paths } from "../src/core/paths.js";
import { listAnswers } from "../src/memory/answers.js";
import { loadProfile } from "../src/memory/profile.js";
import { PROVIDERS } from "../src/providers/index.js";

// A scripted user for the interactive `quietapply init`. Each prompt takes the first unused answer whose
// pattern matches its message; ENTER keeps the pre-filled value; a prompt with no scripted answer fails.
const h = vi.hoisted(() => ({
  script: [] as { re: RegExp; value: unknown; used?: boolean }[],
  asked: [] as string[],
  rejected: [] as string[],
  ENTER: Symbol("enter"),
  CANCEL: Symbol("cancel"),
}));

vi.mock("@clack/prompts", () => {
  const next = (message: string) => {
    h.asked.push(message);
    const entry = h.script.find((s) => !s.used && s.re.test(message));
    if (!entry) throw new Error(`unexpected prompt: ${message}`);
    entry.used = true;
    return entry.value;
  };
  type TextOpts = {
    message: string;
    initialValue?: string;
    defaultValue?: string;
    validate?: (v: string | undefined) => string | Error | undefined;
  };
  const text = async (o: TextOpts): Promise<unknown> => {
    for (;;) {
      const v = next(o.message);
      if (v === h.CANCEL) return v;
      const value = v === h.ENTER ? (o.initialValue ?? "") : String(v);
      const problem = o.validate?.(value);
      if (problem) {
        h.rejected.push(`${o.message}: ${String(problem)}`);
        continue; // clack shows the error and asks again
      }
      return value || (o.defaultValue ?? "");
    }
  };
  const select = async (o: { message: string; initialValue?: unknown; options: { value: unknown }[] }) => {
    const v = next(o.message);
    if (v === h.ENTER) return o.initialValue ?? o.options[0]?.value;
    if (v !== h.CANCEL && !o.options.some((x) => x.value === v))
      throw new Error(`${String(v)} is not an option`);
    return v;
  };
  const group = async (
    prompts: Record<string, (o: { results: Record<string, unknown> }) => Promise<unknown>>,
    opts?: { onCancel?: (o: { results: Record<string, unknown> }) => void },
  ) => {
    const results: Record<string, unknown> = {};
    for (const [key, ask] of Object.entries(prompts)) {
      const v = await ask({ results });
      if (v === h.CANCEL) opts?.onCancel?.({ results });
      results[key] = v;
    }
    return results;
  };
  const quiet = () => {};
  return {
    intro: quiet,
    outro: quiet,
    note: quiet,
    cancel: quiet,
    log: { info: quiet, warn: quiet, step: quiet, message: quiet },
    spinner: () => ({ start: quiet, stop: quiet, message: quiet }),
    isCancel: (v: unknown) => v === h.CANCEL,
    text,
    select,
    group,
  };
});

const RESUME = join(import.meta.dirname, "../fixtures/persona/jane-doe-resume.txt");
const say = (re: RegExp, value: unknown) => h.script.push({ re, value });

let home: string;
const stdinTTY = process.stdin.isTTY;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "qa-init-flow-"));
  process.env.QUIETAPPLY_HOME = home;
  h.script.length = 0;
  h.asked.length = 0;
  h.rejected.length = 0;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  vi.spyOn(PROVIDERS["claude-code"], "detect").mockResolvedValue({
    installed: true,
    version: "2.1.0",
    loggedIn: true,
    authMethod: "subscription",
    notes: [],
  });
  vi.spyOn(PROVIDERS.codex, "detect").mockResolvedValue({ installed: false, notes: [] });
  // The user's AI tidies the resume; here it adds a headline and years of experience.
  vi.spyOn(PROVIDERS["claude-code"], "complete").mockResolvedValue(
    '{"headline":"Full-stack engineer","totalYears":5,"skills":[{"name":"typescript","years":5}]}',
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, "isTTY", { value: stdinTTY, configurable: true });
  delete process.env.QUIETAPPLY_HOME;
});

/** The answers a first-time user gives, in the order init asks. */
function firstRun() {
  say(/Which AI/, "claude-code");
  say(/Which browser/, "playwright-profile");
  say(/Path to your resume/, "~/no-such-folder/resume.pdf"); // rejected: file not found
  say(/Path to your resume/, RESUME);
  say(/Full name/, h.ENTER);
  say(/Email/, h.ENTER);
  say(/Phone/, "+1 555 010 0199");
  say(/City, country/, "Springfield, Oregon, USA");
  say(/legally authorized/, "Yes");
  say(/visa sponsorship/, "No");
  say(/Which country/, "United States");
  say(/notice period/, "30 days");
  say(/salary expectations/, ""); // skipped: asked later, when a form needs it
  say(/relocate/, ""); // "Skip"
  say(/work arrangements/, "Remote or hybrid");
  say(/storing and processing/, "Yes");
  say(/Job titles/, "backend engineer, full-stack engineer");
  say(/Locations/, "remote, Springfield");
  say(/never to apply/, "Initech");
  say(
    /Careers pages/,
    "https://boards.greenhouse.io/acmerockets, https://jobs.lever.co/globex, https://example.com/jobs",
  );
  say(/per day/, "5");
}

describe("interactive quietapply init", () => {
  it("walks a new user through provider, resume, essential questions and targets", async () => {
    firstRun();
    await init({});

    expect(h.script.filter((s) => !s.used)).toEqual([]);
    expect(h.rejected).toEqual(["Path to your resume (PDF, DOCX or text): File not found"]);
    // Asked in this order, each once (the resume path twice because the first one was wrong).
    expect(h.asked.slice(0, 4)).toEqual([
      "Which AI should run the applications?",
      "Which browser should the agent drive?",
      "Path to your resume (PDF, DOCX or text)",
      "Path to your resume (PDF, DOCX or text)",
    ]);
    expect(h.asked).toHaveLength(21);

    const p = paths(home);
    const config = loadConfig(p);
    expect(config).toMatchObject({
      provider: "claude-code",
      auth: "subscription",
      browser: "playwright-profile",
      dryRun: true,
      limits: { perDay: 5 },
      rules: {
        roles: ["backend engineer", "full-stack engineer"],
        locations: ["remote", "Springfield"],
        neverApply: ["Initech"],
      },
    });
    expect(config.companies).toEqual([
      { name: "acmerockets", ats: "greenhouse", token: "acmerockets" },
      { name: "globex", ats: "lever", token: "globex" },
    ]);

    const profile = loadProfile(p);
    expect(profile).toMatchObject({
      name: "Jane Doe",
      email: "jane.doe@example.com",
      phone: "+1 555 010 0199",
      location: "Springfield, Oregon, USA",
      headline: "Full-stack engineer",
      totalYears: 5,
      resumeFile: "resume.txt",
    });
    expect(existsSync(join(p.resumeDir, "resume.txt"))).toBe(true);

    const db = openDb(p);
    const byKey = Object.fromEntries(listAnswers(db).map((a) => [a.key, a]));
    db.close();
    expect(byKey.work_authorization).toMatchObject({ answer: "Yes", source: "setup" });
    expect(byKey.country?.answer).toBe("United States");
    expect(byKey.notice_period?.answer).toBe("30 days");
    expect(byKey.salary_expectation).toBeUndefined();
    expect(byKey.relocation).toBeUndefined();
    // Safe defaults are stored without asking.
    expect(byKey.gender).toMatchObject({ answer: "I prefer not to answer", source: "default" });
    expect(byKey.referral?.answer).toBe("Company careers page");
  });

  it("asks only what is still missing when run again", async () => {
    firstRun();
    await init({});
    h.asked.length = 0;

    say(/Which AI/, h.ENTER);
    say(/Which browser/, h.ENTER);
    say(/Path to your resume/, RESUME);
    for (const re of [/Full name/, /Email/, /Phone/, /City, country/]) say(re, h.ENTER);
    say(/salary expectations/, "USD 120,000 per year");
    say(/relocate/, "No");
    for (const re of [/Job titles/, /Locations/, /never to apply/]) say(re, h.ENTER);
    say(/Careers pages/, "https://jobs.ashbyhq.com/umbrella");
    say(/per day/, h.ENTER);
    await init({});

    expect(h.asked.some((m) => /legally authorized|notice period|Which country/.test(m))).toBe(false);
    const p = paths(home);
    const config = loadConfig(p);
    expect(config.limits.perDay).toBe(5);
    expect(config.rules.neverApply).toEqual(["Initech"]);
    expect(config.companies.map((c) => c.token)).toEqual(["acmerockets", "globex", "umbrella"]);
    expect(loadProfile(p).location).toBe("Springfield, Oregon, USA");
    const db = openDb(p);
    expect(listAnswers(db).find((a) => a.key === "salary_expectation")?.answer).toBe("USD 120,000 per year");
    db.close();
  });

  it("skips the browser question for API-key logins and never offers Claude in Chrome", async () => {
    vi.spyOn(PROVIDERS["claude-code"], "detect").mockResolvedValue({
      installed: true,
      version: "2.1.0",
      loggedIn: true,
      authMethod: "api-key",
      notes: ["API key login: Claude in Chrome is not available, so the browser will be Playwright."],
    });
    say(/Which AI/, "claude-code");
    say(/Path to your resume/, RESUME);
    for (const re of [/Full name/, /Email/, /Phone/, /City, country/]) say(re, h.ENTER);
    for (const re of [
      /authorized/,
      /sponsorship/,
      /Which country/,
      /notice/,
      /salary/,
      /relocate/,
      /arrangements/,
      /storing/,
    ])
      say(re, "");
    for (const re of [/Job titles/, /Locations/, /never to apply/, /Careers pages/, /per day/])
      say(re, h.ENTER);
    await init({});

    expect(h.asked).not.toContain("Which browser should the agent drive?");
    expect(loadConfig(paths(home))).toMatchObject({ auth: "api-key", browser: "playwright-profile" });
  });

  it("stops cleanly on Ctrl-C without writing a config", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    say(/Which AI/, h.CANCEL);
    await expect(init({})).rejects.toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(existsSync(paths(home).config)).toBe(false);
  });

  it("asks nothing with --yes", async () => {
    await init({ yes: true, provider: "fake", resume: RESUME });
    expect(h.asked).toEqual([]);
    const p = paths(home);
    expect(loadConfig(p).provider).toBe("fake");
    expect(loadProfile(p).name).toBe("Jane Doe");
  });
});
