import type { Ats } from "../sources/detect.js";
import { type Fetcher, getJson } from "../sources/http.js";
import { type Region, regionsOf } from "./regions.js";

/** Job families, from titles. Used to suggest companies that hire for the roles a person wants. */
export const FUNCTIONS = [
  "engineering",
  "data",
  "design",
  "product",
  "marketing",
  "sales",
  "support",
  "operations",
  "finance",
  "people",
  "legal",
] as const;
export type JobFunction = (typeof FUNCTIONS)[number];

const FUNCTION_RE: [JobFunction, RegExp][] = [
  ["data", /\b(data|analytics?|analyst|machine learning|ml|ai research|scientist|bi)\b/],
  [
    "engineering",
    /\b(engineer(ing)?|developer|swe|sre|devops|architect|programmer|frontend|front end|backend|back end|full ?stack|mobile|ios|android|security|infrastructure|platform|qa|test)\b/,
  ],
  ["design", /\b(design(er)?|ux|ui|researcher|creative|brand designer)\b/],
  ["product", /\b(product manager|product owner|product lead|head of product|pm|program manager|tpm)\b/],
  ["marketing", /\b(marketing|growth|content|seo|communications|pr|community|social media|copywriter)\b/],
  [
    "sales",
    /\b(sales|account executive|account manager|business development|bdr|sdr|partnerships?|solutions? (engineer|consultant))\b/,
  ],
  ["support", /\b(support|customer success|customer experience|cx|onboarding|implementation)\b/],
  ["finance", /\b(finance|financial|accounting|accountant|controller|tax|treasury|fp&a|payroll)\b/],
  ["people", /\b(recruit(er|ing)?|talent|people|hr|human resources)\b/],
  ["legal", /\b(legal|counsel|compliance|privacy|paralegal|attorney|lawyer)\b/],
  [
    "operations",
    /\b(operations|ops|logistics|supply chain|procurement|office|administrative|executive assistant)\b/,
  ],
];

/** The job family a title belongs to (first match wins; data before engineering so "Data Engineer" is data). */
export function functionOf(title: string): JobFunction | undefined {
  const t = title.toLowerCase().replace(/[^a-z0-9&+ ]+/g, " ");
  return FUNCTION_RE.find(([, re]) => re.test(t))?.[0];
}

export interface BoardProbe {
  ats: Ats;
  token: string;
  /** Company name when the API reports one (Greenhouse does). */
  name?: string;
  jobs: number;
  regions: Region[];
  functions: JobFunction[];
  /** A few "title (location)" lines, for a person checking that the board is the company they meant. */
  sample: string[];
}

interface ProbeJob {
  title: string;
  locations: string[];
  remote?: boolean;
}

async function jobsOf(
  fetcher: Fetcher,
  ats: Ats,
  token: string,
  region?: "eu",
): Promise<{ jobs: ProbeJob[]; name?: string }> {
  const t = encodeURIComponent(token);
  if (ats === "greenhouse") {
    const d = await getJson<{
      jobs: {
        title: string;
        location?: { name?: string };
        offices?: { name?: string; location?: string | null }[];
      }[];
    }>(fetcher, `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`);
    let name: string | undefined;
    try {
      name = (await getJson<{ name?: string }>(fetcher, `https://boards-api.greenhouse.io/v1/boards/${t}`))
        .name;
    } catch {
      // The board endpoint is optional; the jobs list is what matters.
    }
    return {
      name,
      jobs: d.jobs.map((j) => ({
        title: j.title,
        locations: [j.location?.name ?? "", ...(j.offices ?? []).map((o) => o.location ?? o.name ?? "")],
      })),
    };
  }
  if (ats === "lever") {
    const d = await getJson<
      {
        text: string;
        workplaceType?: string;
        categories?: { location?: string; allLocations?: string[] };
        country?: string;
      }[]
    >(fetcher, `https://api${region === "eu" ? ".eu" : ""}.lever.co/v0/postings/${t}?mode=json`);
    return {
      jobs: d.map((j) => ({
        title: j.text,
        locations: [j.categories?.location ?? "", ...(j.categories?.allLocations ?? []), j.country ?? ""],
        remote: j.workplaceType === "remote",
      })),
    };
  }
  const d = await getJson<{
    jobs: {
      title: string;
      location?: string;
      isRemote?: boolean;
      isListed?: boolean;
      secondaryLocations?: { location?: string }[];
      address?: { postalAddress?: { addressCountry?: string } };
    }[];
  }>(fetcher, `https://api.ashbyhq.com/posting-api/job-board/${t}`);
  return {
    jobs: d.jobs
      .filter((j) => j.isListed !== false)
      .map((j) => ({
        title: j.title,
        locations: [
          j.location ?? "",
          ...(j.secondaryLocations ?? []).map((s) => s.location ?? ""),
          j.address?.postalAddress?.addressCountry ?? "",
        ],
        remote: !!j.isRemote,
      })),
  };
}

/**
 * Ask a job board's public API what it has open: how many jobs, in which regions and job families.
 * Throws when the board does not exist.
 */
export async function probeBoard(
  fetcher: Fetcher,
  ats: Ats,
  token: string,
  region?: "eu",
): Promise<BoardProbe> {
  const { jobs, name } = await jobsOf(fetcher, ats, token, region);
  const regionCount = new Map<Region, number>();
  const fnCount = new Map<JobFunction, number>();
  for (const j of jobs) {
    const rs = new Set<Region>(j.locations.flatMap((l) => regionsOf(l)));
    if (j.remote) rs.add("remote");
    for (const r of rs) regionCount.set(r, (regionCount.get(r) ?? 0) + 1);
    const f = functionOf(j.title);
    if (f) fnCount.set(f, (fnCount.get(f) ?? 0) + 1);
  }
  const byCount = <K>(m: Map<K, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const sample = jobs.slice(0, 3).map((j) => `${j.title} (${j.locations.filter(Boolean)[0] ?? "?"})`);
  return {
    ats,
    token,
    name,
    jobs: jobs.length,
    regions: byCount(regionCount),
    functions: byCount(fnCount),
    sample,
  };
}
