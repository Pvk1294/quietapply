# Contributing to QuietApply

Thanks for helping. QuietApply fills in job applications in people's names, so the bar is: correct, honest, and safe by default.

## Ground rules

- **Never commit real personal data.** No resumes, answers, names, emails, phone numbers, application history, logs or browser profiles. Use the fake persona (Jane Doe, `jane.doe@example.com`, `+1 555 010 0199`) and the made-up companies in `fixtures/`. CI runs gitleaks.
- **No CAPTCHA solving, no bypassing bot checks, no sending messages.** Pull requests that add these will be closed.
- **Rules belong in code, not only in prompts.** If something must never happen (submitting in dry run, an answer without a memory id), enforce it in the desk tools (`src/mcp/desk.ts`) and add a test.
- **No network in tests.** Use `fixtureFetcher` (`tests/helpers/fixtures.ts`) and saved pages.

## Setup

```bash
npm install
npm run check        # Biome lint, TypeScript, Vitest
npm run build        # server (tsc) and dashboard (Vite)
node dist/cli/index.js demo
```

Work on the dashboard with hot reload: run `node dist/cli/index.js demo` in one terminal and `npm run dev:web` in another.

`QUIETAPPLY_HOME=/tmp/qa` points every command at a throwaway data folder.

## Good first contributions

- **A site playbook** (`playbooks/<ats>.md`): short, factual notes on how a job site's form behaves. No personal data.
- **An ATS adapter** (`src/sources/<ats>.ts`): list open jobs from the site's public API, with a fixture JSON and a test. Add the URL pattern to `src/sources/detect.ts`.
- **A fixture page**: save the structure of a real form, replace every company and person detail with made-up ones, and add a parse test in `tests/ats.test.ts`.
- **Standard questions** (`src/memory/seed.ts`): more phrasings that map onto an existing key.

## Layout

```
src/cli/        commands (init, doctor, run, schedule, dashboard, demo, …)
src/core/       config, SQLite store, fit gate, caps, lock
src/memory/     profile, answer memory, question queue, standard questions
src/mcp/        desk tools and the MCP server the agent talks to
src/providers/  Claude Code, Codex, and the fake provider
src/runner/     run loop, prompt builder, scripted agent, discovery
src/sources/    Greenhouse, Lever, Ashby adapters and URL detection
src/forms/      HTML form parser
src/scheduler/  due-slot logic, launchd and systemd units
src/server/     dashboard API (Hono)
web/            dashboard (React + Vite)
prompts/        agent instructions
playbooks/      per-site notes for the agent
fixtures/       fake persona and saved pages of made-up companies
```

## Pull requests

- Keep them small and focused, with a test for behaviour changes.
- `npm run check` must pass.
- Describe what you tested and how (fixture, dry run, live dry run with `scripts/live-dry-run.mjs`).
