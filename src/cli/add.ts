import type { Company } from "../core/config.js";
import type { DB } from "../core/db.js";
import { addApplication, setApplyEmail } from "../core/store.js";
import { cleanAddress } from "../email/compose.js";
import { detectAts } from "../sources/detect.js";
import type { Fetcher } from "../sources/http.js";
import { companyFromToken, fetchJob } from "../sources/job.js";
import type { JobListing } from "../sources/types.js";

export interface AddOptions {
  company?: string;
  title?: string;
  /** Look the job up through the ATS API (default true). */
  fetch?: boolean;
  companies?: Company[];
}

export interface AddResult {
  id: number;
  created: boolean;
  company: string;
  title: string;
  location?: string;
  /** Why the lookup did not work, when it did not. */
  lookupError?: string;
}

/**
 * `quietapply add <url>`: queue one job. Title, company, location and description come from the ATS's
 * public API (so the fit gate can read the posting); --company and --title override them. If the lookup
 * fails the job is still queued with what the URL says.
 */
export async function addJob(db: DB, url: string, fetcher: Fetcher, o: AddOptions = {}): Promise<AddResult> {
  // A posting that asks for an email: `quietapply add mailto:jobs@acme.com --company Acme --title "..."`.
  const to = /^mailto:/i.test(url) ? cleanAddress(url) : undefined;
  if (/^mailto:/i.test(url)) {
    if (!to) throw new Error(`Not an email address: ${url}`);
    if (!o.company || !o.title) throw new Error("For an email application give --company and --title too.");
    // One address can take applications for several roles, so the role is part of the job's key.
    const key = `mailto:${to}?role=${encodeURIComponent(o.title.toLowerCase())}`;
    const r = addApplication(db, {
      url: key,
      company: o.company,
      title: o.title,
      ats: "email",
      source: "manual",
    });
    setApplyEmail(db, r.id, to);
    return { ...r, company: o.company, title: o.title };
  }
  const ref = detectAts(url);
  let job: JobListing | undefined;
  let lookupError: string | undefined;
  if (o.fetch !== false && ref?.jobId) {
    try {
      job = await fetchJob(fetcher, url, o.companies);
      if (!job) lookupError = "the job is not on the public board (closed or unlisted)";
    } catch (err) {
      lookupError = (err as Error).message;
    }
  }
  const company = o.company ?? job?.company ?? (ref ? companyFromToken(ref.token) : new URL(url).hostname);
  const title = o.title ?? job?.title ?? "Job";
  const r = addApplication(db, {
    url: job?.url ?? url,
    company,
    title,
    ats: ref?.ats ?? "unknown",
    location: job?.location || null,
    description: job?.description.slice(0, 4000) || null,
    source: "manual",
  });
  return { ...r, company, title, location: job?.location || undefined, lookupError };
}
