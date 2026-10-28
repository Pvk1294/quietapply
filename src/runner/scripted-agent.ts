import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parse } from "node-html-parser";
import { parseForm } from "../forms/parse.js";
import { isLinkedInUrl, LINKEDIN_WARNING_RE } from "../linkedin/mode.js";
import type { Desk, FilledField } from "../mcp/desk.js";
import { createDeskServer } from "../mcp/server.js";
import type { LookupResult } from "../memory/answers.js";
import { applyUrl } from "../sources/detect.js";
import type { Fetcher } from "../sources/http.js";
import type { FormField, FormInfo } from "../sources/types.js";

type Lookup = { question: string } & LookupResult;
type Call = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
type Job = { company: string; title: string; url: string; mode: string; ats: string };

/**
 * A deterministic stand-in for the AI agent. It talks to the real desk MCP server (in memory) exactly as
 * the agent would, but reads the form from HTML instead of driving a browser, and never submits.
 * Used by tests, the demo and `run --provider fake`.
 */
export async function scriptedAgent(desk: Desk, fetcher: Fetcher): Promise<string> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createDeskServer(desk);
  await server.connect(serverT);
  const client = new Client({ name: "quietapply-scripted-agent", version: "0.1.0" });
  await client.connect(clientT);
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    const text = res.content[0]?.text ?? "{}";
    if (res.isError) throw new Error(text);
    return JSON.parse(text) as T;
  };

  try {
    const job = await call<Job>("get_job");
    if (job.ats === "linkedin") return await linkedIn(call, job, fetcher);
    const dup = await call<{ duplicate: boolean }>("check_duplicate", {
      company: job.company,
      title: job.title,
      url: job.url,
    });
    if (dup.duplicate) {
      await call("mark_blocked", { category: "other", notes: "Already applied to this role." });
      return "Duplicate: handed back.";
    }
    let html: string;
    try {
      html = await fetcher(applyUrl(job.url));
    } catch (err) {
      await call("mark_blocked", {
        category: "site_error",
        notes: `Could not load the form: ${(err as Error).message}`,
      });
      return "Site error.";
    }
    const form = parseForm(html);
    if (form.captcha) {
      await call("mark_blocked", { category: "captcha", notes: "Visible CAPTCHA on the form." });
      return "CAPTCHA: handed to you.";
    }
    if (form.accountRequired) {
      await call("mark_blocked", {
        category: "account_required",
        notes: "The site wants an account and password.",
      });
      return "Account needed: handed to you.";
    }
    return await fill(call, job, form);
  } finally {
    await client.close();
    await server.close();
  }
}

/** Fill a parsed form from memory, ask for unknown required questions, then ask the desk about Submit. */
async function fill(call: Call, job: Job, form: FormInfo, pace = false): Promise<string> {
  const fields = form.fields.filter((f) => f.type !== "file");
  const results = await call<Lookup[]>("lookup_answers", { questions: fields.map((f) => f.label) });
  const filled: FilledField[] = form.fields
    .filter((f) => f.type === "file" && /resume|cv/i.test(f.label))
    .map((f) => ({ field: f.label, value: "resume", source: "resume" }));
  let asked = 0;
  for (const [i, f] of fields.entries()) {
    const r = results[i]!;
    const value = r.status === "known" ? pickOption(f, r.answer) : undefined;
    if (r.status === "known" && value !== undefined) {
      if (pace) {
        // A person clicks the field, then types; longer answers in chunks with short breaks.
        await call("human_pause", { kind: "action" });
        const plan = await call<{ chunks: string[] }>("typing_plan", { text: value });
        for (let c = 1; c < plan.chunks.length; c++) await call("human_pause", { kind: "typing" });
      }
      filled.push({ field: f.label, value, source: r.memoryId });
    } else if (f.required) {
      await call("ask_human", {
        question: f.label,
        context: `${job.title} at ${job.company}`,
        options: f.options,
        field_type: kind(f),
      });
      asked++;
    }
  }
  if (asked) return `Asked ${asked} question${asked > 1 ? "s" : ""}; the application waits for your answers.`;
  const decision = await call<{ proceed: boolean; mode?: string; instruction: string }>("start_submit", {
    filled,
  });
  if (decision.proceed) {
    // The scripted agent has no browser: it never clicks Submit, so an approved submit is recorded as unclear.
    await call("record_result", {
      outcome: "unclear",
      evidence: "Scripted agent cannot submit; finish this one yourself.",
    });
    return "Approved for submit, but the scripted agent does not submit.";
  }
  return `Filled ${filled.length} fields (${decision.mode}).`;
}

