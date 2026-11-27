import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { loadConfig } from "../core/config.js";
import { kvGet, kvSet, openDb } from "../core/db.js";
import { ensureHome, packageRoot, paths } from "../core/paths.js";
import { addApplication, listApplications, listQuestions } from "../core/store.js";
import { linkedInEnabled, linkedInJobUrl } from "../linkedin/mode.js";
import { Desk } from "../mcp/desk.js";
import { createDeskServer } from "../mcp/server.js";
import { loadProfile } from "../memory/profile.js";
import { answerQuestion } from "../memory/queue.js";
import { discover } from "../runner/discover.js";
import { isPaused, runOnce } from "../runner/run.js";
import { scheduleOn, scheduleState, scheduleStatusLines, setAutoStart } from "../scheduler/index.js";
import { dueSlot, retryDue } from "../scheduler/slots.js";
import { defaultFetcher } from "../sources/http.js";
import { doctor } from "./doctor.js";

const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string };
// The scheduler and the agent start the CLI through its entry file, which hides the SQLite warning first.
const cliPath = fileURLToPath(new URL("./index.js", import.meta.url));
const program = new Command();

program
  .name("quietapply")
  .description(
    "A job-application agent that runs on your own Claude Code or Codex, and asks before it guesses.",
  )
  .version(pkg.version);

program
  .command("init")
  .description("Set up: choose the AI, read your resume, answer the common questions once")
  .option("-r, --resume <file>", "resume file (PDF, DOCX or text)")
  .option("-p, --provider <id>", "claude-code, codex or fake")
  .option("-y, --yes", "no questions, accept defaults")
  .option("--full", "ask all standard questions, not only the essential ones")
  .action(async (o) => {
    const { init } = await import("./init.js");
    await init(o);
  });

program
  .command("doctor")
  .description("Check the provider, browser, profile and data folder")
  .action(async () => {
    const checks = await doctor();
    for (const c of checks)
      console.log(`${c.ok === true ? "✓" : c.ok === "warn" ? "!" : "✗"} ${c.name.padEnd(26)} ${c.detail}`);
    if (checks.some((c) => c.ok === false)) process.exitCode = 1;
  });

program
  .command("import <folder>")
  .description(
    "Bring in another tracker's data: profile, answers, past applications and targets (JSON, YAML or CSV; see docs/import.md)",
  )
  .option("--dry-run", "show what would be imported without writing anything")
  .action(async (folder: string, o: { dryRun?: boolean }) => {
    const { importFolder } = await import("../import/index.js");
    const p = ensureHome(paths());
    const db = openDb(p);
    const s = importFolder(db, p, folder, { dryRun: o.dryRun });
    db.close();
    const t = s.targets;
    console.log(
      [
        `${s.dryRun ? "Would import" : "Imported"} from ${s.label}:`,
        `  profile:      ${s.profile.updated.length ? s.profile.updated.join(", ") : "nothing"}`,
        `  answers:      ${s.answers.added} new, ${s.answers.updated} updated, ${s.answers.skipped} empty rows skipped`,
        `  applications: ${s.applications.imported} as already applied, ${s.applications.duplicates} already here, ${s.applications.notApplied} not sent (drafts), ${s.applications.invalid} without company or title`,
        `  targets:      +${t.roles} titles, +${t.excludeTitles} excluded words, +${t.locations} locations, +${t.neverApply} never-apply, +${t.companies} companies`,
        ...s.warnings.map((w) => `  note: ${w}`),
      ].join("\n"),
    );
  });

program
  .command("discover")
  .description("Find open roles at your companies through the public Greenhouse, Lever and Ashby APIs")
  .action(async () => {
    const p = ensureHome(paths());
    const db = openDb(p);
    const config = loadConfig(p);
    const s = await discover(db, config, loadProfile(p), defaultFetcher);
    console.log(
      `Found ${s.found} open roles, queued ${s.added} new (${s.alreadyKnown} already known, ${s.alreadyApplied} already applied to).`,
    );
    if (!config.rules.roles.length && s.added)
      console.log(
        "  Note: no job titles are set, so every role passed the title check. Add titles in Settings or `quietapply init`.",
      );
    for (const [reason, n] of Object.entries(s.skipped)) console.log(`  skipped ${n}: ${reason}`);
    for (const e of s.errors) console.log(`  error at ${e.company}: ${e.error}`);
  });

