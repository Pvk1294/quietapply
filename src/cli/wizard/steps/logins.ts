import type { Step, WizardContext } from "../context.js";

export function loginsNote(browserProfile: string): string {
  return [
    "• Greenhouse, Lever and Ashby need no account or login: QuietApply fills the company's public form.",
    `• It drives its own Chrome profile (${browserProfile}), never your everyday browser,`,
    "  so your cookies, passwords and open tabs are not touched.",
    "• QuietApply never asks for or stores passwords. A site that wants an account goes to",
    '  "Finish yourself" in the dashboard instead.',
    "• Coming in v0.2: accounts for Workday-style sites (ones you create, kept in your OS keychain) and",
    "  read-only inbox reply tracking.",
  ].join("\n");
}

/** Step 6: logins, explained. Nothing is asked for and nothing is stored. */
export const loginsStep: Step = {
  id: "logins",
  title: "Logins",
  async run(ctx: WizardContext) {
    ctx.ui.note(loginsNote(ctx.dirs.browserProfile), "Logins: none needed");
    if (ctx.ui.interactive) await ctx.ui.confirm({ message: "Got it?", initial: true });
  },
};
