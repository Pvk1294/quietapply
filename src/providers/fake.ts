import type { AgentRunResult, Detection, Provider } from "./types.js";

/**
 * A provider that needs no AI: `complete` returns nothing (so init uses the rule-based resume parser) and
 * `runAgent` is replaced by the scripted agent in runner/scripted-agent.ts. Used by tests, the demo and
 * `run --provider fake` to try the whole flow on fixture pages.
 */
export const fake: Provider = {
  id: "fake",
  label: "Fake (no AI, for tests and demos)",
  async detect(): Promise<Detection> {
    return { installed: true, version: "builtin", loggedIn: true, authMethod: "unknown", notes: [] };
  },
  async complete() {
    return "";
  },
  async runAgent(): Promise<AgentRunResult> {
    throw new Error("The fake provider runs through the scripted agent");
  },
};
