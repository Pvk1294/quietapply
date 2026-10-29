import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageRoot, paths } from "../src/core/paths.js";
import { createDemo } from "../src/demo/seed.js";
import { createApp } from "../src/server/app.js";

/**
 * The dashboard on a 390 px phone screen, with the demo data: no page may scroll sideways. Needs the built
 * dashboard (npm run build) and a Chromium or Chrome; skipped without them.
 */
const built = existsSync(join(packageRoot(), "dist", "web", "index.html"));

let browser: import("playwright-core").Browser | undefined;
let server: ReturnType<typeof serve> | undefined;
let base = "";
const home = process.env.QUIETAPPLY_HOME;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

beforeAll(async () => {
  if (!built) return;
  const { chromium } = await import("playwright-core");
  browser = await chromium
    .launch()
    .catch(() => chromium.launch({ channel: "chrome" }).catch(() => undefined));
  if (!browser) return; // no browser installed here (for example on CI)
  const p = paths(await createDemo(mkdtempSync(join(tmpdir(), "qa-mobile-"))));
  const port = await freePort();
  server = serve({ fetch: createApp({ p, port }).fetch, hostname: "127.0.0.1", port });
  base = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  if (home === undefined) delete process.env.QUIETAPPLY_HOME;
  else process.env.QUIETAPPLY_HOME = home;
});

describe("dashboard on a phone (390 px)", () => {
  it("no page scrolls sideways, the tour and its banner fit, and every page is in the tab bar or More", async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const width = () => page.evaluate<number>("document.documentElement.scrollWidth");
    await page.addInitScript(() => localStorage.setItem("quietapply-tour-done", "1"));
    for (const route of ["today", "applications", "questions", "handoff", "memory", "runs", "settings"]) {
      await page.goto(`${base}/#/${route}`);
      await page.waitForSelector(".topbar h1");
      await page.waitForTimeout(300);
      expect(await width(), route).toBeLessThanOrEqual(390);
    }
    // Finish yourself is a tab, the rest is under More.
    await expect(page.locator(".tabbar a[href='#/handoff']").count()).resolves.toBe(1);
    await page.locator(".tabbar button", { hasText: "More" }).click();
    for (const route of ["memory", "runs", "settings"])
      await expect(page.locator(`.more-menu a[href='#/${route}']`).count()).resolves.toBe(1);

    await page.goto(`${base}/#/today?tour=2`);
    await page.reload();
    const tour = await page.locator(".tour").boundingBox();
    expect(tour && tour.x >= 0 && tour.x + tour.width <= 390).toBe(true);
    await page.getByRole("link", { name: /See your settings/ }).click();
    const banner = await page.locator(".tour-banner").boundingBox();
    expect(banner && banner.x >= 0 && banner.x + banner.width <= 390).toBe(true);
    expect(await width()).toBeLessThanOrEqual(390);
    await page.close();
  }, 60_000);
});
