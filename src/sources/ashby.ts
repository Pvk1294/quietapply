import type { Fetcher } from "./http.js";
import { getJson } from "./http.js";
import type { JobListing } from "./types.js";

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  isRemote?: boolean;
  isListed?: boolean;
  jobUrl: string;
  applyUrl?: string;
  descriptionPlain?: string;
  workplaceType?: string;
}

/** Open jobs from Ashby's public Job Posting API. */
export async function listAshby(fetcher: Fetcher, token: string, company = token): Promise<JobListing[]> {
  const data = await getJson<{ jobs: AshbyJob[] }>(
    fetcher,
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`,
  );
  return data.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      ats: "ashby",
      company,
      externalId: j.id,
      title: j.title,
      url: j.jobUrl,
      location:
        j.isRemote && !/remote/i.test(j.location ?? "")
          ? `${j.location ?? ""} (Remote)`.trim()
          : (j.location ?? ""),
      remote: !!j.isRemote || j.workplaceType === "Remote",
      description: j.descriptionPlain ?? "",
    }));
}
