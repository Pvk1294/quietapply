import { existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { type Paths, paths } from "./paths.js";

export const ProviderId = z.enum(["claude-code", "codex", "fake"]);
export type ProviderId = z.infer<typeof ProviderId>;

export const BrowserMode = z.enum(["playwright-profile", "playwright-extension", "claude-in-chrome"]);
export type BrowserMode = z.infer<typeof BrowserMode>;

export const Company = z.object({
  name: z.string(),
  ats: z.enum(["greenhouse", "lever", "ashby"]),
  /** Board token / company slug used by the public job API, e.g. "acme" for boards.greenhouse.io/acme. */
  token: z.string(),
});
export type Company = z.infer<typeof Company>;

export const Rules = z.object({
  /** Job titles must contain at least one of these (case-insensitive). Empty = any title. */
  roles: z.array(z.string()).default([]),
  /** Titles containing any of these are skipped (e.g. "Senior Staff", "Intern"). */
  excludeTitles: z.array(z.string()).default([]),
  /** Accepted locations; "remote" matches remote roles. Empty = any location. */
  locations: z.array(z.string()).default([]),
  /** Companies never to apply to (current employer, stealth list). */
  neverApply: z.array(z.string()).default([]),
  /** Minimum share of required skills (from the posting) you must have, 0..1. */
  minSkillMatch: z.number().min(0).max(1).default(0.5),
  experienceYears: z
    .object({ min: z.number().default(0), max: z.number().default(50) })
    .default({ min: 0, max: 50 }),
});
export type Rules = z.infer<typeof Rules>;

export const Config = z.object({
  version: z.literal(1).default(1),
  provider: ProviderId.default("claude-code"),
  auth: z.enum(["subscription", "api-key"]).default("subscription"),
  model: z.string().optional(),
  browser: BrowserMode.default("playwright-profile"),
  /** Run the Playwright browser without a window. Off by default so you can watch the first runs. */
  headless: z.boolean().default(false),
  /** Local run times, 24h "HH:MM". */
  schedule: z.array(z.string().regex(/^\d{2}:\d{2}$/)).default(["09:00", "13:00", "19:00"]),
  timezone: z.string().default("auto"),
  limits: z
    .object({
      perDay: z.number().int().min(0).default(15),
      perCompany30d: z.number().int().min(0).default(2),
      /** The first N applications stop before Submit and wait for your approval in the dashboard. */
      reviewFirst: z.number().int().min(0).default(10),
      runTimeoutMinutes: z.number().int().min(1).default(30),
    })
    .default({ perDay: 15, perCompany30d: 2, reviewFirst: 10, runTimeoutMinutes: 30 }),
  /** When true nothing is ever submitted: forms are filled and the run stops before Submit. */
  dryRun: z.boolean().default(true),
  sources: z
    .object({
      greenhouse: z.boolean().default(true),
      lever: z.boolean().default(true),
      ashby: z.boolean().default(true),
      linkedin: z.boolean().default(false),
    })
    .default({ greenhouse: true, lever: true, ashby: true, linkedin: false }),
  /**
   * LinkedIn mode (off by default; `sources.linkedin` is the switch). It drives your own logged-in browser
   * through Claude in Chrome, with its own small daily cap, and only after you accepted the risk.
   */
  linkedin: z
    .object({
      /** When you accepted the risk statement (ISO time). LinkedIn stays off without it. */
      acceptedAt: z.string().optional(),
      /** LinkedIn applications the agent may open per day, dry runs included. */
      perDay: z.number().int().min(1).max(15).default(5),
      /** Claude in Chrome deviceId to use when several browsers are connected to your Claude account. */
      chromeDevice: z.string().optional(),
    })
    .default({ perDay: 5 }),
  companies: z.array(Company).default([]),
  rules: Rules.default(Rules.parse({})),
  dashboard: z.object({ port: z.number().int().default(4777) }).default({ port: 4777 }),
});
export type Config = z.infer<typeof Config>;

export function defaultConfig(): Config {
  return Config.parse({});
}

export function loadConfig(p: Paths = paths()): Config {
  if (!existsSync(p.config)) return defaultConfig();
  const raw = YAML.parse(readFileSync(p.config, "utf8")) ?? {};
  const config = Config.parse(raw);
  // LinkedIn stays off unless you accepted the risk (the time is stored when you do).
  if (config.sources.linkedin && !config.linkedin.acceptedAt) config.sources.linkedin = false;
  return config;
}

export function saveConfig(config: Config, p: Paths = paths()): void {
  const header =
    "# QuietApply settings. Edit by hand or in the dashboard (Settings).\n" +
    "# dryRun: true means nothing is ever submitted. Turn it off only when you trust the setup.\n";
  writeFileSync(p.config, header + YAML.stringify(Config.parse(config)), { mode: 0o600 });
}
