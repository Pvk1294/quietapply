// Form-only screenshots, loaded into Playwright MCP with --init-page in every run (dry or live).
// When the agent asks for a page screenshot (viewport or full page), this crops it in code:
//   1. the application form element (known ATS containers first, then the best <form>) is photographed alone;
//   2. if no form is on the page (for example the confirmation after Submit), a viewport shot capped at
//      MAX_FALLBACK_HEIGHT pixels is taken instead, so a long job description never fills the picture.
// Element screenshots the agent asks for itself pass through untouched.

const MAX_FALLBACK_HEIGHT = 2000;
const MIN_FORM_HEIGHT = 120;

/** Known containers of the application form, most specific first. */
const FORM_SELECTORS = [
  "form#application-form", // Greenhouse (hosted and embedded) and Lever
  "form#application_form", // older Greenhouse boards
  "form.application-form",
  ".ashby-application-form-container", // Ashby
];

/**
 * Runs inside the page: the element that holds the application form, or null.
 * Never matches a search or login box: a form needs at least two fields to count.
 */
function locateForm({ selectors, minHeight }) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 100 && r.height >= minHeight;
  };
  const fields = (el) => el.querySelectorAll("input:not([type=hidden]), textarea, select").length;
  for (const sel of selectors) {
    const el = [...document.querySelectorAll(sel)].find((e) => visible(e) && fields(e) >= 2);
    if (el) return el;
  }
  // Ashby renders its form as plain divs: the closest common ancestor of the field entries.
  const entries = [...document.querySelectorAll(".ashby-application-form-field-entry")];
  if (entries.length >= 2) {
    let node = entries[0].parentElement;
    while (node && !entries.every((e) => node.contains(e))) node = node.parentElement;
    if (node && node !== document.body && visible(node)) return node;
  }
  // Any other site: the <form> with the most fields.
  let best = null;
  let bestFields = 1;
  for (const form of document.querySelectorAll("form")) {
    const n = fields(form);
    if (n > bestFields && visible(form)) {
      best = form;
      bestFields = n;
    }
  }
  return best;
}

/** Playwright's `page.screenshot` options that also make sense for an element screenshot. */
function elementOptions(options) {
  const { fullPage: _fullPage, clip: _clip, ...rest } = options ?? {};
  return rest;
}

/** The viewport shot used when no form is on the page: at most MAX_FALLBACK_HEIGHT pixels tall. */
async function viewportShot(page, original, options) {
  const { fullPage: _fullPage, ...rest } = options ?? {};
  const size =
    page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  return original({
    ...rest,
    fullPage: false,
    clip: { x: 0, y: 0, width: size.width, height: Math.min(size.height, MAX_FALLBACK_HEIGHT) },
  });
}

/** What kind of picture a screenshot call became: "form" or "viewport". Exposed for the logs and tests. */
async function cropScreenshot(page, original, options) {
  // The agent chose a region itself, or wants the raw page: leave it alone.
  if (options?.clip || options?.mask) return { data: await original(options), kind: "as-is" };
  try {
    const handle = await page.evaluateHandle(locateForm, {
      selectors: FORM_SELECTORS,
      minHeight: MIN_FORM_HEIGHT,
    });
    const element = handle.asElement();
    if (element) {
      await element.scrollIntoViewIfNeeded().catch(() => {});
      return { data: await element.screenshot(elementOptions(options)), kind: "form" };
    }
    await handle.dispose().catch(() => {});
  } catch {
    // fall through to the viewport shot
  }
  return { data: await viewportShot(page, original, options), kind: "viewport" };
}

const patched = new WeakSet();

module.exports = {
  FORM_SELECTORS,
  MAX_FALLBACK_HEIGHT,
  locateForm,
  cropScreenshot,
  default: async ({ page }) => {
    if (patched.has(page)) return;
    patched.add(page);
    const original = page.screenshot.bind(page);
    page.screenshot = async (options) => (await cropScreenshot(page, original, options)).data;
  },
};
