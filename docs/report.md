# QuietApply: night 2 report (28 Oct 2026)

**Summary**
1. **Dogfooded on 3 real, live jobs in dry run** (Jane Doe persona, never submitted): GitLab on Greenhouse, Palantir on Lever, Linear on Ashby. I found 22 problems in the form parser, answer lookup, prompt and agent, fixed them, and saved sanitized copies of the three forms as test fixtures.
2. **Dry run is now enforced in the browser, not just in the prompt.** A network guard blocks every request that would send data. It mattered: Ashby saves what you type as you type, and Greenhouse uploads the resume the moment it is attached. A dry run without the guard would have sent both.
3. **New:** screenshots on each application in the dashboard; `quietapply add <url>` fetches the title, company, location and description; a test for the interactive `init` flow (it found a bug, now fixed).
4. **Checks pass:** lint, types, build and 108 tests (78 before), also on a fresh clone. Branch `dot/170-quietapply-real-job-dry-runs-screenshots`, not pushed.

## The real jobs (dry run, 28 Oct)
| Job | ATS | Before fixes | After fixes |
|---|---|---|---|
| [GitLab: Backend Engineer (Ruby), Create: Change Record](https://job-boards.greenhouse.io/gitlab/jobs/8891301002) | Greenhouse | ~6 fields filled (none recorded), 3 questions (1 merged two questions), no screenshot | 12 fields recorded (incl. dropdowns, EEO), 3 exact questions, screenshot |
| [Palantir: Backend Software Engineer, Application Development](https://jobs.lever.co/palantir/10dfc8bc-99ad-4ca2-ab76-853cb90a92c2) | Lever | **0 fields filled**, 7 questions (2 merged or annotated), 148 KB prompt | 14 fields recorded, 7 exact questions, 16 KB prompt, screenshot |
| [Linear: Senior / Staff Fullstack Engineer](https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff) | Ashby | ~6 fields filled (none recorded), 6 questions, no screenshot | 7 fields recorded, 5 exact questions, screenshot |

Each run took 25 to 55 seconds with Sonnet, about USD 0.08 to 0.27 at API prices (it ran on your plan). All stopped at "needs answers", which is right: each form had required questions that Jane's memory cannot answer (essays, clearance, "worked here before?").

```mermaid
flowchart TD
  R[Runner, dry run] --> A[Claude Code]
  A --> P[Playwright browser]
  P --> G{Guard: is it a read?}
  G -->|GET| S[Job site]
  G -->|POST, upload, autosave| X[Blocked + logged]
  A --> D[Desk: answers, questions]
  A --> SS[Screenshot in run folder]
  SS --> UI[Dashboard: application page]
  D --> UI
```

## What I found on the real forms, and fixed
**Safety**
- The prompt was the only thing stopping a dry-run submit. Now Playwright loads [a network guard](../browser/dry-run-guard.cjs) through [Playwright MCP's `--init-page` option](https://github.com/microsoft/playwright-mcp). It aborts every request that is not a read and logs it to the run folder. Blocked in these runs: Ashby autosave (`ApiSetFormValue`, 7 times in one run), Ashby and Greenhouse resume uploads (S3), Lever's hCaptcha config and analytics. Checked in a real Chrome against a local page: the form post, the `fetch` POST and the beacon never reached the server.

**Form parser** ([parse.ts](../src/forms/parse.ts))
- Lever: the resume input was missed (it is hidden with `tabindex=-1`). "Current location" was missed (a hidden twin input confused the label search). A marketing-consent checkbox was read as two options.
- Lever: every form was flagged as a CAPTCHA. The `h-captcha` div on Lever forms is an invisible check that only runs at Submit; the agent saw no challenge on the page.
- Greenhouse (new React boards): Resume/CV and Cover Letter were labelled "Attach" (the button text), and every dropdown was read as a text box. Fixed: upload questions take their group label; React comboboxes are selects.
- Ashby: Yes/No questions are two buttons over a hidden checkbox and were missed; required markers sit on the title's CSS class. Both are now read.

**Answer lookup** ([answers.ts](../src/memory/answers.ts), [profile.ts](../src/memory/profile.ts), [seed.ts](../src/memory/seed.ts))
- "Are you subject to any employment agreements … with your current employer?" was answered **"Initech"** (the current-company field). Yes/no questions are no longer answered from profile fields.
- "Please tell us how you heard about this opportunity" missed the stored "Company careers page" default. Now it matches, and the agent mapped it to Palantir's "Palantir Website" option.
- University, years of experience and "preferred name" now come from the profile.
- Two of the three forms asked for country of residence, so there is a new essential setup question, "Which country do you live in?". `init` now asks 8 questions instead of 7.

**Prompt and agent** ([system.md](../prompts/system.md), [desk.ts](../src/mcp/desk.ts), [prompt.ts](../src/runner/prompt.ts))
- Palantir's university dropdown has 3,301 options, which made a **148 KB prompt** (about 37k tokens). Dropdowns in the prompt are now cut to 25 options with a "N more on the page" note: 16 KB.
- The agent merged two questions into one card, or added notes ("…(required, free text)"), so the saved answer would not match next time. It now asks one question per card with the form's exact label; notes go into the context. The desk strips a trailing `*`.
- On Palantir it filled nothing once it saw an unknown question. In all three runs, what it had filled was never recorded and no screenshot was taken. Now it fills everything it knows, records progress with `start_submit` even when questions are open (shown as "Filled so far" in the dashboard), and always takes a screenshot.
- Greenhouse boards on a company's own careers site (for example [Stripe's](https://boards-api.greenhouse.io/v1/boards/stripe/jobs/6176758), whose `absolute_url` is stripe.com) redirect away from Greenhouse. Discovery and `add` now store [Greenhouse's embeddable form](https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=6176758) for those boards.

**Fixtures:** [greenhouse-hooli-real-form.html](../fixtures/ats/greenhouse-hooli-real-form.html), [lever-vandelay-real-form.html](../fixtures/ats/lever-vandelay-real-form.html) and [ashby-pendant-real-form.html](../fixtures/ats/ashby-pendant-real-form.html) contain the form markup only. Scripts, styles, site keys and descriptions are removed, company names are replaced with made-up ones, and the long dropdown is cut to 40 options. Tests: [real-forms.test.ts](../tests/real-forms.test.ts).

## The three features
- **Screenshots in the dashboard:** Playwright now writes into each application's run folder (`logs/run-N/app-M/`). The application sheet shows every screenshot there, newest first, with the run, the time and how many requests the guard blocked. Images are served only from those folders and only as plain image names; the test tries path tricks ([evidence.ts](../src/runner/evidence.ts), [server test](../tests/server.test.ts)). The demo includes one, so you can see it without an AI.
- **`quietapply add <url>`** looks the job up with [Greenhouse's job endpoint](https://developers.greenhouse.io/job-board.html), [Lever's posting endpoint](https://github.com/lever/postings-api) or the [Ashby board](https://developers.ashbyhq.com/docs/public-job-posting-api). Lever and Ashby return no company name, so it comes from your company list, or from the board name ("palantir" → "Palantir"). `--company`/`--title` override it; `--no-fetch` skips the lookup; a failed lookup still queues the job. Tried live: all three jobs plus Stripe came back right ([add.ts](../src/cli/add.ts), [add.test.ts](../tests/add.test.ts)).
- **Interactive `init` test:** a scripted user answers the real prompt calls. It covers a first run, a re-run that asks only what is missing, API-key login, Ctrl-C and `--yes` ([init.test.ts](../tests/init.test.ts)). **Bug found:** re-running `init` dropped contact details you had corrected; they are now kept.

## Still broken or not done
- **Uploads cannot be checked in dry run.** The guard blocks them, so screenshots show "no file attached" on Greenhouse and Ashby. The first live (review-mode) run is where uploads get tested.
- **Screenshots are full-page** (up to 5,700 px tall, mostly job description). I asked the agent to capture only the form; in the last runs it still took the whole page. The thumbnail shows the top; tap it for full size.
- **Ashby questions are not known before the run.** The form loads through Ashby's internal GraphQL, not the public API, so the prompt carries only the core answers and the agent looks the rest up live (as designed).
- **The guard only works with Playwright.** It is untested with the Playwright browser extension, and there is no guard in Claude in Chrome mode.
- **A Lever page snapshot overflowed** on the 3,301-option dropdown. The agent recovered; a playbook note now tells it to pick the option by label.
- **Live submit is still untested** (by design), as is Codex. Lever runs an invisible hCaptcha at Submit and Ashby has reCAPTCHA keys in its page data, so live runs may hit challenges at Submit. Those go to "Finish yourself".
- The `init` test simulates the prompts. A real-terminal run with `expect` showed keystrokes moving through the prompts, but I could not make it a reliable automated check.

## Next steps
1. One **review-mode** run on a real job you would actually apply to (with your own profile): watch the browser and approve or decline in the dashboard. That is the first test of uploads and Submit.
2. Make screenshots form-only in code (crop to the form element after the run) instead of relying on the agent.
3. Show the guard's blocked requests on the application page (the log is already saved).
4. One live Codex dry run.
5. Create `main` from this branch, then npm publish (needs your approval).

---

# QuietApply: night 1 report (26 Oct 2026)

**Summary**
1. QuietApply v0.1 works end to end in dry-run mode: setup from a resume, answer memory, question queue, runner, Greenhouse/Lever/Ashby, dashboard, scheduler. It never submits while dry run is on.
2. Checked live once: your Claude Code (Sonnet) with Playwright MCP filled the Lever fixture page on localhost. It cited a memory id for every field and stopped before Submit ([script](../scripts/live-dry-run.mjs)).
3. Checks pass on a fresh clone and on GitHub CI: lint, types, build and 78 tests.
4. Private repo: [github.com/Pvk1294/quietapply](https://github.com/Pvk1294/quietapply), branch `v0.1-night1`. Everything is pushed (you approved the push), and GitHub CI is green: Linux and macOS, Node 22 and 24, plus the gitleaks secret scan.
5. No real application, email or post was sent. None of your data or your old code was copied or changed.

## What works
- **Repo:** TypeScript, Biome lint, Vitest, MIT license. CI runs lint, types, build and tests on Node 22 and 24 (Linux and macOS), plus a gitleaks secret scan ([ci.yml](../.github/workflows/ci.yml)). The `.gitignore` keeps user data out.
- **Data:** everything is in `~/.quietapply` (folder mode 700): `config.yaml`, `profile.yaml`, and SQLite `data.db` using Node's built-in `node:sqlite`, so there is nothing native to compile ([db.ts](../src/core/db.ts)).
- **Answer memory:** structured entries instead of one growing prompt. Each entry has a key, other wordings and a scope (everywhere / one company / one ATS). Lookup returns *known* (with an id), *maybe* or *unknown*, and never guesses ([answers.ts](../src/memory/answers.ts)). There are 25 standard questions with the wordings forms use ([seed.ts](../src/memory/seed.ts)).
- **`quietapply init`:**
  - finds Claude Code and Codex, and lets you choose the provider and browser
  - reads a PDF, DOCX or text resume; a rule-based parser runs first and your own agent improves it
  - asks only the essential questions; anything skipped is asked later, when a form needs it ([init.ts](../src/cli/init.ts))
- **Desk MCP server:** the agent's only way to read or change your data.
  - `start_submit` refuses any value without a valid memory id.
  - It decides dry run / review / limits in code, and marks the application "submitting" before the click, so an unclear result is never resent ([desk.ts](../src/mcp/desk.ts)).
- **Providers:**
  - Claude Code: `claude -p` with a strict MCP config. Only the desk and browser tools are allowed, and your own settings are not loaded.
  - Codex: `codex exec --json`, with the MCP servers passed as `-c` overrides.
  - Both recognise usage-limit messages ([providers/](../src/providers)).
- **Runner:** pause flag, lock, fit gate (titles, locations, never-apply list, years, skills, "no AI" postings), 15 per day, 2 per company per 30 days, review mode for the first 10. The prompt is small (a few KB): it carries only the answers that this form needs ([run.ts](../src/runner/run.ts), [prompt.ts](../src/runner/prompt.ts)).
- **ATS:**
  - Jobs are found through the public APIs (no scraping): [Greenhouse](https://developers.greenhouse.io/job-board.html), [Lever](https://github.com/lever/postings-api), [Ashby](https://developers.ashbyhq.com/docs/public-job-posting-api).
  - A form parser reads labels, types, required flags and options, and spots CAPTCHAs.
  - Tested on fixture pages for made-up companies ([fixtures/ats](../fixtures/ats)).
  - I checked the live API shapes with read-only requests tonight. Greenhouse also returns an AI-disclaimer field, which the fit gate now reads.
- **Dashboard:**
  - pages: Today, Applications (each value typed and its memory id), Questions (answer once; remember for all or for one company), Finish yourself, Memory, Runs, Settings
  - Run now and Pause buttons; works on desktop and phone, light and dark
  - listens on 127.0.0.1 only, with host and CSRF checks
  - screenshots in [docs/screenshots](screenshots)
- **Scheduler:** launchd / systemd user timer calling `quietapply tick` every 15 minutes. Missed runs are merged into one, a failed run gets one retry, and the logic comes from your runner ([scheduler/](../src/scheduler)). I did not install it on your Mac.
- **Docs:** [README](../README.md), [CONTRIBUTING](../CONTRIBUTING.md), [SECURITY](../SECURITY.md), [how it works](how-it-works.md).

```mermaid
flowchart TD
  I[quietapply init] --> M[(Profile + answer memory)]
  D[discover: public ATS APIs] --> Q[Queue]
  Q --> R[Runner: fit gate, caps]
  R --> A[Claude Code / Codex]
  A --> B[Playwright browser]
  A --> K[Desk tools]
  K --> M
  K --> UI[Dashboard]
  UI -->|answers, approvals| M
```

## What is stubbed or not done
- **Codex has not been run live.** It is not installed on this Mac. The command line is unit-tested, and the `-c mcp_servers…` syntax follows the documented config, but it still needs one real run ([Codex docs](https://learn.chatgpt.com/docs/non-interactive-mode)).
- **Live mode (dry run off) has never submitted a real application.** By design, nothing real was tried tonight.
- **Not built yet:**
  - Workday, LinkedIn (off; config only), reply tracking, Windows scheduling
  - npm publishing, so `npx quietapply` does not work yet; for now: clone, then `npm link`
  - screenshot evidence in the dashboard (the agent saves screenshots to `logs/`, but the UI does not show them yet)
- **Not tested end to end:** the interactive `init` flow (its building blocks are tested, and a non-interactive `init --yes` was run).
- **Not wired in:** Claude in Chrome mode is built into the command line but was not tried.

## Try it locally (3 commands)
```bash
cd ~/Desktop/quietapply && npm install && npm run build
node dist/cli/index.js demo        # fake "Jane Doe" data, opens http://127.0.0.1:4777
node scripts/live-dry-run.mjs      # optional: one real dry run with your Claude Code on a local fixture (about 1 min)
```

## Waiting for you
- **No pull request yet.** The repo has no `main` branch, and pushing to main is not something I'm allowed to do. Create `main` from `v0.1-night1` when you are happy with it.
- The guard paused one push overnight; you approved it in the morning, and it is done.

## Open decisions
- **Name:** QuietApply (npm and GitHub names were free on 26 Oct per the planning report). It is used only in `package.json`, the README and the UI, so it is easy to rename.
- **Stack:** TypeScript, Hono, React + Vite, SQLite through `node:sqlite`. This needs **Node 22.13+**, not the 20+ in the plan; that is the cost of having no native module to compile.
- **Lint:** Biome instead of ESLint (one dependency, fast). Easy to swap.
- **License:** MIT, as in the plan.
- **Defaults:**
  - dry run on, 10 reviews before Submit, 15 a day, 2 per company per 30 days
  - demographic questions default to "I prefer not to answer"
  - "How did you hear about us" defaults to "Company careers page"
  - consent checkboxes are asked once during setup
- **Playwright MCP is pinned to 0.0.83** for reproducible runs. Update it on purpose, not automatically.
- **The live test used Sonnet** to keep usage on your plan low. The provider defaults to your CLI's default model unless you set `model:` in the config.

## Next steps toward v0.1
1. Create `main` from `v0.1-night1` and set it as the default branch.
2. One live Codex dry run (`npm i -g @openai/codex`, then `codex login`).
3. Dogfood in review mode on two or three real Greenhouse jobs, and watch the browser.
4. Show the agent's screenshot on each application in the dashboard.
5. A test for the interactive `init` flow; `quietapply add` should fetch the title from the API.
6. Publish to npm (needs your approval), then record the demo GIF with the fake persona.
