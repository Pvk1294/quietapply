import { decodeEntities, type Fetcher, getJson, htmlToText } from "./http.js";
import type { FieldType, FormField, JobListing } from "./types.js";

const API = "https://boards-api.greenhouse.io/v1/boards";

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  content?: string;
  company_name?: string;
  include_ai_disclaimer?: boolean | null;
  ai_disclaimer?: string | null;
}

interface GhQuestion {
  label: string;
  required: boolean;
  fields: { name: string; type: string; values?: { label: string; value: number | string }[] }[];
}

interface GhJobDetail extends GhJob {
  questions?: GhQuestion[];
  compliance?: { type: string; questions?: GhQuestion[] }[] | null;
  location_questions?: GhQuestion[];
}

/** Open jobs on a Greenhouse board, from the public Job Board API (no login, no scraping). */
export async function listGreenhouse(
  fetcher: Fetcher,
  token: string,
  company = token,
): Promise<JobListing[]> {
  const data = await getJson<{ jobs: GhJob[] }>(
    fetcher,
    `${API}/${encodeURIComponent(token)}/jobs?content=true`,
  );
  return data.jobs.map((j) => toListing(token, j, company));
}

/** One job by id (`quietapply add`). The single-job endpoint always includes the description. */
export async function greenhouseJob(
  fetcher: Fetcher,
  token: string,
  jobId: string,
  company = token,
): Promise<JobListing> {
  const j = await getJson<GhJob>(
    fetcher,
    `${API}/${encodeURIComponent(token)}/jobs/${encodeURIComponent(jobId)}`,
  );
  return toListing(token, j, company);
}

function toListing(token: string, j: GhJob, company: string): JobListing {
  // The AI disclaimer goes into the description, so the fit gate sees a "no AI tools" request.
  const description = [htmlToText(decodeEntities(j.content ?? "")), j.ai_disclaimer ?? ""].join("\n").trim();
  return {
    ats: "greenhouse",
    company: j.company_name ?? company,
    externalId: String(j.id),
    title: j.title,
    url: formUrl(token, j),
    location: j.location?.name ?? "",
    remote: /remote/i.test(j.location?.name ?? ""),
    description,
  };
}

/**
 * Where the form lives. Boards on a company's own careers site (absolute_url is stripe.com/jobs/...?gh_jid=)
 * redirect the Greenhouse job page there too, so use Greenhouse's embeddable form, which every board serves.
 */
export function formUrl(token: string, job: Pick<GhJob, "id" | "absolute_url">): string {
  try {
    if (/(^|\.)greenhouse\.io$/i.test(new URL(job.absolute_url).hostname)) return job.absolute_url;
  } catch {
    // no usable absolute_url
  }
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(token)}&token=${job.id}`;
}

const TYPE: Record<string, FieldType> = {
  input_text: "text",
  textarea: "textarea",
  input_file: "file",
  multi_value_single_select: "select",
  multi_value_multi_select: "multiselect",
  input_hidden: "text",
};

/** The application questions for one job (the API returns the exact form, including EEO questions). */
export async function greenhouseQuestions(
  fetcher: Fetcher,
  token: string,
  jobId: string,
): Promise<FormField[]> {
  const d = await getJson<GhJobDetail>(
    fetcher,
    `${API}/${encodeURIComponent(token)}/jobs/${jobId}?questions=true`,
  );
  const all = [
    ...(d.questions ?? []),
    ...(d.location_questions ?? []),
    ...(d.compliance ?? []).flatMap((c) => c.questions ?? []),
  ];
  return all.flatMap((q) => {
    // "Resume/CV" offers a file or a textarea; the file upload is the one we use.
    const f = q.fields.find((x) => x.type === "input_file") ?? q.fields[0];
    if (!f || f.type === "input_hidden") return [];
    return [
      {
        label: q.label,
        name: f.name,
        type: TYPE[f.type] ?? "text",
        required: q.required,
        options: f.values?.length ? f.values.map((v) => v.label) : undefined,
      },
    ];
  });
}
