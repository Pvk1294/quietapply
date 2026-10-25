# Greenhouse

- Job pages live on `job-boards.greenhouse.io/<board>/jobs/<id>` or `boards.greenhouse.io/...`; companies also embed the form on their own careers site (`?gh_jid=<id>`). The form is on the job page itself, below the description ("Apply for this job").
- Standard fields: First Name, Last Name, Email, Phone, Resume/CV (file **or** "enter manually": always use the file), Cover Letter (optional).
- Custom questions are named `question_<number>`. Dropdowns are often custom comboboxes: click, then type to filter and pick the option.
- Location fields may autocomplete; type the city and choose the first matching suggestion.
- The "Voluntary Self-Identification" (EEO) block is optional. Use stored answers; the default is the "decline to answer" option.
- Greenhouse may run an **invisible** reCAPTCHA on submit. That is fine. If a visible challenge appears, `mark_blocked` with `captcha`.
- Success: the page shows "Thank you for applying" or similar. Some boards send a security code by email before submitting: that is `otp`, hand it over.
