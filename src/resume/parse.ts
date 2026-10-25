import { Profile } from "../memory/profile.js";

/**
 * A rule-based first pass over resume text. It reliably finds contact details and links, and makes a
 * reasonable guess at sections. When a provider is available, `init` asks the agent for a better
 * structured profile and this result fills any gaps. Either way the user checks the profile.
 */
export function parseResumeText(text: string, now = new Date()): Profile {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(text)?.[0] ?? "";
  const phone = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{3,5}[\s-]?\d{3,4}[\s-]?\d{0,4}/
    .exec(text.replace(email, ""))?.[0]
    ?.trim();
  const urls = [...text.matchAll(/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s,|)]+/gi)].map((m) =>
    m[0].startsWith("http") ? m[0] : `https://${m[0]}`,
  );
  const linkedin = urls.find((u) => /linkedin\.com\/in\//i.test(u));
  const github = urls.find((u) => /github\.com\//i.test(u));
  const other = urls.filter((u) => u !== linkedin && u !== github);

  const sections = splitSections(lines);
  const header = sections.get("_header") ?? [];
  const name =
    header.find(
      (l) =>
        /^[A-Za-zÀ-ÿ.'-]+(?: [A-Za-zÀ-ÿ.'-]+){1,3}$/.test(l) &&
        !/@|\d|resume|curriculum/i.test(l) &&
        !HEADINGS.some(([, re]) => re.test(l)),
    ) ?? "";
  const headline = header.find((l) => l !== name && !l.includes("@") && !/\d{3}/.test(l) && l.length < 80) ?? "";

  const experience = parseExperience(sections.get("experience") ?? []);
  const years = experience.flatMap((e) => [yearOf(e.start), yearOf(e.end, now)]).filter((y): y is number => !!y);
  const totalYears = years.length ? Math.max(0, Math.max(...years) - Math.min(...years)) : undefined;

  return Profile.parse({
    name,
    email,
    phone: phone && phone.replace(/\D/g, "").length >= 7 ? phone : "",
    location: guessLocation(header),
    headline: headline.slice(0, 120),
    summary: (sections.get("summary") ?? []).join(" ").slice(0, 600),
    links: { linkedin, github, portfolio: other[0], other: other.slice(1) },
    totalYears,
    experience,
    education: parseEducation(sections.get("education") ?? []),
    skills: parseSkills(sections.get("skills") ?? []),
  });
}

const HEADINGS: [string, RegExp][] = [
  ["summary", /^(professional )?(summary|profile|about( me)?|objective)$/i],
  ["experience", /^(work |professional )?(experience|employment( history)?|work history)$/i],
  ["education", /^education( and training)?$/i],
  ["skills", /^(technical |key |core )?skills( and tools)?$|^technologies$|^tech stack$/i],
  ["projects", /^(selected |personal )?projects$/i],
  ["other", /^(certifications?|awards|publications|languages|interests|volunteering)$/i],
];

function splitSections(lines: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>([["_header", []]]);
  let current = "_header";
  for (const line of lines) {
    const clean = line.replace(/[:#*_]+/g, "").trim();
    const hit = HEADINGS.find(([, re]) => re.test(clean));
    if (hit) {
      current = hit[0];
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    out.get(current)!.push(line);
  }
  return out;
}

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE = `(?:${MONTH}\\s+)?(?:\\d{1,2}/)?\\d{4}`;
const RANGE = new RegExp(`(${DATE})\\s*(?:-|–|—|to)\\s*(${DATE}|present|current|now)`, "i");

function yearOf(s: string | undefined, now?: Date): number | undefined {
  if (!s) return undefined;
  if (/present|current|now/i.test(s)) return (now ?? new Date()).getFullYear();
  const m = /\d{4}/.exec(s);
  return m ? Number(m[0]) : undefined;
}

function parseExperience(lines: string[]): Profile["experience"] {
  const out: Profile["experience"] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const range = RANGE.exec(line);
    if (!range) {
      const last = out.at(-1);
      if (last && /^[-•*▪◦]/.test(line)) last.highlights.push(line.replace(/^[-•*▪◦]\s*/, ""));
      continue;
    }
    // "Senior Engineer, Acme Corp | Jan 2020 - Present" or the title on the line above the dates.
    let head = line.replace(range[0], "").replace(/[|·•,–—-]\s*$/, "").trim();
    if (!head && i > 0) head = lines[i - 1]!;
    const [title, company] = splitTitleCompany(head);
    out.push({ title, company, start: range[1], end: range[2], highlights: [] });
  }
  return out;
}

function splitTitleCompany(s: string): [string, string] {
  const parts = s
    .split(/\s+(?:at|@)\s+|\s*[|,–—]\s*|\s+-\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return [parts[0] ?? s, parts[1] ?? ""];
}

function parseEducation(lines: string[]): Profile["education"] {
  const degree =
    /\b(b\.?\s?tech|b\.?\s?e\.?|b\.?\s?sc?\.?|bachelor[a-z']*|m\.?\s?tech|m\.?\s?sc?\.?|master[a-z']*|mba|ph\.?\s?d|associate[a-z']*|diploma)(?![a-z])/i;
  const out: Profile["education"] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!degree.test(line)) continue;
    const years = line.match(/\d{4}/g) ?? [];
    const schoolLine = /university|college|institute|school/i.test(line) ? line : (lines[i + 1] ?? lines[i - 1] ?? "");
    out.push({
      school: schoolLine.replace(RANGE, "").replace(/\d{4}/g, "").replace(/[|,–—-]\s*$/, "").trim(),
      degree: degree.exec(line)?.[0],
      field: /\b(?:in|of)\s+([A-Z][A-Za-z &]+)/.exec(line)?.[1]?.trim(),
      end: years.at(-1),
    });
  }
  return out;
}

function parseSkills(lines: string[]): Profile["skills"] {
  const names = lines
    .flatMap((l) => l.replace(/^[^:]{1,30}:\s*/, "").split(/[,|•·;/]|\s{2,}/))
    .map((s) => s.replace(/^[-*▪◦]\s*/, "").trim())
    .filter((s) => s.length > 0 && s.length <= 40);
  return [...new Set(names.map((n) => n.toLowerCase()))].map((n) => ({
    name: names.find((x) => x.toLowerCase() === n)!.toLowerCase(),
  }));
}

function guessLocation(header: string[]): string {
  for (const line of header) {
    for (const part of line.split(/[|•·]/).map((p) => p.trim())) {
      if (/^[A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+$/.test(part) && !part.includes("@")) return part;
    }
  }
  return "";
}

/** Merge a profile from the agent over the rule-based one: the agent wins where it found something. */
export function mergeProfiles(base: Profile, better: Partial<Profile>): Profile {
  const pick = <T>(a: T, b: T | undefined) =>
    b === undefined || b === null || b === "" || (Array.isArray(b) && b.length === 0) ? a : b;
  return Profile.parse({
    ...base,
    name: pick(base.name, better.name),
    email: pick(base.email, better.email),
    phone: pick(base.phone, better.phone),
    location: pick(base.location, better.location),
    headline: pick(base.headline, better.headline),
    summary: pick(base.summary, better.summary),
    links: { ...base.links, ...Object.fromEntries(Object.entries(better.links ?? {}).filter(([, v]) => v)) },
    totalYears: pick(base.totalYears, better.totalYears),
    experience: pick(base.experience, better.experience),
    education: pick(base.education, better.education),
    skills: pick(base.skills, better.skills),
  });
}
