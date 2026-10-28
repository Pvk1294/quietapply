# QuietApply

**A job-application agent that runs on your own machine, applies while you sleep, and asks you before it guesses.**

QuietApply uses the Claude Code or Codex you already have (subscription or API key). It finds roles on company job boards, checks them against your rules, fills in the application in a real browser, and submits it. When a form asks something it doesn't know, it asks you once in a local dashboard and remembers your answer for next time.

![The QuietApply dashboard: today's status, questions waiting for you and recent applications](docs/screenshots/today-desktop.png)

> Built from a personal runner that tracked more than 880 real applications in six weeks. Everything that broke along the way shaped the defaults below.

> **Status: v0.1 in development.** It works end to end in dry-run mode on the bundled fixture pages and has been checked live with Claude Code. Not yet published to npm. Expect rough edges.

---

## Why another auto-apply tool?

Most auto-apply bots send as many LinkedIn Easy Apply forms as they can. That gets accounts restricted and annoys recruiters. QuietApply goes the other way:

- **Asks before it guesses.** An answer it doesn't know goes to a question queue; it never makes one up. Every value it types must cite a stored answer, and the submit step refuses anything that doesn't.
- **Applies on company job boards, not LinkedIn.** It finds openings through the public Greenhouse, Lever and Ashby job APIs (no scraping, no login) and applies on the company's own form.
- **Uses the AI you already pay for.** Claude Code (Pro/Max or an API key) or OpenAI Codex (ChatGPT plan or an API key).
- **Remembers without bloating.** Answers are stored as small structured entries. Each run gets only the ones the form in front of it needs, so the prompt stays small no matter how much it has learned.
- **Hands back what it can't do.** CAPTCHAs, video answers, tests, email-only postings and account sign-ups go to a "Finish yourself" list. It never tries to solve a CAPTCHA.
- **Local and private.** Your data stays in `~/.quietapply` (readable only by you). No account, no server, no telemetry.

## Features

- `quietapply init` reads your resume (PDF, DOCX or text), builds `profile.yaml`, and asks the handful of questions almost every form asks (work authorization, sponsorship, notice period, salary, relocation, consent). Anything you skip is asked later, only when a form needs it.
- **Answer memory** you can see and edit. Each answer can apply everywhere or to one company only.
- **Fit gate** before every application: job titles, excluded words, locations, never-apply list, years of experience, skill match, and postings that ask for no AI.
- **Job sites:** Greenhouse, Lever and Ashby in v0.1; Workday is next.
- **Local dashboard** at `http://127.0.0.1:4777`: Today, Applications (with every value the agent typed and where it came from), Questions, Finish yourself, Memory, Runs, Settings, plus Run now and Pause. Works on a phone.
- **Review mode:** the first 10 applications stop before Submit and wait for your OK in the dashboard.
- **Dry run by default:** nothing is submitted until you turn dry run off. In dry run the browser itself blocks every request that would send data (form posts, uploads, autosave), so even a stray click on Submit goes nowhere.
- **Screenshots:** the agent screenshots the form at the end of every run, and each application's page in the dashboard shows them next to what was typed.
- **Duplicate protection:** an application is marked "submitting" before Submit is clicked, so an unclear result is never resent blindly.
- **Caps:** 15 a day and 2 per company per 30 days by default.
- **Scheduler:** launchd (macOS) or a systemd user timer (Linux). Missed runs are coalesced into one; a failed run is retried once; a lock stops overlapping runs; usage limits are waited out.

| Questions | Application detail | On a phone |
|---|---|---|
| ![Question queue](docs/screenshots/questions-desktop.png) | ![What the agent filled in, with memory ids](docs/screenshots/application-detail-desktop.png) | ![Mobile view](docs/screenshots/today-mobile.png) |

## Quickstart

You need Node.js 22.13 or newer, Google Chrome or Microsoft Edge, and one of:

- [Claude Code](https://code.claude.com/docs) signed in with a Claude plan, or with `ANTHROPIC_API_KEY`
- [Codex CLI](https://github.com/openai/codex) signed in with ChatGPT, or with `CODEX_API_KEY`

**Try it first with fake data** (nothing leaves your machine, no AI needed):

```bash
git clone https://github.com/Pvk1294/quietapply && cd quietapply
npm install && npm run build
node dist/cli/index.js demo          # fake persona "Jane Doe", fixture pages, dashboard on :4777
```

**Set it up for yourself:**

```bash
npm link                              # makes the `quietapply` command available (npx quietapply once published)
quietapply init                       # AI, resume -> profile, common questions, targets, companies
quietapply doctor                     # checks the CLI, login, browser and data folder
quietapply discover                   # finds open roles at your companies
quietapply add <job-url>              # or queue one job; title and company come from the job site's API
quietapply run                        # one run now (dry run: forms are filled, nothing is submitted)
quietapply dashboard                  # http://127.0.0.1:4777
quietapply schedule on                # runs at the times in config.yaml
```

The first runs open a separate Chrome profile in `~/.quietapply/browser-profile`. Your everyday browser is not touched.

## How it works

```mermaid
flowchart TD
  S[Schedule or Run now] --> R[Runner: fit gate, caps, lock]
  R --> P[Small prompt: playbook + only the answers this form needs]
  P --> A[Claude Code or Codex]
  A --> B[Browser: Playwright MCP or Claude in Chrome]
  B --> J[Company job board form]
  A --> D[Desk MCP tools]
  D --> DB[(Local SQLite: answers, applications, questions)]
  DB --> UI[Dashboard]
  UI -->|you answer, approve, pause| DB
```

1. **Find:** pulls openings from your company list through the public Greenhouse, Lever and Ashby APIs.
2. **Filter:** checks each role against your rules and logs why it skipped the ones it skipped.
3. **Apply:** the agent opens the form and fills it from your profile and answer memory. Every value has to cite a memory id.
4. **Ask:** an unknown required question becomes a card in the dashboard, and that application waits for the next run.
5. **Record:** dry run, review, submitted, or handed to you; the dashboard shows exactly what was typed, with a screenshot of the form.

The agent can only read and change your data through a small set of MCP tools (`lookup_answers`, `ask_human`, `start_submit`, `record_result`, `mark_blocked`…). The setup is the same whichever AI you use, the rules are enforced in code rather than in a prompt, and you can audit every step. More detail: [docs/how-it-works.md](docs/how-it-works.md).

## Providers

| Your AI | Browser it can use | How QuietApply runs it |
|---|---|---|
| Claude Code + Claude plan | Playwright MCP (default) or Claude in Chrome | `claude -p --output-format stream-json --strict-mcp-config …` |
| Claude Code + API key | Playwright MCP (Claude in Chrome needs a Claude plan) | same, with `ANTHROPIC_API_KEY` |
| Codex + ChatGPT plan or API key | Playwright MCP | `codex exec --json` with MCP servers passed as `-c` overrides |

With Claude Code, built-in tools (shell, file editing, web search) are switched off for application runs: the agent has only the browser and the desk tools, and your own settings, hooks and MCP servers are not loaded. Codex runs in its read-only sandbox. The Codex path is built and unit-tested but has not yet been run live.

## Configuration

`~/.quietapply/config.yaml` (also editable in Settings):

```yaml
provider: claude-code          # or codex
auth: subscription             # or api-key
browser: playwright-profile    # or playwright-extension, claude-in-chrome (Claude plans only)
headless: false
dryRun: true                   # nothing is submitted while this is true
schedule: ["09:00", "13:00", "19:00"]
timezone: auto
limits: { perDay: 15, perCompany30d: 2, reviewFirst: 10, runTimeoutMinutes: 30 }
sources: { greenhouse: true, lever: true, ashby: true, linkedin: false }
companies:
  - { name: Acme Rockets, ats: greenhouse, token: acmerockets }
rules:
  roles: [engineer, developer]
  excludeTitles: [intern, principal]
  locations: [remote, Berlin]
  neverApply: [My Current Employer]
```

## Safety, and job-site terms of service

- **It never solves CAPTCHAs, sends emails or messages, creates accounts or invents facts.** Those go to you.
- **LinkedIn is off by default and not automated in v0.1.** LinkedIn's [User Agreement](https://www.linkedin.com/legal/user-agreement) (section 8.2) forbids bots and automated access, and LinkedIn [restricts accounts](https://www.linkedin.com/help/linkedin/answer/a1341387) that use them. A future opt-in will require a typed acknowledgment and a low cap. The risk would be yours.
- **Other sites have terms too.** You are responsible for using this within each site's terms and the law where you live.
- **Postings that ask for no AI tools are skipped.**
- **Job pages are untrusted input.** The agent is told to ignore instructions on pages, and the rules that matter (no submit in dry run or review, caps, no invented answers, submit once) are enforced by the desk tools, not by the prompt.
- **Dry run is enforced in the browser too.** With Playwright, dry run loads a network guard that aborts every non-read request before it leaves your machine. Some job sites save what you type as you type (Ashby) or upload the resume the moment it is attached (Greenhouse); the guard stops that too. Claude in Chrome mode has no such guard, so use Playwright for dry runs.
- **Quality over volume.** The defaults are deliberately low. A few well-matched applications get more replies than hundreds of generic ones, and they don't waste recruiters' time.
- **You are the applicant.** Everything it submits is in your name. Keep review mode on until you trust it.

## Roadmap

- **v0.1 (now):** Greenhouse, Lever, Ashby; Claude Code and Codex; dashboard and question queue; answer memory; scheduler; dry run and review mode
- **v0.2:** Workday (accounts you create, optional OS keychain), reply tracking from your inbox (read-only), drafts for email-only postings, Windows
- **v0.3:** optional LinkedIn with acknowledgment, company watchlist, phone notifications, more ATSs (SmartRecruiters, Workable, Recruitee) and regional job boards

## Contributing

Site playbooks (`playbooks/*.md`) and ATS adapters (`src/sources/`) are the easiest places to start. Tests run against saved pages in `fixtures/` with a fake persona; never commit real personal data. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

```bash
npm install
npm run check      # lint + typecheck + tests
npm run build
```

## License

[MIT](LICENSE)

---

Built by [Prateek Verma](https://github.com/Pvk1294).
