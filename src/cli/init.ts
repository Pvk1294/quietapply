import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { type Company, defaultConfig, loadConfig, type ProviderId, saveConfig } from "../core/config.js";
import { openDb } from "../core/db.js";
import { ensureHome, paths } from "../core/paths.js";
import { listAnswers, saveAnswer } from "../memory/answers.js";
import { loadProfile, saveProfile } from "../memory/profile.js";
import { STANDARD_QUESTIONS } from "../memory/seed.js";
import { getProvider, PROVIDERS } from "../providers/index.js";
import { detectAts } from "../sources/detect.js";
import { importResume, seedDefaults } from "./setup.js";

export interface InitOptions {
  resume?: string;
  provider?: ProviderId;
  yes?: boolean;
  full?: boolean;
}

const cancelled = (v: unknown): v is symbol => p.isCancel(v);

function bail(): never {
  p.cancel("Setup stopped. Run `quietapply init` again any time; nothing you entered so far is lost.");
  process.exit(1);
}

/** `quietapply init`: provider, resume → profile, the standard questions, targets and companies. */
export async function init(opts: InitOptions): Promise<void> {
  const dirs = ensureHome(paths());
  const config = existsSync(dirs.config) ? loadConfig(dirs) : defaultConfig();
  const interactive = !opts.yes && process.stdin.isTTY;
  p.intro("QuietApply setup");
  p.log.info(`Your data stays in ${dirs.home} (only you can read it).`);

  // 1. Provider
  const s = p.spinner();
  s.start("Looking for Claude Code and Codex");
  const [cc, cx] = await Promise.all([PROVIDERS["claude-code"].detect(), PROVIDERS.codex.detect()]);
  s.stop(
    `Claude Code: ${cc.installed ? `${cc.version}${cc.loggedIn === false ? " (not signed in)" : ""}` : "not found"} · Codex: ${
      cx.installed ? `${cx.version}${cx.loggedIn === false ? " (not signed in)" : ""}` : "not found"
    }`,
  );
  let provider: ProviderId =
    opts.provider ?? (cc.installed ? "claude-code" : cx.installed ? "codex" : "fake");
  if (interactive && !opts.provider) {
    const choice = await p.select({
      message: "Which AI should run the applications?",
      initialValue: provider,
      options: [
        { value: "claude-code", label: "Claude Code", hint: cc.installed ? "found" : "not installed" },
        { value: "codex", label: "OpenAI Codex", hint: cx.installed ? "found" : "not installed" },
        { value: "fake", label: "None yet (try it with the built-in demo agent)" },
      ],
    });
    if (cancelled(choice)) bail();
    provider = choice as ProviderId;
  }
  config.provider = provider;
  const det = provider === "claude-code" ? cc : provider === "codex" ? cx : undefined;
  if (det?.authMethod === "api-key") config.auth = "api-key";
  for (const note of det?.notes ?? []) p.log.warn(note);

  if (provider === "claude-code" && det?.authMethod !== "api-key" && interactive) {
    const browser = await p.select({
      message: "Which browser should the agent drive?",
      initialValue: config.browser,
      options: [
        { value: "playwright-profile", label: "A separate Chrome profile (Playwright)", hint: "recommended" },
        { value: "playwright-extension", label: "Your running Chrome or Edge (Playwright extension)" },
        { value: "claude-in-chrome", label: "Claude in Chrome", hint: "Claude plans only" },
      ],
    });
    if (cancelled(browser)) bail();
    config.browser = browser as typeof config.browser;
  } else if (config.auth === "api-key" && config.browser === "claude-in-chrome") {
    config.browser = "playwright-profile";
  }

  // 2. Resume → profile
  let resumePath = opts.resume;
  if (!resumePath && interactive) {
    const answer = await p.text({
      message: "Path to your resume (PDF, DOCX or text)",
      placeholder: "~/Documents/resume.pdf",
      validate: (v) => (v && existsSync(resolve(expandHome(v))) ? undefined : "File not found"),
    });
    if (cancelled(answer)) bail();
    resumePath = answer;
  }
  if (resumePath) {
    s.start(
      provider === "fake"
        ? "Reading your resume"
        : `Reading your resume (with ${getProvider(provider).label})`,
    );
    const before = existsSync(dirs.profile) ? loadProfile(dirs) : undefined;
    const { profile, usedAgent } = await importResume(
      resolve(expandHome(resumePath)),
      dirs,
      getProvider(provider),
    );
    // Contact details you confirmed in an earlier setup beat what the parser reads from the resume again.
    for (const k of ["name", "email", "phone", "location"] as const) if (before?.[k]) profile[k] = before[k];
    saveProfile(profile, dirs);
    s.stop(
      `Profile built${usedAgent ? " by the agent" : ""}: ${profile.name || "name not found"}, ${profile.experience.length} roles, ${profile.skills.length} skills`,
    );
    if (interactive) {
      const fixes = await p.group(
        {
          name: () => p.text({ message: "Full name", initialValue: profile.name }),
          email: () => p.text({ message: "Email for applications", initialValue: profile.email }),
          phone: () => p.text({ message: "Phone (with country code)", initialValue: profile.phone }),
          location: () => p.text({ message: "City, country", initialValue: profile.location }),
        },
        { onCancel: bail },
      );
      Object.assign(profile, fixes);
      saveProfile(profile, dirs);
    }
    p.log.info(`Check the rest any time in ${dirs.profile} or the dashboard.`);
  } else {
    p.log.warn("No resume given. Run `quietapply init --resume <file>` later.");
  }

  // 3. Answer memory
  const db = openDb(dirs);
  seedDefaults(db);
  if (interactive) {
    const known = new Set(listAnswers(db).map((a) => a.key));
    const todo = STANDARD_QUESTIONS.filter(
      (q) => !q.default && !known.has(q.key) && (opts.full || q.essential),
    );
    p.log.step(
      `${todo.length} questions most forms ask. Leave one empty to skip it: the agent will ask in the dashboard when a form needs it.`,
    );
    for (const q of todo) {
      const v =
        q.type === "yesno"
          ? await p.select({
              message: q.question,
              options: [
                { value: "Yes", label: "Yes" },
                { value: "No", label: "No" },
                { value: "", label: "Skip" },
              ],
            })
          : await p.text({ message: q.question, placeholder: q.hint ?? "", defaultValue: "" });
      if (cancelled(v)) bail();
      if (typeof v === "string" && v.trim())
        saveAnswer(db, { key: q.key, question: q.question, answer: v.trim(), type: q.type, source: "setup" });
    }
  }

  // 4. Targets and companies
  if (interactive) {
    const t = await p.group(
      {
        roles: () =>
          p.text({
            message: "Job titles to look for (comma separated)",
            placeholder: "software engineer, backend developer",
            initialValue: config.rules.roles.join(", "),
          }),
        locations: () =>
          p.text({
            message: "Locations (comma separated; 'remote' for remote roles)",
            placeholder: "remote, Berlin",
            initialValue: config.rules.locations.join(", "),
          }),
        never: () =>
          p.text({
            message: "Companies never to apply to (e.g. your current employer)",
            initialValue: config.rules.neverApply.join(", "),
            defaultValue: "",
          }),
        companies: () =>
          p.text({
            message: "Careers pages to watch (Greenhouse, Lever or Ashby URLs, comma separated)",
            placeholder: "https://boards.greenhouse.io/acme, https://jobs.lever.co/globex",
            defaultValue: "",
          }),
        perDay: () =>
          p.text({ message: "Maximum applications per day", initialValue: String(config.limits.perDay) }),
      },
      { onCancel: bail },
    );
    config.rules.roles = list(t.roles);
    config.rules.locations = list(t.locations);
    config.rules.neverApply = list(t.never);
    config.companies = mergeCompanies(config.companies, list(t.companies));
    config.limits.perDay = Math.max(0, Number(t.perDay) || config.limits.perDay);
  }

  saveConfig(config, dirs);
  p.note(
    [
      "quietapply doctor        check the provider, browser and data folder",
      "quietapply discover      find open roles at your companies",
      "quietapply run           one run now (dry run: nothing is submitted)",
      "quietapply dashboard     http://127.0.0.1:4777",
    ].join("\n"),
    "Next",
  );
  p.outro(
    `Dry run is ON and the first ${config.limits.reviewFirst} applications wait for your OK. Change both in Settings.`,
  );
}

function list(s: string | undefined): string[] {
  return (s ?? "")
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function mergeCompanies(existing: Company[], urls: string[]): Company[] {
  const out = [...existing];
  for (const u of urls) {
    const ref = detectAts(u);
    if (!ref) continue;
    if (!out.some((c) => c.ats === ref.ats && c.token === ref.token))
      out.push({ name: ref.token.replace(/[-_]/g, " "), ats: ref.ats, token: ref.token });
  }
  return out;
}

function expandHome(f: string): string {
  return f.startsWith("~/") ? `${process.env.HOME ?? ""}${f.slice(1)}` : f;
}
