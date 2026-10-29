import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import {
  type Company,
  type Config,
  defaultConfig,
  loadConfig,
  type ProviderId,
  saveConfig,
} from "../core/config.js";
import { openDb } from "../core/db.js";
import { ensureHome, paths } from "../core/paths.js";
import { cleanAddress } from "../email/compose.js";
import { declineEmail, EMAIL_QUESTION, EMAIL_RISK, smtpPreset, turnOnEmail } from "../email/mode.js";
import { savePassword } from "../email/secret.js";
import { declineMessages, MESSAGE_QUESTION, MESSAGE_RISK, turnOnMessages } from "../linkedin/messages.js";
import { LINKEDIN_RISK, linkedInEnabled, linkedInSetupProblem, turnOnLinkedIn } from "../linkedin/mode.js";
import { listAnswers, saveAnswer } from "../memory/answers.js";
import { loadProfile, type Profile, saveProfile } from "../memory/profile.js";
import { STANDARD_QUESTIONS } from "../memory/seed.js";
import { getProvider, PROVIDERS } from "../providers/index.js";
import { macProtectedFolder, scheduleState, setAutoStart } from "../scheduler/index.js";
import { detectAts } from "../sources/detect.js";
import { EXPLAIN } from "./explain.js";
import { importResume, seedDefaults, setupGaps } from "./setup.js";

export interface InitOptions {
  resume?: string;
  provider?: ProviderId;
  yes?: boolean;
  full?: boolean;
}

const cancelled = (v: unknown): v is symbol => p.isCancel(v);

function bail(): never {
  p.cancel("Setup stopped. Run `quietapply init` again any time. Nothing you entered so far is lost.");
  process.exit(1);
}

