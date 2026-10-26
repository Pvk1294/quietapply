import { type Region, regionsOf } from "../companies/regions.js";
import { countryByName } from "../memory/countries.js";
import type { Profile } from "../memory/profile.js";
import { type Rules, SENIORITY } from "./config.js";
import { norm } from "./text.js";

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
 * reason, so you can see why something was not applied to.
 */
export function checkFit(job: JobFacts, rules: Rules, profile?: Profile): FitResult {
  const company = norm(job.company);
  if (rules.neverApply.some((c) => norm(c) === company))
    return { fit: false, reason: "company is on your never-apply list" };

  const excluded = rules.excludeTitles.find((x) => includesWord(job.title, x));
  if (excluded) return { fit: false, reason: `title contains excluded word "${excluded}"` };

  if (rules.roles.length && !rules.roles.some((r) => includesWord(job.title, r)))
    return { fit: false, reason: `title "${job.title}" matches none of your roles` };

  const where = checkLocation(job.location ?? "", rules);
  if (where) return { fit: false, reason: where };

  if (rules.seniority.length) {
    const level = seniorityOf(job.title);
    if (!rules.seniority.includes(level))
      return { fit: false, reason: `title "${job.title}" looks ${level} level, not one you chose` };
  }

  if (rules.minSalary && job.description) {
    const pay = parseSalary(job.description);
    if (pay && pay.currency === rules.minSalary.currency.toUpperCase() && pay.max < rules.minSalary.amount)
      return {
        fit: false,
        reason: `pay tops out at ${pay.currency} ${pay.max.toLocaleString("en")}, below your minimum`,
      };
  }

  if (job.description && NO_AI.test(job.description))
    return { fit: false, reason: "posting asks applicants not to use AI tools" };

  const notes: string[] = [];
  const years = requiredYears(job.description ?? "");
  if (years !== undefined && profile?.totalYears !== undefined) {
    if (years > profile.totalYears + 1)
      return { fit: false, reason: `asks for ${years}+ years; you have ${profile.totalYears}` };
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

/** Countries with their own region code: a job in "Bengaluru" counts as India without saying so. */
const COUNTRY_REGION: Record<string, Region> = { in: "in", us: "us", gb: "uk", ca: "ca" };

/** Why a job's location does not fit, or undefined when it does. */
function checkLocation(location: string, rules: Rules): string | undefined {
  if (!location || (!rules.locations.length && !rules.countries.length)) return undefined;
  const loc = norm(location);
  const regions = regionsOf(location);
  const isRemote = regions.includes("remote");
  const countries = rules.countries.map((c) => ({ raw: c, known: countryByName(c) }));
  const wantRegions = new Set(countries.map((c) => (c.known ? COUNTRY_REGION[c.known.code] : undefined)));
  const inCountry = countries.some(
    (c) =>
      loc.includes(norm(c.raw)) ||
      (c.known &&
        (loc.includes(norm(c.known.name)) || regions.includes(COUNTRY_REGION[c.known.code] as Region))),
  );
  const acceptsRemote = rules.locations.some((l) => norm(l) === "remote");
  if (isRemote && acceptsRemote) {
    // "Remote - US" is no use to someone who can only work from India.
    const named = regions.filter((r) => r !== "remote");
    if (countries.length && named.length && !inCountry && !named.some((r) => wantRegions.has(r)))
      return `remote role limited to "${location}", outside your countries`;
    return undefined;
  }
  const cities = rules.locations.filter((l) => norm(l) !== "remote");
  const inCity = cities.some((l) => loc.includes(norm(l)));
  if (inCity) return undefined;
  // With cities listed, a job must be in one of them; with only countries, anywhere in those countries.
  if (!cities.length && inCountry) return undefined;
  return `location "${location}" is not in your locations`;
}

/** The seniority level a title signals; titles without a level word are "mid". */
export function seniorityOf(title: string): string {
  const order = ["director", "lead", "staff", "senior", "intern", "entry", "mid"];
  for (const id of order) {
    const level = SENIORITY.find((s) => s.id === id);
    if (level?.words.some((w) => includesWord(title, w))) return id;
  }
  return "mid";
}

const CURRENCY_SYMBOL: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "₹": "INR" };

/**
 * The top of a yearly pay range stated in a posting, e.g. "$120,000 - $150,000" → USD 150000,
 * "₹25-30 LPA" → INR 3000000. Hourly figures are ignored; monthly ones are multiplied by 12.
 */
export function parseSalary(text: string): { currency: string; max: number } | undefined {
  const re =
    /(USD|EUR|GBP|INR|CAD|AUD|SGD|[$€£₹])\s?(\d[\d,.]*)\s*(k|lpa|lakhs?|l)?(?:\s*(?:-|–|—|to)\s*(?:USD|EUR|GBP|INR|CAD|AUD|SGD|[$€£₹])?\s?(\d[\d,.]*)\s*(k|lpa|lakhs?|l)?)?([^.\n]{0,24})/i;
  const m = re.exec(text);
  if (!m) return undefined;
  const [, cur, lo, loUnit, hi, hiUnit, after = ""] = m;
  if (/hour|hr\b/i.test(after)) return undefined;
  const sym = cur!.toUpperCase();
  let currency = CURRENCY_SYMBOL[sym] ?? sym;
  if (currency === "USD" && /\b(CAD|AUD|SGD)\b/.test(after)) currency = /\b(CAD|AUD|SGD)\b/.exec(after)![1]!;
  const unit = (hiUnit ?? loUnit ?? "").toLowerCase();
  const amount = (s: string) => {
    // "1,20,000" and "120.000" are thousands separators; "1.5" before k/lpa is a decimal.
    const n = unit && /^\d+\.\d{1,2}$/.test(s) ? Number(s) : Number(s.replace(/[,.]/g, ""));
    const mult = unit === "k" ? 1_000 : unit.startsWith("l") ? 100_000 : 1;
    return n * mult;
  };
  let max = amount(hi ?? lo!);
  if (/month/i.test(after)) max *= 12;
  // A bare "$5" or "€30" is not a salary.
  if (!Number.isFinite(max) || max < 1_000) return undefined;
  return { currency, max };
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
