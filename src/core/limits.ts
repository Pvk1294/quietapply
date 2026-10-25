import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { countEverSubmitted, countSubmittedSince } from "./store.js";

export function startOfToday(d = new Date()): string {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s.toISOString();
}

export function daysAgo(n: number, d = new Date()): string {
  return new Date(d.getTime() - n * 86_400_000).toISOString();
}

export interface Allowance {
  /** How many more applications may be submitted today. */
  remainingToday: number;
  /** True while the first N applications still need your OK before Submit. */
  reviewMode: boolean;
}

export function allowance(db: DB, config: Config, at = new Date()): Allowance {
  const today = countSubmittedSince(db, startOfToday(at));
  return {
    remainingToday: Math.max(0, config.limits.perDay - today),
    reviewMode: countEverSubmitted(db) < config.limits.reviewFirst,
  };
}

export function companyAllowed(db: DB, config: Config, company: string, at = new Date()): boolean {
  return countSubmittedSince(db, daysAgo(30, at), company) < config.limits.perCompany30d;
}
