import { copyFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Config } from "../core/config.js";
import type { DB } from "../core/db.js";
import type { Paths } from "../core/paths.js";
import { listAnswers, saveAnswer } from "../memory/answers.js";
import { type Profile, saveProfile } from "../memory/profile.js";
import { STANDARD_QUESTIONS } from "../memory/seed.js";
import type { Provider } from "../providers/types.js";
import { profileFromAgent } from "../resume/agent.js";
import { extractResumeText } from "../resume/extract.js";
import { mergeProfiles, parseResumeText } from "../resume/parse.js";

/**
 * The non-interactive core of `init`: copy the resume into the data folder, build the profile
 * (rule-based parse, improved by the agent when one is available) and save it.
 */
export async function importResume(
  file: string,
  p: Paths,
  provider?: Provider,
): Promise<{ profile: Profile; usedAgent: boolean; text: string }> {
  const text = await extractResumeText(file);
  if (text.length < 40) throw new Error("Could not read text from the resume. Is it a scanned image?");
  const target = `resume${extname(file).toLowerCase() || ".txt"}`;
  copyFileSync(file, join(p.resumeDir, target));
  let profile = parseResumeText(text);
  let usedAgent = false;
  if (provider && provider.id !== "fake") {
    const better = await profileFromAgent(provider, text);
    if (better) {
      profile = mergeProfiles(profile, better);
      usedAgent = true;
    }
  }
  profile.resumeFile = target;
  saveProfile(profile, p);
  return { profile, usedAgent, text: basename(file) };
}

/** Store the safe defaults (demographics: "I prefer not to answer"; referral source) without asking. */
export function seedDefaults(db: DB): number {
  let n = 0;
  for (const q of STANDARD_QUESTIONS) {
    if (!q.default) continue;
    saveAnswer(db, { key: q.key, question: q.question, answer: q.default, type: q.type, source: "default" });
    n++;
  }
  return n;
}

/**
 * What setup still lacks for real forms to go through, in plain words. Shown at the end of `init`
 * (always with --yes, which asks nothing) and by `doctor`. Empty when nothing important is missing.
 */
export function setupGaps(db: DB, profile: Profile, config: Config): string[] {
  const gaps: string[] = [];
  if (!profile.location.trim()) gaps.push("your city and country (most forms ask where you live)");
  const known = new Set(listAnswers(db).map((a) => a.key));
  const essential = STANDARD_QUESTIONS.filter((q) => q.essential);
  const missing = essential.filter((q) => !known.has(q.key));
  if (missing.length)
    gaps.push(
      `${missing.length} of the ${essential.length} common questions (${missing.map((q) => q.key.replace(/_/g, " ")).join(", ")}): a form that asks one waits for you`,
    );
  if (!config.rules.roles.length)
    gaps.push("job titles: without them every open role at your companies is queued");
  if (!config.companies.length) gaps.push("careers pages to watch: discover has nothing to look at");
  return gaps;
}