/**
 * LinkedIn mode on a saved fixture page: read the job, stop at any warning, follow "Apply on company
 * website" to the normal flow, or fill the Easy Apply steps at a human pace. It refuses real LinkedIn URLs.
 */
async function linkedIn(call: Call, job: Job, fetcher: Fetcher): Promise<string> {
  if (isLinkedInUrl(job.url)) {
    await call("mark_blocked", {
      category: "other",
      notes: "The demo agent only opens saved fixture pages; it never visits LinkedIn.",
    });
    return "Real LinkedIn page: the demo agent does not open it.";
  }
  const html = await fetcher(job.url);
  await call("human_pause", { kind: "page" });
  const root = parse(html);
  for (const el of root.querySelectorAll("script, style")) el.remove();
  const text = root.text.replace(/\s+/g, " ");
  const warning = LINKEDIN_WARNING_RE.exec(text);
  if (warning) {
    await call("mark_blocked", {
      category: /captcha|robot|human/i.test(warning[0]) ? "captcha" : "linkedin_warning",
      notes: `LinkedIn showed: "${warning[0]}"`,
    });
    return "LinkedIn warning: stopped.";
  }
  const read = (sel: string) => root.querySelector(sel)?.text.replace(/\s+/g, " ").trim() ?? "";
  const details = await call<{ fit: boolean; reason?: string }>("job_details", {
    company: read(".job-company") || job.company,
    title: read(".job-title") || job.title,
    location: read(".job-location") || undefined,
    description: read(".job-description").slice(0, 2000) || undefined,
  });
  if (!details.fit) return `Not a fit: ${details.reason}`;
  await call("human_pause", { kind: "action" });
  const external = root.querySelector('a[data-apply="external"]')?.getAttribute("href");
  if (external) {
    const r = await call<{ continues: boolean }>("company_site", { url: external });
    return r.continues ? "Continues on the company site." : "Company site not supported: handed to you.";
  }
  const dialog = root.querySelector(".easy-apply-dialog");
  if (!dialog) {
    await call("mark_blocked", { category: "other", notes: "No Easy Apply or Apply button on the page." });
    return "No apply button.";
  }
  await call("human_pause", { kind: "page" });
  return await fill(call, job, parseForm(dialog.toString()), true);
}

function kind(f: FormField): string {
  if (f.type === "textarea") return "long";
  if (f.type === "select" || f.type === "radio") return f.options?.length === 2 ? "yesno" : "choice";
  if (f.type === "checkbox") return "yesno";
  return "text";
}

/** For choice fields, the option that matches the stored answer; undefined when none fits. */
export function pickOption(f: FormField, answer: string): string | undefined {
  if (!f.options?.length) return answer;
  const a = answer.trim().toLowerCase();
  const exact = f.options.find((o) => o.toLowerCase() === a);
  if (exact) return exact;
  const starts = f.options.find((o) => a.startsWith(o.toLowerCase()) || o.toLowerCase().startsWith(a));
  if (starts) return starts;
  if (/prefer not|decline|don.?t wish|not to (say|answer)/.test(a))
    return f.options.find((o) => /prefer not|decline|don.?t wish|not to (say|answer)/i.test(o));
  if (f.type === "checkbox" && /^(yes|i agree|agree)/.test(a)) return f.options[0] ?? "Yes";
  return undefined;
}
