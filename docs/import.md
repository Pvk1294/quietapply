# Importing from another tracker

Already keep your applications in a spreadsheet, a JSON file or another tool? `quietapply import` brings
that in, so QuietApply knows who you are, what you have already answered and where you have already applied.

```bash
quietapply import ~/my-job-search --dry-run   # shows what it would bring in, writes nothing
quietapply import ~/my-job-search
```

Everything goes into your data folder (`~/.quietapply`) only. Importing the same folder twice adds nothing new.

## What it reads

Put up to four files in a folder. JSON, YAML and CSV all work (CSV: the first row is the header).

| File | What it holds | What QuietApply does with it |
|---|---|---|
| `profile.json` | name, email, phone, city, country, links, years of experience, resume file | fills your profile; city and country also fill "Which country do you live in?" |
| `answers.csv` | `question`, `answer`, optional `key`, `company`, `aliases` (`|` between wordings), `source` | saves each one in the answer memory, marked `import: <label> (<source>)` so you can see where it came from |
| `applications.json` | `company`, `title`, `url`, `appliedAt`, `status`, `location` | records each one as already applied |
| `targets.yaml` | `roles`, `excludeTitles`, `locations`, `neverApply`, `companies`, `experienceYears` | adds them to your rules and company list (nothing is removed) |

Common field names are recognised without a mapping, for example `role` or `job_title` for the title,
`job_url` or `link` for the URL, and `applied_at` or `date` for the date. CSV headers are matched exactly,
so use lower-case names or a mapping.

## Imported applications

- They count as **already applied**: QuietApply never applies again to the same company and role, even through
  a different link ("Acme, Inc." and "Acme" are the same company, and "(Remote)" in a title is ignored).
- They count toward the limits by the date they were sent: **2 per company in 30 days** and the daily limit.
  A row without a date counts as sent today.
- They do **not** end review mode. Your first 10 applications made by QuietApply itself still wait for your OK.
- Rows whose status says they were never sent (`Prepared`, `Draft`, `Saved`, `Shortlisted`, `Blocked`,
  `Not applied`, `Skipped`) are left out. Change the list with `skipStatuses` in the mapping.
- The original status (Applied, Rejected, Interview…) is kept in the application's note.

## A mapping, when your files look different

Add `quietapply-import.yaml` to the folder to name the files and fields. Each entry under `fields` is
*QuietApply field: your field*. Use dots for nested fields, and `file.json#path` when the list sits inside
an object. Paths can be absolute, so you can point at your tracker's files without copying them.

```yaml
label: my old runner
files:
  profile: me.json
  answers: answers.csv
  applications: /path/to/tracker.json#applications
  targets: targets.yaml
fields:
  applications: { title: role, url: job_url, appliedAt: applied_at }
  profile: { phone: contact.mobile, city: home.city, country: home.country }
skipStatuses: [prepared, draft]
```

A full working example with fake data is in [`fixtures/import/old-runner`](../fixtures/import/old-runner).

## Afterwards

- Check **Memory** in the dashboard: every imported answer shows where it came from. Sensitive questions
  (visa, EEO, consent and the rest in `safety.alwaysAsk`) still come back to you for each application.
- Run `quietapply doctor` to see what setup still lacks.