/** `quietapply init`: provider, resume → profile, the standard questions, targets and companies. */
export async function init(opts: InitOptions): Promise<void> {
  const dirs = ensureHome(paths());
  const config = existsSync(dirs.config) ? loadConfig(dirs) : defaultConfig();
  const interactive = !opts.yes && process.stdin.isTTY;
  p.intro("QuietApply setup");
  p.log.info(
    `Welcome! This takes about five minutes. I will say what each question is for before I ask it, and you can stop any time with Ctrl+C.\nYour data stays in ${dirs.home} (only you can read it).`,
  );

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
    p.log.message(EXPLAIN.provider);
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
    p.log.message(EXPLAIN.browser);
    const browser = await p.select({
      message: "Which browser should the agent drive?",
      initialValue: config.browser,
      options: [
        { value: "playwright-profile", label: "A separate Chrome profile (Playwright)", hint: "recommended" },
        { value: "playwright-extension", label: "Your running Chrome or Edge (Playwright extension)" },
        {
          value: "claude-in-chrome",
          label: "Claude in Chrome",
          hint: "Claude plans only, use Playwright for dry runs",
        },
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
    p.log.message(EXPLAIN.resume);
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
    if (interactive) await askContact(profile, dirs);
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
    p.log.step(`${todo.length} questions most forms ask.`);
    p.log.message(EXPLAIN.common);
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
    p.log.message("Now what to apply for. Each question below says what it does.");
    // Each question is preceded by one line saying why it is asked.
    const ask = (why: string, q: Parameters<typeof p.text>[0]) => () => {
      p.log.message(why);
      return p.text(q);
    };
    const t = await p.group(
      {
        roles: ask(EXPLAIN.roles, {
          message: "Job titles to look for (comma separated)",
          placeholder: "for example: software engineer, backend developer",
          initialValue: config.rules.roles.join(", "),
          // Empty would queue every open role at every company you watch.
          validate: (v) =>
            list(v).length ? undefined : "Add at least one job title, for example: software engineer",
        }),
        locations: ask(EXPLAIN.locations, {
          message: "Locations (comma separated; 'remote' for remote roles)",
          placeholder: "for example: remote, Berlin (empty means anywhere)",
          initialValue: config.rules.locations.join(", "),
        }),
        never: ask(EXPLAIN.never, {
          message: "Companies never to apply to (e.g. your current employer)",
          initialValue: config.rules.neverApply.join(", "),
          defaultValue: "",
        }),
        companies: ask(EXPLAIN.companies, {
          message: "Careers pages to watch (Greenhouse, Lever or Ashby URLs, comma separated)",
          placeholder: "https://boards.greenhouse.io/acme, https://jobs.lever.co/globex",
          defaultValue: "",
        }),
        perDay: ask(EXPLAIN.perDay, {
          message: "Maximum applications per day",
          initialValue: String(config.limits.perDay),
        }),
      },
      { onCancel: bail },
    );
    config.rules.roles = list(t.roles);
    config.rules.locations = list(t.locations);
    config.rules.neverApply = list(t.never);
    config.companies = mergeCompanies(config.companies, list(t.companies));
    config.limits.perDay = Math.max(0, Number(t.perDay) || config.limits.perDay);
  }

  // LinkedIn is opt-in: a plain "no" by default, and a clear risk statement before a "yes".
  if (interactive && !linkedInSetupProblem(config) && provider === "claude-code") {
    p.log.message(EXPLAIN.linkedin);
    const want = await p.confirm({ message: "Turn on LinkedIn mode now?", initialValue: false });
    if (cancelled(want)) bail();
    if (want) {
      p.log.warn(LINKEDIN_RISK.join("\n"));
      const accept = await p.confirm({
        message: "I have read this and I accept the risk to my LinkedIn account.",
        initialValue: false,
      });
      if (cancelled(accept)) bail();
      const r = turnOnLinkedIn(config, { acceptRisk: accept });
      if (r.ok) {
        Object.assign(config, r.config);
        p.log.success("LinkedIn mode is on (5 a day). Turn it off any time in Settings.");
      } else p.log.info("Left off.");
    }
  }

  // Recruiter messages: only with LinkedIn mode on, as a separate yes. A no is remembered.
  const msg = config.linkedin.messages;
  if (interactive && linkedInEnabled(config) && !msg.acceptedAt && !msg.declinedAt) {
    p.log.warn(MESSAGE_RISK.join("\n"));
    const yes = await p.confirm({ message: MESSAGE_QUESTION, initialValue: false });
    if (cancelled(yes)) bail();
    const r = yes ? turnOnMessages(config, { accept: true }) : undefined;
    if (r?.ok) {
      Object.assign(config, r.config);
      p.log.success(
        "Recruiter messages are on (3 a day, your OK on the first 10). Turn them off in Settings.",
      );
    } else Object.assign(config, declineMessages(config));
  }

  // Email applications: off unless you say yes. A no is remembered, and then no mail is ever sent.
  if (interactive && !config.email.acceptedAt && !config.email.declinedAt) {
    p.log.message(EXPLAIN.email);
    const yes = await p.confirm({ message: EMAIL_QUESTION, initialValue: false });
    if (cancelled(yes)) bail();
    if (!yes) Object.assign(config, declineEmail(config));
    else {
      p.log.warn(EMAIL_RISK.join("\n"));
      Object.assign(config, turnOnEmail(config, { accept: true }));
      await askEmailSetup(config, dirs);
    }
  }

  saveConfig(config, dirs);

  // Running on its own: the dashboard at login and the runs at the scheduled times. Yes unless you say no.
  const cli = fileURLToPath(new URL("./index.js", import.meta.url));
  const protectedFolder = process.platform === "darwin" ? macProtectedFolder(cli) : undefined;
  // Asked once: the answer is remembered (config autoStart), and Settings or `schedule on|off` change it.
  if (interactive && config.autoStart === undefined) {
    p.log.message(`${EXPLAIN.autoStart} Times now: ${config.schedule.join(", ")}.`);
    if (protectedFolder)
      p.log.warn(
        `QuietApply is in ~/${protectedFolder}, which macOS does not let background jobs read. Move the folder (for example to ~/code/quietapply) to run automatically; until then, say no here.`,
      );
    const yes = await p.confirm({
      message: "Run automatically while your computer is on?",
      initialValue: config.autoStart ?? !protectedFolder,
    });
    if (cancelled(yes)) bail();
    const r = setAutoStart(dirs, cli, yes);
    if (yes) (r.ok ? p.log.success : p.log.warn)(r.message);
    else
      p.log.info(
        "Not running automatically. Use Run now, or turn it on later in Settings or with `quietapply schedule on`.",
      );
    Object.assign(config, loadConfig(dirs));
  } else if (!scheduleState().runs) {
    p.log.info("To run automatically while your computer is on: `quietapply schedule on` (or Settings).");
  }

  const gaps = setupGaps(db, loadProfile(dirs), config);
  if (gaps.length)
    p.log.warn(
      [
        "Still missing, so real forms will stop and wait for you:",
        ...gaps.map((g) => `- ${g}`),
        interactive
          ? "Run `quietapply init` again to add them (it asks only what is missing), or use the dashboard."
          : "Run `quietapply init` without --yes to answer them (it asks only what is missing).",
      ].join("\n"),
    );
  p.note(
    [
      "quietapply doctor        check the provider, browser and data folder",
      "quietapply discover      find open roles at your companies",
      "quietapply run           one run now (dry run: nothing is submitted)",
      "quietapply dashboard     http://127.0.0.1:4777 (a short tour opens the first time)",
      "quietapply schedule status   whether it runs automatically, and when",
    ].join("\n"),
    "Next",
  );
  p.outro(
    `Dry run is ON and the first ${config.limits.reviewFirst} applications wait for your OK. Change both in Settings.`,
  );
}

/** The address, mail server and app password for email applications. Each can be finished later in Settings. */
async function askEmailSetup(config: Config, dirs: ReturnType<typeof paths>): Promise<void> {
  const from = await p.text({
    message: "Your email address (applications are sent from it)",
    initialValue: loadProfile(dirs).email,
    validate: (v) => (cleanAddress(v) ? undefined : "That is not an email address"),
  });
  if (cancelled(from)) bail();
  const address = cleanAddress(from)!;
  const preset = smtpPreset(address);
  let host = preset?.host;
  if (!host) {
    const h = await p.text({ message: "Your mail server (SMTP host)", placeholder: "smtp.example.com" });
    if (cancelled(h)) bail();
    host = h.trim() || undefined;
  }
  config.email = {
    ...config.email,
    from: address,
    smtp: {
      ...config.email.smtp,
      host,
      port: preset?.port ?? 587,
      secure: preset?.secure ?? false,
      user: address,
    },
  };
  const pw = await p.password({
    message:
      "App password (made in your mail account's security settings, not your normal password). Empty to add it later",
  });
  if (cancelled(pw)) bail();
  if (pw) {
    try {
      const where = savePassword(dirs, address, pw);
      p.log.success(
        `App password stored (${where === "file" ? "in a file only you can read" : "in your keychain"}).`,
      );
    } catch (err) {
      p.log.warn(`Could not store the password: ${(err as Error).message}. Add it in Settings.`);
    }
  }
}

/** Name, email, phone and city: they go into every form, so they are checked by you, not guessed. */
async function askContact(profile: Profile, dirs: ReturnType<typeof paths>): Promise<void> {
  p.log.message(EXPLAIN.contact);
  const fixes = await p.group(
    {
      name: () => p.text({ message: "Full name", initialValue: profile.name }),
      email: () => p.text({ message: "Email for applications", initialValue: profile.email }),
      phone: () => p.text({ message: "Phone (with country code)", initialValue: profile.phone }),
      location: () =>
        p.text({
          message: "City, country",
          placeholder: "for example: Berlin, Germany",
          initialValue: profile.location,
        }),
    },
    { onCancel: bail },
  );
  Object.assign(profile, fixes);
  saveProfile(profile, dirs);
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

/** "~/resume.pdf" or "~\resume.pdf". homedir() reads USERPROFILE on Windows, where HOME is usually unset. */
export function expandHome(f: string, home = homedir()): string {
  return /^~[\\/]/.test(f) ? join(home, f.slice(2)) : f;
}
