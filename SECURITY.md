# Security

QuietApply holds personal data (your resume, answers and application history) and drives a browser in your name. It is built to keep all of that on your machine.

## What it does to protect you

- All data lives in `~/.quietapply`, created with owner-only permissions (folder 700; config, profile and database 600). Nothing is sent to any QuietApply server; there is none, and there is no telemetry.
- The dashboard listens on `127.0.0.1` only. It rejects requests with a foreign `Host` header (DNS rebinding) and requires a custom header plus a same-origin check on every write (CSRF).
- Claude Code application runs get only the browser tools and the desk tools (shell, file and web-search tools are off) and do not load your own settings, hooks or MCP servers. Codex runs use its read-only sandbox, so it can read files but not change them; tighter Codex tool limits are on the roadmap.
- Job pages are treated as untrusted input. The rules that matter (no submit in dry run or review mode, caps, every value must cite a stored answer, submit at most once) are enforced in code by the desk tools.
- Site notes the agent saves are scrubbed of email addresses and phone numbers.

## What it does not protect against

- Anyone with access to your user account can read `~/.quietapply`, including the browser profile that holds your job-site sessions.
- Your AI provider (Anthropic or OpenAI) sees the prompts, which include the parts of your profile and answers that a form needs.
- Run transcripts in `~/.quietapply/logs` contain page content and the values typed into forms. Delete them when you no longer need them.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Include steps to reproduce and the version or commit. You should get a reply within a week.
