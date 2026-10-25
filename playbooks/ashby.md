# Ashby

- The job page is `jobs.ashbyhq.com/<company>/<job-id>`; the form is on the "Application" tab (`/application`). The page is a single-page app: wait for the form to render before reading it.
- System fields: Name, Email, Resume (`_systemfield_*`). Ashby often parses the resume and prefills fields; check every prefilled value against the profile.
- Yes/No questions are often two buttons rather than radios: click the right one and confirm it is highlighted.
- Consent checkboxes ("I agree to … storing my data") are required. Look them up like any question: the applicant's stored consent answer covers them. Without one, ask_human.
- Success: "Thanks for applying" or "Application submitted" replaces the form.
