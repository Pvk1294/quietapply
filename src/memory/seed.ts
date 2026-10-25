/**
 * The standard questions asked once during `init`. Each has a stable key and the phrasings that ATS forms
 * use for it, so one stored answer covers every wording. The list comes from the questions a real runner
 * had to ask its owner over six weeks of applications.
 */
export interface StandardQuestion {
  key: string;
  question: string;
  /** Regexes over the normalised question text (see core/text.ts norm). */
  patterns: RegExp[];
  type: "text" | "yesno" | "number" | "choice" | "long";
  options?: string[];
  sensitive?: boolean;
  /** Pre-filled default the user can change; only for answers where declining is a safe default. */
  default?: string;
  hint?: string;
  /** Asked in the short version of init. */
  essential?: boolean;
}

const DECLINE = "I prefer not to answer";

export const STANDARD_QUESTIONS: StandardQuestion[] = [
  {
    key: "work_authorization",
    question: "Are you legally authorized to work in the countries you are applying to?",
    patterns: [
      /(legally )?(authori[sz]ed|eligible|permitted) to work/,
      /work (authori[sz]ation|permit|eligibility)/,
    ],
    type: "yesno",
    essential: true,
    hint: "Name the countries if it differs, e.g. 'Yes in India; no in the US'.",
  },
  {
    key: "sponsorship",
    question: "Will you now or in the future require visa sponsorship?",
    patterns: [/sponsor/, /visa/],
    type: "yesno",
    essential: true,
  },
  {
    key: "notice_period",
    question: "What is your notice period?",
    patterns: [
      /notice period/,
      /how soon can you (start|join)/,
      /earliest (possible )?(start|joining) date/,
      /when (can|could) you (start|join)/,
      /availability to start/,
    ],
    type: "text",
    essential: true,
    hint: "e.g. '30 days' or 'Immediately'",
  },
  {
    key: "salary_expectation",
    question: "What are your salary expectations?",
    patterns: [
      /(salary|compensation|pay|ctc) (expectation|requirement|range)/,
      /expected (salary|compensation|ctc)/,
      /desired (salary|compensation|pay)/,
    ],
    type: "text",
    sensitive: true,
    essential: true,
    hint: "Include currency and period, e.g. 'USD 120,000 per year'",
  },
  {
    key: "current_salary",
    question: "What is your current salary?",
    patterns: [/current (salary|compensation|ctc|pay)/],
    type: "text",
    sensitive: true,
  },
  {
    key: "relocation",
    question: "Are you willing to relocate?",
    patterns: [/relocat/, /willing to move/],
    type: "yesno",
    essential: true,
  },
  {
    key: "work_mode",
    question: "Which work arrangements are you open to (remote, hybrid, on-site)?",
    patterns: [
      /(remote|hybrid|on.?site|in.?office)/,
      /work (arrangement|mode|model)/,
      /days a week in (the )?office/,
    ],
    type: "text",
    essential: true,
  },
  {
    key: "commute",
    question: "Are you able to commute to the office location?",
    patterns: [/commut/],
    type: "yesno",
  },
  {
    key: "shifts",
    question: "Are you open to working night shifts or a different time zone?",
    patterns: [/shift/, /(overlap|work) with .* time ?zone/, /time ?zone/],
    type: "yesno",
  },
  {
    key: "travel",
    question: "Are you willing to travel for work? How much?",
    patterns: [/travel/],
    type: "text",
  },
  {
    key: "age_18",
    question: "Are you at least 18 years old?",
    patterns: [/(at least|over) (18|eighteen)/, /18 years/],
    type: "yesno",
  },
  {
    key: "background_check",
    question: "Are you willing to undergo a background check?",
    patterns: [/background (check|verification)/, /drug (test|screen)/],
    type: "yesno",
  },
  {
    key: "previously_employed",
    question: "Have you previously worked for this company?",
    patterns: [/(previously|ever) (been )?(worked|employed)/, /former employee/],
    type: "yesno",
    hint: "Usually 'No'. Add a company-only answer in Memory where it is 'Yes'.",
  },
  {
    key: "referral",
    question: "How did you hear about this job?",
    patterns: [/how did you (hear|learn|find out) about/, /^source$/, /where did you (find|see)/],
    type: "text",
    default: "Company careers page",
  },
  {
    key: "highest_degree",
    question: "What is your highest level of education?",
    patterns: [/highest (level of )?(education|degree|qualification)/],
    type: "text",
  },
  {
    key: "english",
    question: "How would you rate your English proficiency?",
    patterns: [/english/, /languages? (do )?you speak/],
    type: "text",
  },
  {
    key: "why_role",
    question: "In two or three sentences, what kind of role are you looking for and why?",
    patterns: [/why (are you|do you want|this role|interested)/, /what (interests|excites) you/],
    type: "long",
    hint: "Used as a base; the agent tailors it to each company without adding facts.",
  },
  {
    key: "proudest_work",
    question: "Describe a project you are proud of (2-4 sentences).",
    patterns: [/proud/, /(most )?(impressive|significant) (project|accomplishment|achievement)/],
    type: "long",
  },
  {
    key: "cover_letter",
    question: "A short base cover letter (optional).",
    patterns: [/cover letter/],
    type: "long",
  },
  {
    key: "gender",
    question: "Gender (voluntary self-identification)",
    patterns: [/gender/, /^sex$/],
    type: "choice",
    sensitive: true,
    default: DECLINE,
  },
  {
    key: "race_ethnicity",
    question: "Race / ethnicity (voluntary self-identification)",
    patterns: [/race/, /ethnic/, /hispanic|latino/],
    type: "choice",
    sensitive: true,
    default: DECLINE,
  },
  {
    key: "veteran",
    question: "Veteran status (voluntary self-identification)",
    patterns: [/veteran/],
    type: "choice",
    sensitive: true,
    default: DECLINE,
  },
  {
    key: "disability",
    question: "Disability status (voluntary self-identification)",
    patterns: [/disabilit/],
    type: "choice",
    sensitive: true,
    default: DECLINE,
  },
  {
    key: "pronouns",
    question: "Pronouns (optional)",
    patterns: [/pronoun/],
    type: "text",
    sensitive: true,
    default: DECLINE,
  },
];

export function standardQuestion(key: string): StandardQuestion | undefined {
  return STANDARD_QUESTIONS.find((q) => q.key === key);
}
