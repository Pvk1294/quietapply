// One live dry run with your own Claude Code + Playwright MCP, with the fake persona Jane Doe (nothing real).
// Usage: npm run build && node scripts/live-dry-run.mjs [fixture.html | https://job-url "Company" "Title"]
// A fixture page is served on localhost; a real job URL is opened as is. Either way dry run is on, and the
// browser's network guard blocks every non-read request, so nothing is ever submitted or uploaded.
// Uses your Claude plan; takes one to five minutes.

import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const R = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const home = mkdtempSync(join(tmpdir(), "qa-live-"));
process.env.QUIETAPPLY_HOME = home;
const { Config, saveConfig } = await import(`${R}/dist/core/config.js`);
const { ensureHome, paths } = await import(`${R}/dist/core/paths.js`);
const { openDb } = await import(`${R}/dist/core/db.js`);
const { addApplication, getApplication, listQuestions } = await import(`${R}/dist/core/store.js`);
const { saveAnswer } = await import(`${R}/dist/memory/answers.js`);
const { saveProfile } = await import(`${R}/dist/memory/profile.js`);
const { DEMO_PROFILE } = await import(`${R}/dist/demo/seed.js`);
const { seedDefaults } = await import(`${R}/dist/cli/setup.js`);
const { detectAts } = await import(`${R}/dist/sources/detect.js`);
const { runOnce } = await import(`${R}/dist/runner/run.js`);

const target = process.argv[2] ?? "lever-globex-apply.html";
const real = /^https?:\/\//.test(target);
let srv;
let url = target;
if (!real) {
  srv = createServer((req, res) => {
    let body;
    try {
      body = readFileSync(join(R, "fixtures/ats", req.url.slice(1).split("?")[0]));
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  url = `http://127.0.0.1:${srv.address().port}/${target}`;
}
const p = ensureHome(paths(home));
saveConfig(
  Config.parse({
    provider: "claude-code",
    model: "sonnet",
    headless: true,
    dryRun: true,
    limits: { runTimeoutMinutes: 12 },
  }),
  p,
);
saveProfile(DEMO_PROFILE, p);
copyFileSync(join(R, "fixtures/persona/jane-doe-resume.txt"), join(p.resumeDir, "resume.txt"));
const db = openDb(p);
seedDefaults(db);
for (const [key, q, a] of [
  ["work_authorization", "Authorized to work?", "Yes"],
  ["sponsorship", "Need sponsorship?", "No"],
  ["notice_period", "Notice period?", "30 days"],
  ["relocation", "Willing to relocate?", "No"],
  ["data_consent", "Consent to data storage?", "Yes"],
  ["country", "Which country do you live in?", "United States"],
])
  saveAnswer(db, { key, question: q, answer: a, source: "setup" });
const id = addApplication(db, {
  company: real ? (process.argv[3] ?? detectAts(url)?.token ?? "Company") : "Globex Corporation",
  title: real ? (process.argv[4] ?? "Software Engineer") : "Backend Developer",
  url,
  ats: detectAts(url)?.ats ?? "lever",
}).id;
db.close();
console.log("home", home, "url", url);
const s = await runOnce({ p, dryRun: true, log: (l) => console.log(l) });
console.log(JSON.stringify(s, null, 2));
const db2 = openDb(p);
console.log(JSON.stringify(getApplication(db2, id), null, 2));
console.log(
  "questions",
  listQuestions(db2).map((q) => q.question),
);
const work = join(p.logsDir, `run-${s.runId}`, `app-${id}`);
const blocked = join(work, "blocked-requests.jsonl");
console.log(
  "blocked requests:",
  existsSync(blocked) ? readFileSync(blocked, "utf8").trim() || "none" : "none",
);
console.log("screenshots:", existsSync(work) ? readdirSync(work).filter((f) => f.endsWith(".png")) : []);
srv?.close();
