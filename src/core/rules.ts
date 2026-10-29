import type { Profile } from "../memory/profile.js";
import type { Rules } from "./config.js";
import { remoteOpenTo } from "./regions.js";
import { companyKey, norm } from "./text.js";

export interface JobFacts {
  company: string;
  title: string;
  location?: string | null;
  description?: string | null;
}

export type FitResult = { fit: true; notes: string[] } | { fit: false; reason: string };

/** Postings that ask candidates not to use AI tools are respected and skipped. */
const NO_AI =
  /(do not|don't|please don't|must not|should not) (use )?(ai|chatgpt|generative ai|llms?|artificial intelligence)( tools)?|applications? (written|generated) (by|with|using) (ai|chatgpt) (will be|are) (rejected|disqualified)|no (ai|chatgpt)[- ]generated/i;

const includesWord = (hay: string, needle: string) => ` ${norm(hay)} `.includes(` ${norm(needle)} `);

/**
 * The fit gate. Every job passes through it before the agent is started, and every skip is logged with its
 * reason, so you can see why something was not applied to. `home` is the country you live in (see
 * homeCountry): "remote" in your locations matches remote roles open to that country, not every remote role.
 */
export function checkFit(job: JobFacts, rules: Rules, profile?: Profile, home?: string): FitResult {
  // "Acme" on the list also covers "Acme, Inc." and "Acme (YC W21)".
  const company = companyKey(job.company);
  if (rules.neverApply.some((c) => companyKey(c) === company))
    return { fit: false, reason: "company is on your never-apply list" };

  const excluded = rules.excludeTitles.find((x) => includesWord(job.title, x));
  if (excluded) return { fit: false, reason: `title contains excluded word "${excluded}"` };

  if (rules.roles.length && !rules.roles.some((r) => includesWord(job.title, r)))
    return { fit: false, reason: `title "${job.title}" matches none of your roles` };

  if (rules.locations.length && job.location) {
    const loc = norm(job.location);
    const isRemote = /\b(remote|anywhere|distributed|worldwide)\b/.test(loc);
    let remoteElsewhere = false;
    const ok = rules.locations.some((l) => {
      const want = norm(l);
      if (want !== "remote") return loc.includes(want);
      if (!isRemote) return false;
      if (remoteOpenTo(job.location ?? "", home).ok) return true;
      remoteElsewhere = true;
      return false;
    });
    if (!ok)
      return {
        fit: false,
        reason: remoteElsewhere
          ? home
            ? `remote role limited to "${job.location}", not where you live`
            : `remote role limited to "${job.location}" and your country is not set`
          : `location "${job.location}" is not in your locations`,
      };
  }

  if (job.description && NO_AI.test(job.description))
    return { fit: false, reason: "posting asks applicants not to use AI tools" };

  const notes: string[] = [];
  const years = requiredYears(job.description ?? "");
  if (years !== undefined && profile?.totalYears !== undefined) {
    if (years > profile.totalYears + 1)
      return { fit: false, reason: `asks for ${years}+ years, you have ${profile.totalYears}` };
  }
  if (years !== undefined && (years < rules.experienceYears.min || years > rules.experienceYears.max))
    return { fit: false, reason: `asks for ${years}+ years, outside your range` };

  if (profile?.skills.length && job.description) {
    const required = requiredSkills(job.description, profile);
    if (required.total >= 3) {
      const share = required.matched / required.total;
      notes.push(`skills ${required.matched}/${required.total}`);
      if (share < rules.minSkillMatch)
        return { fit: false, reason: `you have ${required.matched} of ${required.total} listed skills` };
    }
  }
  return { fit: true, notes };
}

/** "5+ years", "at least 3 years", "3-5 years of experience" → the lower bound. */
export function requiredYears(text: string): number | undefined {
  const m =
    /(?:at least |minimum (?:of )?)?(\d{1,2})\s*(?:\+|-\s*\d{1,2}|to \d{1,2})?\s*\+?\s*years?(?: of)?(?: \w+){0,3} experience/i.exec(
      text,
    );
  return m ? Number(m[1]) : undefined;
}

/** A small known-skills vocabulary; the posting's mentions of these are treated as its requirements. */
const COMMON_SKILLS = [
  "javascript",
  "typescript",
  "python",
  "java",
  "go",
  "golang",
  "rust",
  "ruby",
  "php",
  "c++",
  "c#",
  "kotlin",
  "swift",
  "react",
  "vue",
  "angular",
  "next.js",
  "node.js",
  "node",
  "django",
  "flask",
  "fastapi",
  "spring",
  "rails",
  "sql",
  "postgresql",
  "postgres",
  "mysql",
  "mongodb",
  "redis",
  "kafka",
  "graphql",
  "rest",
  "aws",
  "gcp",
  "azure",
  "docker",
  "kubernetes",
  "terraform",
  "linux",
  "git",
  "machine learning",
  "pytorch",
  "tensorflow",
  "llm",
  "figma",
];

function requiredSkills(description: string, profile: Profile): { matched: number; total: number } {
  const desc = ` ${description.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ")} `;
  const mine = new Set(profile.skills.map((s) => s.name.toLowerCase()));
  const alias: Record<string, string> = { golang: "go", postgres: "postgresql", node: "node.js" };
  const wanted = new Set<string>();
  for (const s of COMMON_SKILLS) if (desc.includes(` ${s} `)) wanted.add(alias[s] ?? s);
  let matched = 0;
  for (const s of wanted) if (mine.has(s) || [...mine].some((m) => alias[m] === s)) matched++;
  return { matched, total: wanted.size };
}
