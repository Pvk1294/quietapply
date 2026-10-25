import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseForm } from "../forms/parse.js";
import type { Desk, FilledField } from "../mcp/desk.js";
import { createDeskServer } from "../mcp/server.js";
import type { LookupResult } from "../memory/answers.js";
import { applyUrl } from "../sources/detect.js";
import type { Fetcher } from "../sources/http.js";
import type { FormField } from "../sources/types.js";

type Lookup = { question: string } & LookupResult;

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
    const job = await call<{ company: string; title: string; url: string; mode: string }>("get_job");
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
    const fields = form.fields.filter((f) => f.type !== "file");
    const results = await call<Lookup[]>("lookup_answers", { questions: fields.map((f) => f.label) });
    const filled: FilledField[] = form.fields
      .filter((f) => f.type === "file" && /resume|cv/i.test(f.label))
      .map((f) => ({ field: f.label, value: "resume", source: "resume" }));
    let asked = 0;
    for (const [i, f] of fields.entries()) {
      const r = results[i]!;
      const value = r.status === "known" ? pickOption(f, r.answer) : undefined;
      if (r.status === "known" && value !== undefined)
        filled.push({ field: f.label, value, source: r.memoryId });
      else if (f.required) {
        await call("ask_human", {
          question: f.label,
          context: `${job.title} at ${job.company}`,
          options: f.options,
          field_type: kind(f),
        });
        asked++;
      }
    }
    if (asked)
      return `Asked ${asked} question${asked > 1 ? "s" : ""}; the application waits for your answers.`;
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
  } finally {
    await client.close();
    await server.close();
  }
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