program
  .command("add <url>")
  .description(
    "Queue one job by URL; the title and company come from the job site's public API. mailto:<address> with --company and --title queues an email application",
  )
  .option("--company <name>", "company name (overrides the lookup)")
  .option("--title <title>", "job title (overrides the lookup)")
  .option("--no-fetch", "do not look the job up")
  .action(async (url: string, o: { company?: string; title?: string; fetch: boolean }) => {
    const li = linkedInJobUrl(url);
    if (li) {
      // LinkedIn pages are never fetched from here: only the agent looks, in your own browser.
      if (!linkedInEnabled(loadConfig()))
        throw new Error("LinkedIn mode is off. Turn it on in the dashboard (Settings) first.");
      const r = addApplication(openDb(ensureHome(paths())), {
        url: li,
        company: o.company ?? "LinkedIn job",
        title: o.title ?? `LinkedIn job ${li.match(/\d+/)?.[0]}`,
        ats: "linkedin",
        source: "linkedin",
      });
      console.log(r.created ? `Queued LinkedIn job #${r.id}.` : `Already in the list as #${r.id}.`);
      return;
    }
    const { addJob } = await import("./add.js");
    const p = ensureHome(paths());
    const db = openDb(p);
    const r = await addJob(db, url, defaultFetcher, { ...o, companies: loadConfig(p).companies });
    if (r.lookupError)
      console.log(`Could not look the job up (${r.lookupError}), so it was queued with what the URL says.`);
    const what = `${r.title} at ${r.company}${r.location ? ` (${r.location})` : ""}`;
    console.log(r.created ? `Queued #${r.id}: ${what}.` : `Already in the list as #${r.id}: ${what}.`);
  });

program
  .command("run")
  .description("One run now over the queued applications")
  .option("--dry-run", "fill forms but never submit (default while dryRun is on in config)")
  .option("--max <n>", "at most this many applications", Number)
  .option("--id <n>", "only this application", Number)
  .action(async (o: { dryRun?: boolean; max?: number; id?: number }) => {
    const s = await runOnce({
      dryRun: o.dryRun,
      max: o.max,
      applicationId: o.id,
      log: (l) => console.log(l),
    });
    console.log(`\n${s.status}: ${s.message}`);
    if (s.status === "failed") process.exitCode = 1;
  });

program
  .command("tick")
  .description("Called by the OS scheduler every 15 minutes: runs if a slot is due")
  .action(async () => {
    const p = ensureHome(paths());
    const config = loadConfig(p);
    const db = openDb(p);
    const last = JSON.parse(kvGet(db, "schedule:last") ?? "{}") as {
      slot?: string;
      status?: string;
      at?: string;
      retried?: string;
    };
    const now = new Date();
    const slot = dueSlot(now, config.schedule, last.slot, config.timezone) ?? retryDue(now, last);
    if (!slot || isPaused(p)) {
      db.close();
      return;
    }
    const retried = slot === last.slot ? slot : last.retried;
    kvSet(db, "schedule:last", JSON.stringify({ slot, status: "running", at: now.toISOString(), retried }));
    db.close();
    const s = await runOnce({ trigger: "schedule" });
    const db2 = openDb(p);
    const status = s.status === "failed" ? "failed" : "completed";
    kvSet(db2, "schedule:last", JSON.stringify({ slot, status, at: new Date().toISOString(), retried }));
    db2.close();
    console.log(`${new Date().toISOString()} ${slot} ${s.status}: ${s.message}`);
  });

program
  .command("schedule <action>")
  .description(
    "on | off | status: run automatically while your computer is on (the dashboard at login, and runs at the times in config.yaml)",
  )
  .option("--print", "show what would be installed without installing it")
  .action((action: string, o: { print?: boolean }) => {
    const p = ensureHome(paths());
    if (action === "on" && o.print) {
      const r = scheduleOn(p, cliPath, { dryRun: true, port: loadConfig(p).dashboard.port });
      console.log(`Would write ${r.files.join(", ")}:\n\n${r.message}`);
    } else if (action === "on" || action === "off") {
      const r = setAutoStart(p, cliPath, action === "on");
      console.log(r.message);
      if (!r.ok) process.exitCode = 1;
    } else if (action === "status") {
      const db = openDb(p);
      const last = JSON.parse(kvGet(db, "schedule:last") ?? "{}") as { slot?: string; status?: string };
      db.close();
      console.log(scheduleStatusLines(scheduleState(), loadConfig(p), last).join("\n"));
    } else throw new Error(`Unknown action "${action}". Use: quietapply schedule on | off | status`);
  });

