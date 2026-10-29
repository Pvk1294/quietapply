import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, defaultConfig, saveConfig } from "../../src/core/config.js";
import { openDb } from "../../src/core/db.js";
import { ensureHome, type Paths, paths } from "../../src/core/paths.js";
import { saveAnswer } from "../../src/memory/answers.js";
import { Profile, saveProfile } from "../../src/memory/profile.js";

export const JANE = Profile.parse({
  name: "Jane Doe",
  email: "jane.doe@example.com",
  phone: "+1 555 010 0199",
  location: "Springfield, Oregon",
  links: {
    linkedin: "https://www.linkedin.com/in/jane-doe-example",
    github: "https://github.com/janedoe-example",
  },
  totalYears: 5,
  experience: [{ company: "Initech", title: "Software Engineer", start: "Jan 2022", end: "Present" }],
  skills: ["typescript", "javascript", "react", "node.js", "postgresql", "python", "sql", "docker"].map(
    (name) => ({ name }),
  ),
  resumeFile: "resume.pdf",
});

/**
 * A temp data folder with Jane Doe's profile, a few answers and the given config. Sensitive questions are
 * filled from memory here (alwaysAsk empty) so the fixture runs test the fill pipeline; the default, where
 * they always come back to you, is tested in safety.test.ts.
 */
export function makeHome(config: Partial<Config> = {}): Paths {
  const p = ensureHome(paths(mkdtempSync(join(tmpdir(), "qa-home-"))));
  saveConfig({ ...defaultConfig(), provider: "fake", safety: { alwaysAsk: [] }, ...config }, p);
  saveProfile(JANE, p);
  const db = openDb(p);
  const seed: [string, string, string][] = [
    ["work_authorization", "Are you legally authorized to work?", "Yes"],
    ["sponsorship", "Will you require visa sponsorship?", "No"],
    ["notice_period", "What is your notice period?", "30 days"],
    ["relocation", "Are you willing to relocate?", "No"],
    ["data_consent", "Do you agree to companies storing your application data?", "Yes"],
    ["gender", "Gender", "I prefer not to answer"],
    ["veteran", "Veteran status", "I prefer not to answer"],
    ["referral", "How did you hear about this job?", "Company careers page"],
  ];
  for (const [key, question, answer] of seed) saveAnswer(db, { key, question, answer, source: "setup" });
  db.close();
  return p;
}
