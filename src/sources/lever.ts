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

/** Open jobs from Lever's public Postings API. */
export async function listLever(
  fetcher: Fetcher,
  token: string,
  company = token,
  region?: "eu",
): Promise<JobListing[]> {
  const host = region === "eu" ? "https://api.eu.lever.co" : "https://api.lever.co";
  const data = await getJson<LeverPosting[]>(
    fetcher,
    `${host}/v0/postings/${encodeURIComponent(token)}?mode=json`,
  );
  return data.map((j) => ({
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
  }));
}
