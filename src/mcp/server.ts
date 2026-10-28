import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HANDOFF_REASONS } from "../core/handoffs.js";
import type { Desk } from "./desk.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

/** The "desk" MCP server: the agent's only way to read your data and record what happened. */
export function createDeskServer(desk: Desk, version = "0.1.0"): McpServer {
  const server = new McpServer({ name: "quietapply-desk", version });

  server.registerTool(
    "get_job",
    {
      description:
        "The application this run is for: company, title, URL, ATS, and mode (dry_run, review or live).",
    },
    async () => text(desk.getJob()),
  );

  server.registerTool(
    "get_profile",
    { description: "The applicant's profile: contact details, links, recent roles, education, skills." },
    async () => text(desk.getProfile()),
  );

  server.registerTool(
    "lookup_answers",
    {
      description:
        "Look up stored answers for form questions (send every field label at once). Each result is known (use it and cite memoryId), maybe (use a candidate only if it is clearly the same question) or unknown (call ask_human; never guess).",
      inputSchema: { questions: z.array(z.string()).min(1).max(80) },
    },
    async ({ questions }) => text(desk.lookupAnswers(questions)),
  );

  server.registerTool(
    "ask_human",
    {
      description:
        "Queue a question the human must answer (missing facts, unclear required fields). The application waits; do not submit in this run.",
      inputSchema: {
        question: z.string().min(3),
        context: z.string().optional(),
        options: z.array(z.string()).optional(),
        field_type: z.enum(["text", "long", "yesno", "choice", "number", "date"]).optional(),
      },
    },
    async ({ question, context, options, field_type }) =>
      text(desk.askHuman({ question, context, options, fieldType: field_type })),
  );

  server.registerTool(
    "check_duplicate",
    {
      description: "Whether this job (or the same role at the same company) was already applied to.",
      inputSchema: { company: z.string(), title: z.string(), url: z.string() },
    },
    async (args) => text(desk.checkDuplicate(args)),
  );

  server.registerTool(
    "start_submit",
    {
      description:
        "Call when the form is completely filled, right before Submit. List every value you entered with its source memory id. Returns whether to click Submit.",
      inputSchema: {
        filled: z.array(
          z.object({
            field: z.string(),
            value: z.string(),
            source: z.string().describe('"mem:<id>", "profile:<field>", "resume", or "tailored:mem:<id>"'),
          }),
        ),
      },
    },
    async ({ filled }) => text(desk.startSubmit(filled)),
  );

  server.registerTool(
    "record_result",
    {
      description: "After clicking Submit: what the page showed. Use 'unclear' if you cannot tell.",
      inputSchema: {
        outcome: z.enum(["submitted", "unclear", "failed"]),
        evidence: z.string().describe("Confirmation text or the error shown"),
      },
    },
    async (args) => text(desk.recordResult(args)),
  );

  const filledValues = z
    .array(z.object({ field: z.string(), value: z.string() }))
    .describe("Fields you already filled in on the form, as label and value");

  server.registerTool(
    "mark_blocked",
    {
      description:
        "Hand the application to the human and say why. reason: captcha (CAPTCHA or human check), login_required (account, password or code), unknown_question, file_upload (special upload form), unsupported_ats (Workday etc.), external_redirect (email-only or another site), linkedin_limit, fit_gate (e.g. a 'no AI' posting; give the rule), cap, form_error (site or form broke), unclear_submit, other.",
      inputSchema: {
        category: z
          .enum([
            ...HANDOFF_REASONS,
            "human_only",
            "email_only",
            "account_required",
            "otp",
            "file_upload_form",
            "site_error",
            "no_ai_policy",
            "missing_data",
          ])
          .describe("The reason"),
        notes: z.string().describe("What happened, in plain words"),
        needed: z.string().optional().describe("What the human has to do"),
        rule: z.string().optional().describe("For fit_gate: the rule or sentence that applies"),
        filled: filledValues.optional(),
        prefilled: z.record(z.string(), z.string()).optional(),
      },
    },
    async (args) => text(desk.markBlocked(args)),
  );

  server.registerTool(
    "report_outcome",
    {
      description:
        "Call this last, once per run. It is how the dashboard learns what happened; your closing message is not read. outcome: filled (dry run or review, form complete), submitted, handed_over, waiting_for_answers, failed. For handed_over and failed give reason, detail and needed.",
      inputSchema: {
        outcome: z.enum(["filled", "submitted", "handed_over", "waiting_for_answers", "failed"]),
        reason: z.enum(HANDOFF_REASONS).optional(),
        detail: z.string().optional(),
        needed: z.string().optional(),
        filled: filledValues.optional(),
      },
    },
    async (args) => text(desk.reportOutcome(args)),
  );

  server.registerTool(
    "add_site_note",
    {
      description: "Save a how-to note about a site's form for future runs. Never include personal data.",
      inputSchema: { host: z.string(), note: z.string() },
    },
    async (args) => text(desk.addSiteNote(args)),
  );

  return server;
}
