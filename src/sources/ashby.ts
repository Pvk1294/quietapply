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
  return (await board(fetcher, token)).filter((j) => j.isListed !== false).map((j) => toListing(j, company));
}

/**
 * One job by id (`quietapply add`). The public API only lists a whole board, so the job is looked up in it;
 * an unlisted job is not there and gives undefined.
 */
export async function ashbyJob(
  fetcher: Fetcher,
  token: string,
  jobId: string,
  company = token,
): Promise<JobListing | undefined> {
  const j = (await board(fetcher, token)).find((x) => x.id === jobId);
  return j ? toListing(j, company) : undefined;
}

async function board(fetcher: Fetcher, token: string): Promise<AshbyJob[]> {
  const data = await getJson<{ jobs: AshbyJob[] }>(
    fetcher,
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`,
  );
  return data.jobs;
}

function toListing(j: AshbyJob, company: string): JobListing {
  return {
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
  };
}
