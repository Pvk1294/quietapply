import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Company, Config } from "../core/config.js";
import { packageRoot } from "../core/paths.js";
import { norm } from "../core/text.js";
import type { Ats } from "../sources/detect.js";
import { FUNCTIONS, functionOf, type JobFunction } from "./probe.js";
import { type Region, regionsForPlaces } from "./regions.js";

export interface StarterCompany {
  name: string;
  ats: Ats;
  token: string;
  regions: Region[];
  industry: string;
  size: "startup" | "scaleup" | "large";
  functions: JobFunction[];
  /** Open jobs when the list was last checked. */
  jobs: number;
}

export const INDUSTRIES: { id: string; label: string }[] = [
  { id: "ai", label: "AI" },
  { id: "devtools", label: "Developer tools" },
  { id: "infra", label: "Cloud & infrastructure" },
  { id: "data", label: "Data & analytics" },
  { id: "security", label: "Security" },
  { id: "fintech", label: "Fintech" },
  { id: "crypto", label: "Crypto" },
  { id: "saas", label: "Business software (SaaS)" },
  { id: "hr", label: "HR & recruiting" },
  { id: "marketing", label: "Marketing tech" },
  { id: "ecommerce", label: "E-commerce & delivery" },
  { id: "consumer", label: "Consumer apps" },
  { id: "media", label: "Media & content" },
  { id: "gaming", label: "Gaming" },
  { id: "health", label: "Health" },
  { id: "edtech", label: "Education" },
  { id: "mobility", label: "Mobility" },
  { id: "logistics", label: "Logistics" },
  { id: "hardware", label: "Hardware & space" },
  { id: "climate", label: "Climate & energy" },
];

let cache: { checkedAt: string; companies: StarterCompany[] } | undefined;

/** The bundled starter list (data/companies.json), verified against the public job-board APIs. */
export function starterList(): { checkedAt: string; companies: StarterCompany[] } {
  if (!cache)
    cache = JSON.parse(readFileSync(join(packageRoot(), "data", "companies.json"), "utf8")) as {
      checkedAt: string;
      companies: StarterCompany[];
    };
  return cache;
}

/** Job families someone is after, from the role names they typed ("backend engineer" → engineering). */
export function functionsForRoles(roles: string[]): JobFunction[] {
  const out = new Set<JobFunction>();
  for (const r of roles) {
    const f = functionOf(r) ?? functionOf(`${r} engineer`);
    if (f) out.add(f);
    if ((FUNCTIONS as readonly string[]).includes(norm(r))) out.add(norm(r) as JobFunction);
  }
  return [...out];
}

export interface Suggestion extends StarterCompany {
  score: number;
  why: string[];
}

/**
 * Companies from the starter list that fit someone's roles, places and tastes, best first. A company
 * must hire in one of their regions (or remotely, when remote is fine) and, when the roles are
 * recognisable, in one of their job families. Industry and size preferences only change the order.
 */
export function suggestCompanies(
  config: Pick<Config, "rules" | "preferences" | "sources" | "companies">,
  list: StarterCompany[] = starterList().companies,
): Suggestion[] {
  const places = [...config.rules.countries, ...config.rules.locations];
  const want = new Set(regionsForPlaces(places));
  const remoteOk = config.rules.locations.some((l) => norm(l) === "remote");
  if (remoteOk) want.add("remote");
  const fns = functionsForRoles(config.rules.roles);
  const have = new Set(config.companies.map((c) => `${c.ats}:${c.token}`));
  const out: Suggestion[] = [];
  for (const c of list) {
    if (!config.sources[c.ats] || have.has(`${c.ats}:${c.token}`)) continue;
    if (config.rules.neverApply.some((n) => norm(n) === norm(c.name))) continue;
    const why: string[] = [];
    let score = 0;
    const regionHits = c.regions.filter((r) => want.has(r));
    if (want.size) {
      if (!regionHits.length) continue;
      // Hiring locally counts more than hiring remotely.
      const local = regionHits.filter((r) => r !== "remote");
      score += local.length ? 3 : 1.5;
      why.push(local.length ? "hires where you want to work" : "hires remotely");
    }
    if (fns.length) {
      const idx = Math.min(...fns.map((f) => (c.functions.includes(f) ? c.functions.indexOf(f) : 99)));
      if (idx === 99) continue;
      score += idx < 2 ? 2 : 1;
      why.push("has roles like yours");
    }
    if (config.preferences.industries.includes(c.industry)) {
      score += 1.5;
      why.push("industry you like");
    }
    if (config.preferences.sizes.includes(c.size)) {
      score += 1;
      why.push("company size you like");
    }
    // More open roles, more chances; capped so big companies do not crowd out the rest.
    score += Math.min(1, Math.log10(Math.max(1, c.jobs)) / 3);
    out.push({ ...c, score, why });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function toCompany(c: Pick<StarterCompany, "name" | "ats" | "token">): Company {
  return { name: c.name, ats: c.ats, token: c.token };
}

/** Add companies to a list, skipping ones already on it (same ATS and token). */
export function mergeCompanyList(existing: Company[], add: Company[]): Company[] {
  const out = [...existing];
  for (const c of add)
    if (!out.some((x) => x.ats === c.ats && x.token.toLowerCase() === c.token.toLowerCase())) out.push(c);
  return out;
}

/** The starter-list entry for an ATS board, if the company is on the list. */
export function findStarter(ats: Ats, token: string): StarterCompany | undefined {
  return starterList().companies.find((c) => c.ats === ats && c.token.toLowerCase() === token.toLowerCase());
}
