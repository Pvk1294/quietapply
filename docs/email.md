# Sending email and messages

QuietApply can send two kinds of message for you. **Both are off by default.** You are asked first, in `quietapply init` and in **Settings**, and if you say no, QuietApply never sends any mail or message. You can turn either one off at any time in Settings.

Nothing is ever sent while dry run is on.

## 1. Email applications

Some postings say "send your resume to jobs@company.com" instead of having a form.

**With email off (the default):** the job goes to **Finish yourself** with the email ready to copy: To, Subject and Body, plus a note to attach your resume. You send it from your own mail.

**With email on:**

- **The text.** A short, plain email built only from your profile and your saved answers. No AI writes it, so it cannot contain anything you did not give QuietApply. Subject: `Application: <role>, <your name>`. Your resume is attached. If you saved a base cover letter in setup, it is included.
- **Your OK first.** Your first 10 emails wait on the Applications page, where you see the exact email. Your OK covers that exact text: if anything changes before it goes out (for example a new saved answer), it waits for you again.
- **Limits.** 10 a day by default (1 to 50). Never 2 emails to the same address within 30 days. Never anything to an address, domain or name on your **do-not-contact** list (Settings → Email).
- **A record.** Every sent email is kept on its application with To, Subject, Body and the Message-ID your mail server gave it.
- **How it is sent.** SMTP with an **app password**, for Gmail, Outlook, iCloud, Yahoo, Zoho, Fastmail and any other provider that offers SMTP. QuietApply fills in the server for the common ones. There is no Google sign-in (OAuth).
- **Where the password is kept.** In the macOS Keychain or the Linux Secret Service where available, otherwise in `~/.quietapply/smtp-password.json`, readable only by you. It is never written to a log, never shown again in the dashboard, and never put on a command line. Turning email off removes it.

### Setting it up

1. Make an app password in your mail account. For Gmail: Google Account → Security → 2-Step Verification → App passwords. Do not use your normal password.
2. In `quietapply init`, answer yes to *May QuietApply send application emails from your account?*, or open **Settings → Email applications** and press **Set up**.
3. Enter your address. Check the mail server, then paste the app password and press **Store password**.
4. Keep dry run on for a first look. The email appears on the application page with the words "written, not sent".

You can also queue an email job by hand: `quietapply add mailto:jobs@company.com --company "Company" --title "Role"`.

## 2. Messages to recruiters (LinkedIn only)

After an application goes through on LinkedIn, QuietApply can send **one** short note to the recruiter or hiring manager shown on the job page.

- **Two yeses.** It needs LinkedIn mode on, and then its own yes: *May QuietApply message recruiters on your behalf?* The default is no. Turning LinkedIn mode off turns this off too.
- **The text.** One paragraph of 40 to 90 words, built from your profile only (no AI), saying you applied and offering to share more.
- **How it is sent.** In your own logged-in browser through Claude in Chrome, at a human pace, in a separate short run after the applications. The agent can only type the exact approved text.
- **Limits.** 3 a day by default (at most 10). At most one message per person, ever. No follow-ups. Never anyone on your do-not-contact list.
- **Your OK first.** Your first 10 messages wait on the application page, bound to the exact text.
- **Stops at once** on any LinkedIn warning, limit or CAPTCHA, and LinkedIn mode stays stopped until you resume it.

## The risks, plainly

- **Spam.** Mail sent by software can be marked as spam. Too many emails, or emails that people flag, can get your mail account limited or your address put on block lists. The low default limits and the 30-day rule are there for this.
- **Account limits.** Mail providers limit how much you send in a day. LinkedIn restricts accounts it believes are automated, and messages are what it watches most. LinkedIn's User Agreement forbids automation. If you turn recruiter messages on, that risk is yours.
- **People.** Every email and message goes out in your name. Read the first ones before you approve them.

## Turning it off

- **Settings → Email applications → Turn off.** No more mail, and the stored app password is deleted.
- **Settings → LinkedIn mode → Messages to recruiters → Turn off**, or turn LinkedIn mode off.
- Or turn dry run back on: nothing at all is sent while it is on.
