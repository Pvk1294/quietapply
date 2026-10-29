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
| Form parser | `src/forms/parse.ts` | Reads labels, types, required flags and options from Greenhouse, Lever and rendered Ashby pages (custom dropdowns, hidden upload inputs, Ashby Yes/No buttons); spots visible CAPTCHAs and password fields. Tested on saved copies of real forms (`fixtures/ats/*-real-form.html`) |
| Dry-run guard | `browser/dry-run-guard.cjs` | Loaded into Playwright MCP (`--init-page`) while dry run is on: aborts every request that is not a read (GET/HEAD/OPTIONS), except Ashby's read-only GraphQL queries, and logs what it blocked to the application's run folder |
| Form-only screenshots | `browser/form-shot.cjs` | Loaded into Playwright MCP in every run: a page screenshot is cropped in code to the application form (`form#application-form` for Greenhouse and Lever, `.ashby-application-form-container` or the common parent of Ashby's field entries, else the `<form>` with the most fields). With no form on the page (the confirmation after Submit) it takes a viewport shot capped at 2,000 px. Element shots the agent asks for pass through. Tested on the saved real forms |
| Claude in Chrome guard | `browser/chrome-guard.cjs`, `src/runner/chrome-guard.ts` | A Claude Code `PreToolUse` hook (added with `--settings`) on the Chrome `computer` tool in dry run and review mode; see below |
| Safety checks | `src/core/safety.ts` | The fingerprint your review OK is bound to, the scan for page text aimed at the AI, the hosts where Submit may be clicked, and the sensitive questions that always come back to you (`safety.alwaysAsk`) |
| Email applications | `src/email/` | Off by default. Writes the email from your profile and answers, keeps the app password in the keychain, sends over SMTP within the caps, records each sent email ([email.md](email.md)) |
| Recruiter messages | `src/linkedin/messages.ts`, `prompts/message.md` | Off by default, LinkedIn only. Drafts from your profile, one per person ever, sent in a separate Claude in Chrome run only after approval |
| Evidence | `src/runner/evidence.ts` | Finds the screenshots in `logs/run-<run>/app-<application>/` for the dashboard |
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

## What protects each mode

"Dry run" means nothing may be sent. "Review" means the form is filled and waits for your OK. "Live" means Submit may be clicked once `start_submit` says go. The layers, from the inside out:

| Layer | Playwright browser | Claude in Chrome (including LinkedIn) |
|---|---|---|
| Desk, `start_submit` | In dry run and review it never returns `proceed: true`; it only records the filled values. Live: also needs a memory id for every value, no open questions, and the daily and per-company caps. | Same. |
| Desk, `record_result` | `submitted` is refused unless `start_submit` approved it, so a submit that never happened cannot be recorded. | Also refused in dry run and review whatever the status, and the attempt is logged. |
| Network | **Dry run only:** `browser/dry-run-guard.cjs` aborts every request that is not a read (GET/HEAD/OPTIONS), except Ashby's read-only GraphQL queries, and blocks service workers. Even a stray click on Submit sends nothing. Review mode has no network guard, so uploads work and the desk is the guard. | None. This is your own browser, and nothing can be intercepted. |
| Tools | Playwright MCP only. | Dry run and review: `javascript_tool`, `browser_batch` and `shortcuts_execute` are off, so `computer` is the only tool that can click. LinkedIn runs also lose `form_input`, network and console reads and the others in `LINKEDIN_DENIED_CHROME_TOOLS`. |
| Hook on `computer` | n/a | Dry run and review: Enter/Return and typed line breaks are refused (they submit forms). When the desk refuses the submit step it writes `submit-step.json` in the run folder; from then on every click, drag, key press and typing action is refused for the rest of the run. Screenshots, scrolling and zoom still work. |
| Log | `blocked-requests.jsonl` in the run folder: each blocked request. | The same file: each refused hook action and each refused `start_submit` / `record_result(submitted)`. The dashboard shows the count. |
| Live review | Until you have approved ten applications (the first-ten rule), a run ends at `awaiting_review`; your approval in the dashboard lets the next run go. | Same. |

Three more checks run in the desk whatever the browser:

- **Approval bound to content.** Your OK in review stores a fingerprint of the exact filled values (or the exact email). At Submit the desk compares it with what the agent is about to send. A difference withdraws the OK and the application waits for you again.
- **Pages that talk to the AI, and where Submit may happen.** Job descriptions and form labels are scanned for text aimed at an AI. A hit goes to Finish yourself before any agent opens the job. `start_submit` takes the address of the page with the Submit button, and only Greenhouse, Lever, Ashby, the job link's own site (or LinkedIn in LinkedIn mode) are allowed. A live submit without the address is refused.
- **Sensitive questions.** Work authorization and sponsorship, demographics and EEO, criminal history, legal attestations, NDAs and consent: `lookup_answers` never hands out a stored answer for these until you confirm it for that application, and `start_submit` refuses any such value you have not confirmed.

One gap remains, and it is only in Claude in Chrome: a click on a final Submit button *before* the agent has called `start_submit` looks like any other click to the hook, which cannot read button labels. The agent is told to call `start_submit` first, and on LinkedIn the desk will not accept a result for an application it did not approve, so such a submit would show up as a mismatch. Keep LinkedIn dry runs for watching, not for unattended use.
