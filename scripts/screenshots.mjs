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
  // The first-run tour opens by itself; keep it out of the page shots (it has its own below).
  await context.addInitScript(() => localStorage.setItem("quietapply-tour-done", "1"));
  const page = await context.newPage();
  for (const s of shots) {
    if (suffix === "dark" && s.name !== "today") continue;
    await page.goto(`${base}/${s.hash}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}${s.name}-${suffix}.png` });
  }
  if (suffix !== "dark") {
    // The walkthrough, one picture per step (desktop), and the LinkedIn step on a phone.
    for (let n = 1; n <= 9; n++) {
      if (suffix === "mobile" && n !== 7) continue;
      await page.goto(`${base}/#/today?tour=${n}`);
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}tour-${n}${suffix === "mobile" ? "-mobile" : ""}.png` });
    }
    if (suffix === "desktop") {
      // LinkedIn mode: the plain-words risk step a user sees before it can be turned on.
      await page.goto(`${base}/#/settings`);
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: /Set up LinkedIn mode/ }).click();
      await page.waitForTimeout(400);
      await page.locator("#linkedin").scrollIntoViewIfNeeded();
      await page.locator("#linkedin").screenshot({ path: `${out}linkedin-risk.png` });
      await page.goto(`${base}/#/questions`);
      await page.waitForTimeout(400);
    }
  }
  await context.close();
}
await browser.close();
console.log(`Saved screenshots to ${out}`);
