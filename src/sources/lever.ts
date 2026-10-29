import type { Fetcher } from "./http.js";
import { getJson } from "./http.js";
import type { JobListing } from "./types.js";

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  categories?: { location?: string; team?: string; commitment?: string; allLocations?: string[] };
  workplaceType?: string;
  descriptionPlain?: string;
  additionalPlain?: string;
  lists?: { text: string; content: string }[];
}

const host = (region?: "eu") => (region === "eu" ? "https://api.eu.lever.co" : "https://api.lever.co");

/** Open jobs from Lever's public Postings API. */
export async function listLever(
  fetcher: Fetcher,
  token: string,
  company = token,
  region?: "eu",
): Promise<JobListing[]> {
  const data = await getJson<LeverPosting[]>(
    fetcher,
    `${host(region)}/v0/postings/${encodeURIComponent(token)}?mode=json`,
  );
  return data.map((j) => toListing(j, company));
}

/** One posting by id (`quietapply add`). Lever's API has no company name; the caller passes one. */
export async function leverJob(
  fetcher: Fetcher,
  token: string,
  postingId: string,
  company = token,
  region?: "eu",
): Promise<JobListing> {
  const j = await getJson<LeverPosting>(
    fetcher,
    `${host(region)}/v0/postings/${encodeURIComponent(token)}/${encodeURIComponent(postingId)}`,
  );
  return toListing(j, company);
}

function toListing(j: LeverPosting, company: string): JobListing {
  return {
    ats: "lever",
    company,
    externalId: j.id,
    title: j.text,
    url: j.hostedUrl,
    location: j.categories?.location ?? "",
    remote: j.workplaceType === "remote" || /remote/i.test(j.categories?.location ?? ""),
    description: [
      j.descriptionPlain,
      ...(j.lists ?? []).map((l) => `${l.text}\n${l.content.replace(/<[^>]+>/g, " ")}`),
      j.additionalPlain,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
