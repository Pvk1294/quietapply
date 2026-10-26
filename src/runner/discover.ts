import { suggestCompanies, toCompany } from "../companies/starter.js";
import type { Company, Config } from "../core/config.js";
import type { DB } from "../core/db.js";
import { checkFit } from "../core/rules.js";
import { addApplication } from "../core/store.js";
import type { Profile } from "../memory/profile.js";
import { listAshby } from "../sources/ashby.js";
import { listGreenhouse } from "../sources/greenhouse.js";
import type { Fetcher } from "../sources/http.js";
import { listLever } from "../sources/lever.js";
import type { JobListing } from "../sources/types.js";

export interface DiscoverSummary {
  /** Companies checked; when the watch list is empty these come from the starter list. */
  companies: number;
  fromStarterList: boolean;
  found: number;
  added: number;
  alreadyKnown: number;
  skipped: Record<string, number>;
  errors: { company: string; error: string }[];
}

/** How many starter-list companies discover checks when your own list is empty. */
export const STARTER_SCAN = 30;

/** The companies to check: your list, or the best starter-list matches for your roles and places. */
export function companiesToScan(
  config: Config,
  opts: { starter?: boolean } = {},
): { companies: Company[]; fromStarterList: boolean } {
  if (config.companies.length && !opts.starter)
    return { companies: config.companies, fromStarterList: false };
  const picks = suggestCompanies(config).slice(0, STARTER_SCAN).map(toCompany);
  return { companies: [...config.companies, ...picks], fromStarterList: true };
}

/** Pull open roles from every company's public job API and queue the ones that pass the fit gate. */
export async function discover(
  db: DB,
  config: Config,
  profile: Profile,
  fetcher: Fetcher,
  opts: { starter?: boolean } = {},
): Promise<DiscoverSummary> {
  const { companies, fromStarterList } = companiesToScan(config, opts);
  const out: DiscoverSummary = {
    companies: companies.length,
    fromStarterList,
    found: 0,
    added: 0,
    alreadyKnown: 0,
    skipped: {},
    errors: [],
  };
  for (const c of companies) {
    if (!config.sources[c.ats]) continue;
    let jobs: JobListing[];
    try {
      jobs =
        c.ats === "greenhouse"
          ? await listGreenhouse(fetcher, c.token, c.name)
          : c.ats === "lever"
            ? await listLever(fetcher, c.token, c.name, c.region)
            : await listAshby(fetcher, c.token, c.name);
    } catch (err) {
      out.errors.push({ company: c.name, error: (err as Error).message });
      continue;
    }
    for (const j of jobs) {
      out.found++;
      const fit = checkFit(j, config.rules, profile);
      if (!fit.fit) {
        const key = fit.reason.replace(/"[^"]*"/g, "…");
        out.skipped[key] = (out.skipped[key] ?? 0) + 1;
        continue;
      }
      const r = addApplication(db, {
        company: j.company,
        title: j.title,
        url: j.url,
        ats: j.ats,
        location: j.location,
        source: j.ats,
        description: j.description.slice(0, 4000),
      });
      if (r.created) out.added++;
      else out.alreadyKnown++;
    }
  }
  return out;
}
