import type { Company } from "../core/config.js";
import { type AtsRef, detectAts } from "../sources/detect.js";
import type { Fetcher } from "../sources/http.js";
import { probeBoard } from "./probe.js";
import { findStarter } from "./starter.js";

export type ResolveResult =
  | { ok: true; company: Company; jobs: number; via: "url" | "page" }
  | { ok: false; input: string; reason: string };

// ATS links as they appear inside a company's own careers page (links, embeds, API calls in scripts).
const PAGE_PATTERNS: RegExp[] = [
  /https?:\/\/(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([\w-]+)/i,
  /https?:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([\w-]+)/i,
  /https?:\/\/(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/(?!embed\b)([\w-]+)/i,
  /https?:\/\/(?:api|jobs)(?:\.eu)?\.lever\.co\/(?:v0\/postings\/)?([\w.-]+)/i,
  /https?:\/\/(?:api\.ashbyhq\.com\/posting-api\/job-board|jobs\.ashbyhq\.com)\/([\w.%-]+)/i,
];

/** The ATS board a careers page embeds or links to, found in its HTML. */
export function atsInHtml(html: string): AtsRef | undefined {
  for (const re of PAGE_PATTERNS) {
    const m = re.exec(html);
    if (!m) continue;
    const ref = detectAts(m[0]);
    if (ref) return ref;
  }
  return undefined;
}

function prettyName(token: string): string {
  return token
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Turn a pasted careers-page URL into a company on the watch list. Greenhouse, Lever and Ashby URLs are
 * read directly; any other page is fetched once and searched for an embedded job board. The board is then
 * checked through its public API so a typo never lands on the list.
 */
export async function resolveCareersUrl(input: string, fetcher: Fetcher): Promise<ResolveResult> {
  const url = input.trim();
  if (!url) return { ok: false, input, reason: "empty" };
  let ref = detectAts(url);
  let via: "url" | "page" = "url";
  if (!ref) {
    let html: string;
    try {
      html = await fetcher(url.includes("://") ? url : `https://${url}`);
    } catch (err) {
      return { ok: false, input, reason: `could not open the page (${(err as Error).message})` };
    }
    ref = atsInHtml(html);
    via = "page";
    if (!ref)
      return {
        ok: false,
        input,
        reason:
          "no Greenhouse, Lever or Ashby job board found on that page (open one job and paste its URL instead)",
      };
  }
  try {
    const probe = await probeBoard(fetcher, ref.ats, ref.token, ref.region);
    const known = findStarter(ref.ats, ref.token);
    const name = known?.name ?? probe.name?.trim() ?? prettyName(ref.token);
    const company: Company = { name, ats: ref.ats, token: ref.token };
    if (ref.region) company.region = ref.region;
    return { ok: true, company, jobs: probe.jobs, via };
  } catch {
    return { ok: false, input, reason: `no ${ref.ats} job board called "${ref.token}"` };
  }
}
