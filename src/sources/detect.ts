export type Ats = "greenhouse" | "lever" | "ashby";

export interface AtsRef {
  ats: Ats;
  /** Company board token / slug. */
  token: string;
  jobId?: string;
  region?: "eu";
}

/** Recognise Greenhouse, Lever and Ashby URLs (board pages and individual job pages). */
export function detectAts(input: string): AtsRef | undefined {
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (/(^|\.)greenhouse\.io$/.test(host)) {
    // boards.greenhouse.io/acme/jobs/123, job-boards.greenhouse.io/acme/jobs/123, boards.greenhouse.io/embed/job_app?for=acme&token=123
    if (parts[0] === "embed") {
      const token = url.searchParams.get("for");
      return token
        ? { ats: "greenhouse", token, jobId: url.searchParams.get("token") ?? undefined }
        : undefined;
    }
    if (!parts[0]) return undefined;
    return {
      ats: "greenhouse",
      token: parts[0],
      jobId: parts[1] === "jobs" ? parts[2] : undefined,
      region: host.includes(".eu.") ? "eu" : undefined,
    };
  }
  if (/(^|\.)lever\.co$/.test(host) && host.startsWith("jobs.")) {
    if (!parts[0]) return undefined;
    return {
      ats: "lever",
      token: parts[0],
      jobId: parts[1],
      region: host.includes(".eu.") ? "eu" : undefined,
    };
  }
  if (host === "jobs.ashbyhq.com") {
    if (!parts[0]) return undefined;
    return { ats: "ashby", token: decodeURIComponent(parts[0]), jobId: parts[1] };
  }
  return undefined;
}

/** The application form URL for a job page (Lever and Ashby put the form on its own page). */
export function applyUrl(jobUrl: string): string {
  const ref = detectAts(jobUrl);
  if (!ref?.jobId) return jobUrl;
  const u = new URL(jobUrl);
  if (ref.ats === "lever" && !u.pathname.endsWith("/apply"))
    u.pathname = `${u.pathname.replace(/\/$/, "")}/apply`;
  if (ref.ats === "ashby" && !u.pathname.endsWith("/application"))
    u.pathname = `${u.pathname.replace(/\/$/, "")}/application`;
  return u.toString();
}
