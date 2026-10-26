import type { BrowserMode, ProviderId } from "../../../core/config.js";
import type { Detection } from "../../../providers/types.js";
import type { Step, WizardContext } from "../context.js";

export const INSTALL_HELP = [
  "Claude Code (needs a Claude Pro/Max plan or an Anthropic API key):",
  "  curl -fsSL https://claude.ai/install.sh | bash",
  "  (Windows PowerShell: irm https://claude.ai/install.ps1 | iex)",
  "",
  "OpenAI Codex (needs a ChatGPT plan or an OpenAI API key):",
  "  npm install -g @openai/codex",
].join("\n");

export const LOGIN_HELP: Record<"claude-code" | "codex", string> = {
  "claude-code": [
    "Open a new terminal, run  claude  and follow the browser sign-in with your Claude plan.",
    "Or use an API key: export ANTHROPIC_API_KEY=... (usage is billed to that key).",
  ].join("\n"),
  codex: [
    "Run  codex login  and choose Sign in with ChatGPT.",
    "Or use an API key: export CODEX_API_KEY=... (usage is billed to that key).",
  ].join("\n"),
};

function describe(d: Detection): string {
  if (!d.installed) return "not installed";
  const login =
    d.loggedIn === false
      ? "not signed in"
      : d.authMethod === "subscription"
        ? "signed in with your plan"
        : d.authMethod === "api-key"
          ? "using an API key"
          : "installed";
  return `${d.version ?? "installed"} · ${login}`;
}

async function detectBoth(ctx: WizardContext) {
  const { providers } = ctx.deps;
  return ctx.ui.spin(
    "Looking for Claude Code and Codex",
    async () => {
      const [cc, cx] = await Promise.all([providers["claude-code"].detect(), providers.codex.detect()]);
      return { "claude-code": cc, codex: cx };
    },
    (r) => `Claude Code: ${describe(r["claude-code"])}   Codex: ${describe(r.codex)}`,
  );
}

/** Step 1: which AI runs the applications, and is it signed in. */
export const aiStep: Step = {
  id: "ai",
  title: "Your AI",
  async run(ctx) {
    const { ui, config } = ctx;
    ui.info("QuietApply runs on the Claude Code or Codex you already have: your plan or your API key.");
    let found = await detectBoth(ctx);

    while (!found["claude-code"].installed && !found.codex.installed && !ctx.opts.provider) {
      ui.note(INSTALL_HELP, "Install one of these");
      const next = await ui.select({
        message: "Neither Claude Code nor Codex is installed yet.",
        initial: ui.interactive ? "again" : "demo",
        options: [
          { value: "again", label: "I installed one: check again" },
          {
            value: "demo",
            label: "Continue without an AI for now",
            hint: "the demo agent; nothing is applied",
          },
        ],
      });
      if (next === "demo") break;
      found = await detectBoth(ctx);
    }

    const installed = (["claude-code", "codex"] as const).filter((id) => found[id].installed);
    let provider: ProviderId =
      ctx.opts.provider ??
      (installed.includes(config.provider as "claude-code") ? config.provider : (installed[0] ?? "fake"));
    if (!ctx.opts.provider && installed.length) {
      provider = await ui.select<ProviderId>({
        message: "Which AI should run the applications?",
        initial: provider,
        options: [
          { value: "claude-code", label: "Claude Code", hint: describe(found["claude-code"]) },
          { value: "codex", label: "OpenAI Codex", hint: describe(found.codex) },
          { value: "fake", label: "None yet", hint: "the built-in demo agent" },
        ].filter((o) => o.value === "fake" || found[o.value as "claude-code" | "codex"].installed) as {
          value: ProviderId;
          label: string;
          hint: string;
        }[],
      });
    }
    config.provider = provider;
    if (provider === "fake") {
      ui.warn(
        "No AI chosen. You can still try everything with `quietapply demo`; run `quietapply init` again later.",
      );
      return;
    }

    // Signed in? Explain how, and let them check again without leaving the wizard.
    let det = found[provider];
    while (det.loggedIn === false) {
      ui.note(LOGIN_HELP[provider], `${provider === "codex" ? "Codex" : "Claude Code"} is not signed in`);
      const next = await ui.select({
        message: "Sign in, then come back here.",
        initial: ui.interactive ? "again" : "later",
        options: [
          { value: "again", label: "I signed in: check again" },
          { value: "later", label: "Continue; I'll sign in later", hint: "runs fail until you do" },
        ],
      });
      if (next === "later") break;
      det = await ctx.ui.spin("Checking the sign-in", () => ctx.deps.providers[provider].detect(), describe);
    }
    config.auth = det.authMethod === "api-key" ? "api-key" : "subscription";
    if (det.loggedIn !== false)
      ui.success(
        config.auth === "api-key"
          ? "Using an API key: applications are billed to that key."
          : "Signed in with your plan: applications use your plan's usage.",
      );

    if (provider === "claude-code" && config.auth === "subscription") {
      config.browser = await ui.select<BrowserMode>({
        message: "Which browser should the agent drive?",
        initial: config.browser,
        options: [
          { value: "playwright-profile", label: "QuietApply's own Chrome profile", hint: "recommended" },
          { value: "playwright-extension", label: "Your running Chrome or Edge (Playwright extension)" },
          { value: "claude-in-chrome", label: "Claude in Chrome", hint: "Claude plans only" },
        ],
      });
    } else if (config.browser === "claude-in-chrome") {
      config.browser = "playwright-profile";
    }
  },
};
