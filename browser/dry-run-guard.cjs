// Dry-run network guard, loaded into Playwright MCP with --init-page while dry run is on.
// It stops the browser from sending anything: every request that is not a plain read (GET, HEAD, OPTIONS)
// is aborted before it leaves the machine, so even a stray click on Submit cannot apply. The one exception
// is Ashby, whose job pages load their content through read-only GraphQL POSTs; mutations stay blocked.
// Each blocked request is appended to QUIETAPPLY_GUARD_LOG (one JSON line) so the run can show it.
const { appendFileSync } = require("node:fs");

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ASHBY_GRAPHQL = /^https:\/\/jobs\.ashbyhq\.com\/api\/non-user-graphql/;
const WRITE_OP = /submit|upload|parse|create|update|apply|file|track|log|record|consent|send/i;

/** Whether a request must be blocked in dry run. */
function shouldBlock(method, url, postData) {
  if (READ_METHODS.has(String(method).toUpperCase())) return false;
  if (ASHBY_GRAPHQL.test(url)) {
    let op = "";
    try {
      op = new URL(url).searchParams.get("op") ?? "";
    } catch {}
    if (!op) {
      try {
        op = JSON.parse(postData ?? "{}").operationName ?? "";
      } catch {}
    }
    const isQuery = /^\s*(query\b|\{)/.test(graphqlText(postData));
    return !op || WRITE_OP.test(op) || !isQuery;
  }
  return true;
}

function graphqlText(postData) {
  try {
    return JSON.parse(postData ?? "{}").query ?? "";
  } catch {
    return "";
  }
}

const guarded = new WeakSet();

module.exports = {
  shouldBlock,
  default: async ({ page }) => {
    const context = page.context();
    if (guarded.has(context)) return;
    guarded.add(context);
    await context.route("**/*", (route) => {
      const req = route.request();
      if (!shouldBlock(req.method(), req.url(), req.postData())) return route.fallback();
      const log = process.env.QUIETAPPLY_GUARD_LOG;
      if (log) {
        try {
          const line = { at: new Date().toISOString(), method: req.method(), url: req.url().slice(0, 300) };
          appendFileSync(log, `${JSON.stringify(line)}\n`);
        } catch {}
      }
      return route.abort("blockedbyclient");
    });
  },
};
