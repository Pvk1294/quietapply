import type { Company } from "../core/config.js";
import { ashbyJob } from "./ashby.js";
import { detectAts } from "./detect.js";
import { greenhouseJob } from "./greenhouse.js";
import type { Fetcher } from "./http.js";
import { leverJob } from "./lever.js";
import type { JobListing } from "./types.js";

/** "acme-rockets" → "Acme Rockets": the best name there is when the API does not give one. */
export function companyFromToken(token: string): string {
  return token
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Look one job up by its URL through the ATS's public API: title, company, location and description.
 * Greenhouse returns the company name; Lever and Ashby do not, so it comes from your company list
 * (matched by board) or from the board name in the URL. Undefined when the URL is not a single job.
 */
export async function fetchJob(
  fetcher: Fetcher,
  url: string,
  companies: Company[] = [],
): Promise<JobListing | undefined> {
  const ref = detectAts(url);
  if (!ref?.jobId) return undefined;
  const company =
    companies.find((c) => c.ats === ref.ats && c.token.toLowerCase() === ref.token.toLowerCase())?.name ??
    companyFromToken(ref.token);
  if (ref.ats === "greenhouse") return greenhouseJob(fetcher, ref.token, ref.jobId, company);
  if (ref.ats === "lever") return leverJob(fetcher, ref.token, ref.jobId, company, ref.region);
  return ashbyJob(fetcher, ref.token, ref.jobId, company);
}
