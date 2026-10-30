# QuietApply vulnerabilities and fixes

Defensive security review of [Pvk1294/quietapply](https://github.com/Pvk1294/quietapply) **v0.1.0** (self-host + `npm install quietapply`). Static/code analysis only — no exploit PoCs.

**Summary:** 0 Critical · **5 High** · **8 Medium** · several Low/Info.

---

## High

### H1 — Codex read-only sandbox can still read local secrets

**Where:** `src/providers/codex.ts`

**Issue:** Codex runs with `--sandbox read-only` and auto-approved Playwright MCP. A poisoned job page that steers the agent can read `~/.quietapply` (DB, browser cookies, SMTP fallback file), SSH keys, cloud credentials, then send them out through the browser. Claude Code is much tighter; Codex is not.

**Fix:**
- Disable Codex shell / built-in tools if the CLI allows it, or restrict readable roots to the working directory.
- Document clearly that Codex runs can read the whole disk.
- Pair with H3 (restrict browser navigation / origins).

---

### H2 — Review mode has no Playwright network submit guard

**Where:** `src/runner/run.ts`, `browser/dry-run-guard.cjs`

**Issue:** `dry-run-guard` loads only when `dryRun=true`. `reviewFirst` (default 10) is enforced by desk replies and prompts only. A misbehaving or injected agent can click Submit before `start_submit`.

**Fix:**
- Load a submit-blocking route guard in review mode as well.
- Or allow ATS write traffic only after the desk has marked the application approved.
- At minimum, document that review mode on Playwright is advisory.

---

### H3 — Playwright can reach any origin, including the local dashboard

**Where:** `src/runner/run.ts`, `src/server/app.ts`

**Issue:** No Playwright allowed-origins. The agent browser can open `127.0.0.1:4777`. Same-origin script can send `x-quietapply` and flip `dryRun` off, approve reviews, or change SMTP/settings.

**Fix:**
- Pass origin allow/deny lists to Playwright MCP.
- Block loopback and private ranges; ideally allow only the job host plus known ATS hosts.
- Use a per-session dashboard token that the browser profile does not hold.
- Deny page-script tools if they are not needed.

---

### H4 — Live Claude-in-Chrome uses your real browser with broad tools

**Where:** `src/providers/claude-code.ts`, `src/runner/run.ts`

**Issue:** In live mode, page-script / network tools are not denied. Injection on a job site reaches everyday logged-in sessions (email, bank, work apps), not a dedicated profile. LinkedIn mode already denies these tools.

**Fix:**
- Always deny script and network-read tools for Claude in Chrome (same as LinkedIn’s deny list).
- Recommend or require a dedicated Chrome profile for QuietApply.

---

### H5 — Any allowed API caller can undo safety controls and redirect SMTP

**Where:** `src/server/app.ts` (`PUT /api/settings`, `PUT /api/email`, LinkedIn consent endpoints), `src/email/secret.ts`

**Issue:** Only phone/autostart are restricted to “this Mac”. Tailscale allow-listed clients (or local processes) can set `dryRun=false`, raise caps, assert consent booleans, and point `smtp.host` at an attacker server so the stored app password authenticates there. Password lookup is by user only, not host.

**Fix:**
- Gate dangerous settings (`dryRun`, limits, email enable/host/port/user, LinkedIn consent) to `onThisMac`, or require a step-up check.
- Bind the stored SMTP credential to host + user; refuse to send if the host changed since the password was saved.
- Make consent server-side state, not a body field the client asserts.
- Allow-list or sanity-check SMTP hosts; refuse private ranges.

---

## Medium

### M1 — Agent can choose outbound email recipient

**Where:** `src/mcp/desk.ts` (`mark_blocked`), `src/email/apply.ts`

**Issue:** With email on, `mark_blocked(email_only)` stores an arbitrary address. After the global `reviewFirst` budget, resume and PII go out unreviewed to attacker-chosen recipients.

**Fix:**
- Require the address to appear in the stored posting text (or domain-match the company).
- Per-new-domain approval instead of a global review count.
- Do not trust agent-supplied recipients alone.

---

### M2 — No auth token on the loopback API

**Where:** `src/server/guard.ts`, `src/server/index.ts`

**Issue:** Host `127.0.0.1:<port>` / `localhost:<port>` is enough. Any local process or other OS user can read PII, memory, screenshots, and start runs. Fine for a single-user laptop; bad on shared hosts, CI runners, and containers.

**Fix:**
- Per-install random Bearer/cookie token (file mode 600) required on all `/api/*` and screenshot routes.
- Or serve over a Unix socket under the 700 data directory.
- Mask `sensitive` answers by default in `/api/memory`.

---

### M3 — Missing CSP / frame-ancestors (clickjacking)

**Where:** `src/server/app.ts`, `web/index.html`

**Issue:** The dashboard can be iframed. Framed SPA JS adds `x-quietapply`, so UI-redress can trigger Approve / Run / settings toggles. No CSP as an XSS backstop. Security headers are also skipped on early 403 responses.

**Fix:**
- Set `X-Frame-Options: DENY` and `Content-Security-Policy` with `frame-ancestors 'none'`, `default-src 'self'`, `base-uri 'none'`, `form-action 'self'`.
- Apply headers before the access guard returns as well.
- Consider `Cross-Origin-Resource-Policy: same-origin` on screenshots.

---

### M4 — `detectAts` trusts hostname only; `javascript:` / `file:` can match

**Where:** `src/sources/detect.ts`, dashboard `<a href={app.url}>`, discovery URL fields

**Issue:** `javascript://boards.greenhouse.io/...` parses with hostname `boards.greenhouse.io`. Values are stored and rendered as hrefs. Discovery accepts ATS-returned URLs without scheme checks. `http:` job links are also accepted as submit hosts.

**Fix:**
- Require `protocol === "https:"` and store the canonical `URL.href`.
- Allow-list hosts for Lever/Ashby URLs the same way Greenhouse `formUrl` is restricted.
- In the UI, render `href` only for `https:` URLs.

---

### M5 — Production fetcher allows `file://` and has no SSRF controls

**Where:** `src/sources/http.ts`

**Issue:** Hostile ATS-hosted URLs can become `file:///…` or cloud-metadata URLs into form parsing / prompts. On Windows, `file://host/...` may trigger UNC/NTLM. No private-IP block, response-size cap, or redirect re-check.

**Fix:**
- Keep `file://` behind a test-only `fixtureFetcher`.
- Require `https:` and an allow-listed hostname; resolve and reject loopback, link-local, and RFC1918.
- Use `redirect: "manual"` or re-check each hop; cap response size.

---

### M6 — Agent CLIs inherit full `process.env`

**Where:** `src/providers/spawn.ts`

**Issue:** Cloud keys and tokens in the parent shell are visible to Claude/Codex (worse when Codex shell is available).

**Fix:** Build an allow-listed environment (`PATH`, `HOME`, `QUIETAPPLY_*`, provider auth vars, proxies). Do not pass everything.

---

### M7 — Dry-run guard is not exfiltration-proof; Chrome hook fails open

**Where:** `browser/dry-run-guard.cjs`, `browser/chrome-guard.cjs`, `src/runner/chrome-guard.ts`

**Issue:** All GETs are allowed (query-string exfil). The guard is a Playwright `context.route` and may be bypassable if code-execution tools exist. The Chrome hook returns allow on crash / missing `node`, so protection silently stops.

**Fix:**
- Origin restrictions (see H3); consider blocking WebSockets.
- Narrow Playwright tool allow-list (no arbitrary code tools).
- Use `process.execPath` for the hook; fail closed if the hook cannot be confirmed.

---

### M8 — Submit evidence is agent-reported, not browser-verified

**Where:** `src/mcp/desk.ts` (`validateFilled`, `start_submit`), `src/core/safety.ts`

**Issue:** Approval hash binds to the agent’s reported filled fields / `page_url`, not the DOM. Values need not match stored answers; sensitive labels can be misreported.

**Fix:**
- Read the real form state and URL via a Playwright init-page hook and compare.
- Exact-match non-tailored values against stored answers.

---

## Low

### L1 — Import can copy arbitrary absolute paths as resume

**Where:** `src/import/index.ts`, `src/email/send.ts`

**Issue:** Untrusted import YAML can name any absolute path as resume (e.g. SSH keys), which may then be emailed or uploaded. `attachmentPath` lacks containment checks.

**Fix:**
- Resolve mapped paths and require them to stay inside the import folder (or warn + require a flag).
- Restrict resume extensions to `.pdf`, `.docx`, `.doc`, `.txt`.
- `realpath` containment check in `attachmentPath` and run-folder copy.

---

### L2 — Phone access trusts Tailscale Serve identity header only

**Where:** `src/server/guard.ts`, `src/phone/tailscale.ts`

**Issue:** Correct for Serve’s model, but there is no app-level secret. Funnel is string-guarded only. A Host rewrite to loopback could skip the allow-list. Combined with H5, allow-listed logins have near-full remote control.

**Fix:**
- Refuse `Tailscale-User-*` headers on local Host.
- Step-up secret for dangerous actions (see H5).
- Periodically re-check that the port is not on Funnel and warn.

---

### L3 — Secret and file-permission gaps

**Where:** `src/email/secret.ts`, `src/core/paths.ts`, config/profile writers

**Issue:** `mode 600` applies only on create; Windows has no POSIX modes; SMTP may silently fall back to plaintext JSON; same-user Keychain is readable via the `security` CLI.

**Fix:**
- `chmod 600` known files on every open/save; atomic temp+rename writes.
- Visible warning when falling back to the file store.
- Prefer a Keychain ACL that names QuietApply only.

---

### L4 — Site notes are a persistent prompt-injection store

**Where:** `src/mcp/desk.ts` (`add_site_note`), `src/runner/prompt.ts`

**Issue:** Agent-written notes for any host re-enter later prompts. Only email/phone are scrubbed; notes are not injection-scanned.

**Fix:**
- Allow notes only for the current application’s host.
- Cap count/size; mark as untrusted in the prompt; strip instruction-like text / URLs.

---

### L5 — Runtime `npx` Playwright MCP + publish / engine posture

**Where:** `package.json`, `.npmrc`, `src/runner/run.ts`

**Issue:** Each run does `npx -y @playwright/mcp@0.0.83` outside the lockfile. `engines` require Node ≥22.13 but `engine-strict=false`, so install can succeed on older Node then fail at runtime. Unscoped name; no `prepublishOnly` / provenance. (No postinstall — good.)

**Fix:**
- Depend on `@playwright/mcp` in `package.json` (or vendor) and run the locked binary.
- Remove `engine-strict=false`; fail clearly on wrong Node.
- Publish from CI with `--provenance` and 2FA; pin GitHub Actions by commit SHA.

---

### L6 — No body/rate limits; screenshot cache; sensitive memory unmasked

**Where:** `src/server/app.ts`

**Issue:** Large bodies are buffered before zod limits apply. `discover` / `run` can be abused locally. Screenshots use `max-age=3600` (cached on phone browsers). `/api/memory` returns sensitive answers unmasked.

**Fix:** Body-size + rate-limit middleware; `no-store` for screenshots; mask sensitive memory by default.

---

## Info

### I1 — `SECURITY.md` understates phone / email / multi-user risks

**Where:** `SECURITY.md`

**Issue:** Claims are mostly accurate for basic loopback use, but omit Tailscale full-API power, SMTP secret handling, multi-user loopback exposure, and runtime `npx`.

**Fix:** Expand the threat model for self-hosters and npm consumers; keep the private reporting path.

---

## Suggested fix order

1. **H3 + H5** — isolate agent browser from dashboard; Mac-only dangerous settings + SMTP host bind  
2. **H2** — review-mode network submit guard  
3. **H1 / H4** — harden Codex and live Claude-in-Chrome tool sets  
4. **M1 / M4 / M5** — email recipient, URL scheme, fetcher SSRF  
5. **M2 / M3** — local token + CSP / frame deny  
6. **L5** — lock Playwright MCP into package; fix engines; npm provenance  

---

## npm entry point note

`quietapply@0.1.0` is published on registry.npmjs.org. The tarball includes `dist/`, browser guards, prompts, and fixtures; there is no install lifecycle script. Runtime requires **Node ≥22.13** (`node:sqlite`). With `engine-strict=false`, older Node versions may install successfully and then fail when the CLI runs.
