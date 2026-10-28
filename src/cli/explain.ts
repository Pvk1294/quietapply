/** One plain line shown before each `init` question, so nobody has to guess why it is being asked. */
export const EXPLAIN = {
  provider:
    "QuietApply runs on an AI you already have: Claude Code or OpenAI Codex. Pick the one you use; it does the typing, QuietApply keeps the rules.",
  browser:
    "The agent needs a browser to fill in forms. A separate Chrome profile is the safest: it keeps your everyday browser out of it.",
  resume:
    "Your resume is the starting point. QuietApply reads it once to build your profile (name, roles, skills) and uploads it on forms. It stays on this computer.",
  contact:
    "Check the details it found. These go into the name, email and phone boxes of every application, so fix anything that looks off.",
  common:
    "Almost every form asks the same few questions. Answer them once now and they are remembered. Leave one empty to skip it: you will be asked later, only if a form needs it.",
  roles:
    "Job titles to look for. A job whose title contains none of these is skipped, so a few short words work best.",
  locations: "Where you would work. Write remote for remote roles. Leave empty for anywhere.",
  never: "Companies to leave alone, such as your current employer. These are never applied to.",
  companies:
    "Paste careers-page links of companies you like (Greenhouse, Lever or Ashby). QuietApply checks them for new jobs. You can add more later.",
  perDay:
    "A daily limit keeps applications careful and your account calm. 15 is the default; fewer, well-matched applications usually get more replies.",
  linkedin:
    "LinkedIn mode is optional and off by default. It applies to LinkedIn jobs in your own Chrome, a few a day. Most people skip it. If you are curious, you can turn it on later in the dashboard, under Settings.",
} as const;
