// One live dry run with your own Claude Code + Playwright MCP on a local fixture page (fake persona, nothing real).
// Usage: npm run build && node scripts/live-dry-run.mjs [fixture.html]   (uses your Claude plan; takes about a minute)
// Codex instead: QUIETAPPLY_PROVIDER=codex node scripts/live-dry-run.mjs

import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
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
const { runOnce } = await import(`${R}/dist/runner/run.js`);
const fixtureName = process.argv[2] ?? "lever-globex-apply.html";
const srv = createServer((req, res) => {
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
const url = `http://127.0.0.1:${srv.address().port}/${fixtureName}`;
const p = ensureHome(paths(home));
saveConfig(
  Config.parse({
    provider: process.env.QUIETAPPLY_PROVIDER ?? "claude-code",
    model: (process.env.QUIETAPPLY_PROVIDER ?? "claude-code") === "claude-code" ? "sonnet" : undefined,
    headless: true,
    dryRun: true,
    limits: { runTimeoutMinutes: 10 },
  }),
  p,
);
saveProfile(DEMO_PROFILE, p);
copyFileSync(join(R, "fixtures/persona/jane-doe-resume.txt"), join(p.resumeDir, "resume.txt"));
const db = openDb(p);
for (const [key, q, a] of [
  ["work_authorization", "Authorized to work?", "Yes"],
  ["sponsorship", "Need sponsorship?", "No"],
  ["notice_period", "Notice period?", "30 days"],
  ["relocation", "Willing to relocate?", "No"],
  ["data_consent", "Consent to data storage?", "Yes"],
])
  saveAnswer(db, { key, question: q, answer: a, source: "setup" });
const id = addApplication(db, {
  company: "Globex Corporation",
  title: "Backend Developer",
  url,
  ats: "lever",
}).id;
db.close();
console.log("home", home, "url", url);
const s = await runOnce({ p, log: (l) => console.log(l) });
console.log(JSON.stringify(s, null, 2));
const db2 = openDb(p);
console.log(JSON.stringify(getApplication(db2, id), null, 2));
console.log(
  "questions",
  listQuestions(db2).map((q) => q.question),
);
srv.close();
