import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { formShotPath, mcpServers } from "../src/runner/run.js";
import { fixture } from "./helpers/fixtures.js";
import { makeHome } from "./helpers/home.js";

type Page = import("playwright-core").Page;
const require = createRequire(import.meta.url);
const shot = require("../browser/form-shot.cjs") as {
  MAX_FALLBACK_HEIGHT: number;
  cropScreenshot: (
    page: Page,
    original: Page["screenshot"],
    options?: object,
  ) => Promise<{ data: Buffer; kind: string }>;
  default: (a: { page: Page }) => Promise<void>;
};

const png = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

/** The posting text above the form, as on a real job page: the page is far taller than the form. */
const withLongDescription = (html: string) =>
  html.replace(
    /<body[^>]*>/i,
    (m) => `${m}<div id="description" style="height:4500px;background:#eee">Job description</div>`,
  );

let browser: import("playwright-core").Browser | undefined;
let page: Page;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  } catch {
    browser = undefined; // no browser installed here (for example on CI): these tests are skipped
  }
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const forms: [string, string][] = [
  ["Greenhouse", "greenhouse-hooli-real-form.html"],
  ["Lever", "lever-vandelay-real-form.html"],
  ["Ashby", "ashby-pendant-real-form.html"],
];

describe("form-only screenshots", () => {
  for (const [ats, file] of forms) {
    it(`crops a real ${ats} form to the form, not the whole page`, async (ctx) => {
      if (!browser) return ctx.skip();
      await page.setContent(withLongDescription(fixture(file)));
      const full = png(await page.screenshot({ fullPage: true }));
      expect(full.height).toBeGreaterThan(4500);
      const r = await shot.cropScreenshot(page, page.screenshot.bind(page), { fullPage: true });
      expect(r.kind).toBe("form");
      const { height } = png(r.data);
      expect(height).toBeGreaterThan(200);
      expect(height).toBeLessThan(full.height - 4000); // the 4,500 px description is gone
    });
  }

  it("falls back to a viewport shot capped at 2,000 px when there is no form", async (ctx) => {
    if (!browser) return ctx.skip();
    await page.setContent(
      '<body><h1>Thanks for applying</h1><div style="height:9000px">Long description</div></body>',
    );
    await page.setViewportSize({ width: 1000, height: 3000 });
    const r = await shot.cropScreenshot(page, page.screenshot.bind(page), { fullPage: true });
    await page.setViewportSize({ width: 1000, height: 800 });
    expect(r.kind).toBe("viewport");
    expect(png(r.data).height).toBe(shot.MAX_FALLBACK_HEIGHT);
  });

  it("does not take a search box for the application form", async (ctx) => {
    if (!browser) return ctx.skip();
    await page.setContent(
      '<body><form><input name="q"></form><div style="height:3000px">posting</div></body>',
    );
    const r = await shot.cropScreenshot(page, page.screenshot.bind(page), { fullPage: true });
    expect(r.kind).toBe("viewport");
    expect(png(r.data).height).toBeLessThanOrEqual(800);
  });

  it("replaces page.screenshot once per page, and leaves a clip the agent chose alone", async (ctx) => {
    if (!browser) return ctx.skip();
    await page.setContent(withLongDescription(fixture("greenhouse-hooli-real-form.html")));
    const raw = page.screenshot.bind(page);
    await shot.default({ page });
    const patched = page.screenshot;
    await shot.default({ page });
    expect(page.screenshot).toBe(patched);
    const cropped = png(await page.screenshot({ fullPage: true }));
    expect(cropped.height).toBeLessThan(4000);
    const clip = png(await page.screenshot({ clip: { x: 0, y: 0, width: 50, height: 60 } }));
    expect(clip).toEqual({ width: 50, height: 60 });
    page.screenshot = raw;
  });
});

describe("form-only screenshots in the run setup", () => {
  it("loads the cropper into Playwright in every run, live or dry", () => {
    const p = makeHome({ provider: "claude-code" });
    const config = loadConfig(p);
    for (const dry of [true, false]) {
      const args = mcpServers(config, p, 1, dry, "/tmp/run-1/app-1").playwright!.args!;
      const i = args.indexOf(formShotPath());
      expect(args[i - 1]).toBe("--init-page");
    }
  });
});
