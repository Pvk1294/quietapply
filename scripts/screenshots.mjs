// Takes the README/docs screenshots from the demo dashboard (fake persona, fixture data only).
// Usage: npm run build && node dist/cli/index.js demo --port 4790 &  then  node scripts/screenshots.mjs
// Uses a fresh, temporary browser profile; set CHROME_PATH to pick the browser binary.
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.env.QA_URL ?? "http://127.0.0.1:4790";
const out = new URL("../docs/screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const executablePath = candidates.find((c) => existsSync(c));

const browser = await chromium.launch({ executablePath, headless: true });
const shots = [
  { name: "today", hash: "#/today" },
  { name: "questions", hash: "#/questions" },
  { name: "applications", hash: "#/applications" },
  { name: "application-detail", hash: "#/applications?open=6" },
  { name: "memory", hash: "#/memory" },
  { name: "handoff", hash: "#/handoff" },
  { name: "settings", hash: "#/settings" },
];
for (const [suffix, viewport, scheme] of [
  ["desktop", { width: 1360, height: 860 }, "light"],
  ["mobile", { width: 390, height: 844 }, "light"],
  ["dark", { width: 1360, height: 860 }, "dark"],
]) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await context.newPage();
  for (const s of shots) {
    if (suffix === "dark" && s.name !== "today") continue;
    await page.goto(`${base}/${s.hash}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}${s.name}-${suffix}.png` });
  }
  await context.close();
}
await browser.close();
console.log(`Saved screenshots to ${out}`);
