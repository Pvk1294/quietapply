import type { BrowserMode, ProviderId } from "../core/config.js";

export interface Detection {
  installed: boolean;
  version?: string;
  /** true / false when the CLI can tell us, undefined when it cannot. */
  loggedIn?: boolean;
  authMethod?: "subscription" | "api-key" | "unknown";
  notes: string[];
}

export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentRunOptions {
  prompt: string;
  /** MCP servers the agent may use, by name: always "desk", plus "playwright" unless using Claude in Chrome. */
  mcpServers: Record<string, McpServerSpec>;
  browser: BrowserMode;
  /** A LinkedIn run: Claude in Chrome with only the look/click/type tools (no page scripts or network reads). */
  linkedin?: boolean;
  /**
   * Set for Claude in Chrome runs in dry run or review mode (no network guard there): the run folder, where the
   * tool-level hook (browser/chrome-guard.cjs) reads the desk's submit lock and logs what it refuses.
   */
  chromeGuardDir?: string;
  cwd: string;
  timeoutMs: number;
  logPath: string;
  model?: string;
}

export type AgentRunStatus = "completed" | "failed" | "usage_limit" | "timed_out";

export interface AgentRunResult {
  status: AgentRunStatus;
  /** The agent's final message (its own short report of the run). */
  text: string;
  exitCode: number | null;
}

export interface Provider {
  id: ProviderId;
  label: string;
  detect(): Promise<Detection>;
  /** One prompt in, text out, no tools. Used by `init` to structure a resume. */
  complete(prompt: string, opts?: { timeoutMs?: number; model?: string }): Promise<string>;
  /** Run the agent on one application with the given MCP servers. */
  runAgent(opts: AgentRunOptions): Promise<AgentRunResult>;
}

/** Messages the CLIs print when a subscription or API usage limit is reached. */
export const USAGE_LIMIT_RE =
  /(usage limit|hit your (\w+ )?limit|out of (extra )?usage|rate limit reached|quota exceeded|insufficient_quota|limit will reset)/i;
