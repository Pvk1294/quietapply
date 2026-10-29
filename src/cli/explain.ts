/** One plain line shown before each `init` question, so nobody has to guess why it is being asked. */
export const EXPLAIN = {
  provider:
    "QuietApply runs on an AI you already have: Claude Code or OpenAI Codex. Pick the one you use. It does the typing, QuietApply keeps the rules.",
  browser:
    "The agent needs a browser to fill in forms. A separate Chrome profile is the safest: it keeps your everyday browser out of it.",
  resume:
    "Your resume is the starting point. QuietApply reads it once to build your profile (name, roles, skills) and uploads it on forms. It stays on this computer.",
  contact:
    "Your name, email, phone and city go into every application. Check them and fix anything that looks off.",
  common:
    "Almost every form asks the same few questions. Answer them once now and they are remembered. Leave one empty to skip it: you will be asked later, only if a form needs it.",
  roles:
    "Job titles to look for. A job whose title contains none of these is skipped, so a few short words work best.",
  locations:
    "Where you would work. Write remote for remote roles open where you live (a role that is remote only in another country is skipped). Leave empty for anywhere.",
  never: "Companies to leave alone, such as your current employer. These are never applied to.",
  companies:
    "Paste careers-page links of companies you like (Greenhouse, Lever or Ashby). QuietApply checks them for new jobs. You can add more later.",
  perDay:
    "A daily limit keeps applications careful and your account calm. 15 is the default. Fewer, well-matched applications usually get more replies.",
  email:
    "Some postings ask you to apply by email. QuietApply can write a short email from your profile and send it from your account, but only if you say yes. Most people can say no: those jobs then go to Finish yourself with the text ready to copy.",
  autoStart:
    "QuietApply can run on its own: the dashboard starts when you log in, and it applies at the times in Settings. Nothing runs while the computer is off; a run missed then happens once, soon after you log in or it wakes.",
  linkedin:
    "LinkedIn mode is optional and off by default. It applies to LinkedIn jobs in your own Chrome, a few a day. Most people skip it. If you are curious, you can turn it on later in the dashboard, under Settings.",
} as const;
