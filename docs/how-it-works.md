# How QuietApply works

## One run

```mermaid
sequenceDiagram
  participant S as Scheduler / Run now
  participant R as Runner
  participant A as Claude Code or Codex
  participant B as Browser (Playwright MCP)
  participant D as Desk MCP tools
  participant H as You (dashboard)
  S->>R: run
  R->>R: pause flag, lock, fit gate, caps
  R->>A: prompt (instructions, playbook, only the answers this form needs)
  A->>D: get_job, check_duplicate
  A->>B: open the form, read the questions
  A->>D: lookup_answers(all labels)
  D-->>A: known (with memory id) / maybe / unknown
  A->>D: ask_human(unknown required questions)
  D-->>H: question card; application waits
  A->>D: start_submit(every value + its memory id)
  D-->>A: dry run / review / cap / go
  A->>B: click Submit (only on "go")
  A->>D: record_result
```

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Config and data | `src/core/` | `~/.quietapply/config.yaml`, `profile.yaml`, `data.db` (SQLite, built into Node 22.13+) |
| Answer memory | `src/memory/answers.ts` | Structured answers with a key, other wordings and a scope (all, one company, one ATS). Lookup matches profile fields first, then standard-question patterns, then word overlap. Below the threshold it says "unknown" instead of guessing. |
| Question queue | `src/memory/queue.ts` | Dedupes open questions; one answer releases every application that waited on it |
| Desk tools | `src/mcp/desk.ts` | The agent's only access to your data. `start_submit` refuses values without a valid memory id, and decides dry run / review / caps in code. |
| Providers | `src/providers/` | Build the unattended command line for `claude -p` and `codex exec`, detect usage limits |
| Runner | `src/runner/run.ts` | Queue, fit gate, caps, one agent run per application, and settling of half-finished work (approved-but-unrecorded submits become "unclear" and are never retried automatically) |
| Discovery | `src/runner/discover.ts`, `src/sources/` | Public Greenhouse Job Board API, Lever Postings API, Ashby Job Posting API |
| Form parser | `src/forms/parse.ts` | Reads labels, types, required flags and options from Greenhouse, Lever and rendered Ashby pages; spots visible CAPTCHAs and password fields |
| Handoffs | `src/core/handoffs.ts` | One record for every job skipped or stopped: reason (CAPTCHA, login, unknown question, file upload, unsupported site, redirect, LinkedIn limit, fit gate with its rule, cap, form error, unclear submit), plain-words detail, what is needed, the fields already filled, and when. Written by the runner (rules, caps, unsupported sites, failures) and by the agent through `mark_blocked` / `report_outcome`. |
| Scripted agent | `src/runner/scripted-agent.ts` | A no-AI stand-in that talks to the real desk server; used by tests and the demo, never submits |
| Scheduler | `src/scheduler/` | `tick` every 15 minutes through launchd or systemd; runs the latest due slot once |
| Dashboard | `src/server/`, `web/` | Hono API on 127.0.0.1 and a React app; `quietapply phone` shares it over Tailscale Serve ([phone.md](phone.md)) |

## What the agent reports

The agent's last words are not read. It records how the job ended through two desk tools: `mark_blocked` (reason, what happened, what you need to do, fields already filled) when it hands a job back, and `report_outcome` as the structured end-of-run report. If a run ends with nothing recorded, the runner writes a `form_error` record itself, so every job that is not applied to has a reason on the *Finish yourself* page.

## Why structured memory instead of one big prompt

The personal runner this grew out of kept every answer by appending it to its prompt. After six weeks the prompt was 87 KB (about 22,000 tokens), re-sent on every run, with 87 answer blocks. It worked, but it grew without limit, could not be edited sensibly, and could not be shared.

QuietApply stores each answer once, retrieves only the ones that match the form in front of the agent (Greenhouse publishes its questions in its API; Lever forms are server-rendered; Ashby forms are looked up live through `lookup_answers`), and makes the agent cite the memory id for each value. A typical prompt is a few kilobytes.

## Statuses

| Status | Meaning |
|---|---|
| queued | waiting for the next run |
| skipped | failed the fit gate or caps (reason shown) |
| in_progress | the agent is working on it |
| needs_answers | waiting for you in Questions |
| dry_run | form filled, not submitted (dry run on) |
| awaiting_review | filled; waiting for your OK (review mode) |
| submitting | Submit approved; result not recorded yet |
| submitted | the site confirmed |
| unclear | may or may not have gone through: check the site |
| blocked | handed to you (CAPTCHA, video, email-only, account, …) |
| failed | the run broke; try again from the dashboard |