program
  .command("pause")
  .description("Stop all runs until you resume")
  .action(() => {
    writeFileSync(ensureHome(paths()).pauseFlag, new Date().toISOString());
    console.log("Paused. A run in progress stops after its current application.");
  });

program
  .command("resume")
  .description("Allow runs again after pause")
  .action(() => {
    rmSync(paths().pauseFlag, { force: true });
    console.log("Resumed.");
  });

program
  .command("status")
  .description("Applications by status and open questions")
  .action(() => {
    const db = openDb(ensureHome(paths()));
    const apps = listApplications(db, { limit: 10_000 });
    const counts = apps.reduce<Record<string, number>>((a, x) => {
      a[x.status] = (a[x.status] ?? 0) + 1;
      return a;
    }, {});
    console.log(
      Object.entries(counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join("  ") || "No applications yet.",
    );
    const qs = listQuestions(db);
    if (qs.length) console.log(`\n${qs.length} open question(s):`);
    for (const q of qs) console.log(`  #${q.id} ${q.question}`);
    if (isPaused()) console.log("\nPAUSED");
  });

program
  .command("answer <id> <answer...>")
  .description("Answer a queued question from the terminal")
  .option("--company", "remember only for the company that asked")
  .action((id: string, words: string[], o: { company?: boolean }) => {
    const db = openDb(ensureHome(paths()));
    const r = answerQuestion(db, Number(id), {
      answer: words.join(" "),
      scope: o.company ? "company" : "global",
    });
    console.log(`Saved as mem:${r.memory.id}. ${r.released.length} application(s) queued again.`);
  });

program
  .command("dashboard")
  .description("Open the local dashboard (http://127.0.0.1:4777)")
  .option("--port <n>", "port", Number)
  .action(async (o: { port?: number }) => {
    const { startDashboard } = await import("../server/index.js");
    await startDashboard({ port: o.port });
  });

program
  .command("phone [action]")
  .description("Open the dashboard on your phone through Tailscale (tailnet only). `phone off` undoes it")
  .option("--port <n>", "dashboard port", Number)
  .action(async (action: string | undefined, o: { port?: number }) => {
    if (action && action !== "off")
      throw new Error(`Unknown action "${action}". Use: quietapply phone [off]`);
    const { phoneOff, phoneOn } = await import("./phone.js");
    const r = await (action === "off" ? phoneOff(o) : phoneOn(o));
    console.log(r.lines.join("\n"));
    if (!r.ok) process.exitCode = 1;
  });

program
  .command("demo")
  .description("Try everything with a fake persona and fixture pages, in a throwaway data folder")
  .option("--port <n>", "port", Number)
  .option("--no-serve", "only create the demo data")
  .action(async (o: { port?: number; serve: boolean }) => {
    const { createDemo } = await import("../demo/seed.js");
    const home = await createDemo();
    console.log(`Demo data in ${home} (fake persona Jane Doe, nothing real).`);
    if (o.serve) {
      const { startDashboard } = await import("../server/index.js");
      await startDashboard({ port: o.port });
    }
  });

program
  .command("mcp", { hidden: true })
  .description("Run the desk MCP server for one application (started by the agent)")
  .requiredOption("--application <id>", "application id", Number)
  .option("--dry-run")
  .action(async (o: { application: number; dryRun?: boolean }) => {
    const p = paths();
    const config = loadConfig(p);
    const db = openDb(p);
    const desk = new Desk(
      db,
      { ...config, dryRun: config.dryRun || !!o.dryRun },
      loadProfile(p),
      p,
      o.application,
      { runDir: process.env.QUIETAPPLY_RUN_DIR },
    );
    await createDeskServer(desk, pkg.version).connect(new StdioServerTransport());
  });

program.parseAsync().catch((err: Error) => {
  console.error(`quietapply: ${err.message}`);
  process.exit(1);
});
