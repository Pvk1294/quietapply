# Lever

- The job page is `jobs.lever.co/<company>/<posting-id>`; the form is at the same URL plus `/apply`.
- Standard fields: Resume/CV (upload first: Lever may prefill name/email from it; check and correct them), Full name, Email, Phone, Current company, Links (LinkedIn, GitHub, Portfolio, Other).
- Custom questions sit under "Additional questions" in cards (`cards[...]`); radios and checkboxes are common.
- "Additional information" is a free-text box: leave it empty unless a cover letter answer exists.
- Lever uses hCaptcha on some boards. A visible challenge means `mark_blocked` with `captcha`.
- Success: "Application submitted!" message on the same page.
