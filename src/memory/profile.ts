import { existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { type Paths, paths } from "../core/paths.js";

export const Experience = z.object({
  company: z.string(),
  title: z.string(),
  start: z.string().optional(),
  end: z.string().optional(),
  location: z.string().optional(),
  highlights: z.array(z.string()).default([]),
});

export const Education = z.object({
  school: z.string(),
  degree: z.string().optional(),
  field: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  grade: z.string().optional(),
});

export const Skill = z.object({ name: z.string(), years: z.number().optional() });

export const Profile = z.object({
  name: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  location: z.string().default(""),
  headline: z.string().default(""),
  summary: z.string().default(""),
  links: z
    .object({
      linkedin: z.string().optional(),
      github: z.string().optional(),
      portfolio: z.string().optional(),
      other: z.array(z.string()).default([]),
    })
    .default({ other: [] }),
  totalYears: z.number().optional(),
  experience: z.array(Experience).default([]),
  education: z.array(Education).default([]),
  skills: z.array(Skill).default([]),
  /** File name inside ~/.quietapply/resume/ that gets uploaded to forms. */
  resumeFile: z.string().optional(),
});
export type Profile = z.infer<typeof Profile>;

export function emptyProfile(): Profile {
  return Profile.parse({});
}

export function loadProfile(p: Paths = paths()): Profile {
  if (!existsSync(p.profile)) return emptyProfile();
  return Profile.parse(YAML.parse(readFileSync(p.profile, "utf8")) ?? {});
}

export function saveProfile(profile: Profile, p: Paths = paths()): void {
  const header =
    "# Your profile, built from your resume. Check it: the agent fills forms from these values.\n";
  writeFileSync(p.profile, header + YAML.stringify(Profile.parse(profile)), { mode: 0o600 });
}

export function firstName(profile: Profile): string {
  return profile.name.trim().split(/\s+/)[0] ?? "";
}

export function lastName(profile: Profile): string {
  const parts = profile.name.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : "";
}

/** Profile values a form can ask for directly, with the phrasings that identify them. */
export const PROFILE_FIELDS: { field: string; pattern: RegExp; value: (p: Profile) => string | undefined }[] =
  [
    {
      field: "first_name",
      pattern: /^(legal )?first name|^given name|^preferred first name/,
      value: firstName,
    },
    { field: "last_name", pattern: /^(legal )?last name|^surname|^family name/, value: lastName },
    {
      field: "full_name",
      pattern: /^(full |legal )?name$|^your name$|^full legal name/,
      value: (p) => p.name,
    },
    { field: "email", pattern: /e ?mail/, value: (p) => p.email },
    { field: "phone", pattern: /phone|mobile|contact number/, value: (p) => p.phone },
    {
      field: "location",
      pattern: /^(current )?(location|city)|where are you (currently )?(located|based)/,
      value: (p) => p.location,
    },
    { field: "linkedin", pattern: /linkedin/, value: (p) => p.links.linkedin },
    { field: "github", pattern: /github/, value: (p) => p.links.github },
    {
      field: "portfolio",
      pattern: /portfolio|personal (web)?site|^website/,
      value: (p) => p.links.portfolio,
    },
    {
      field: "current_company",
      pattern: /current (company|employer)|^company$/,
      value: (p) => p.experience[0]?.company,
    },
    {
      field: "current_title",
      pattern: /current (job )?title|current role/,
      value: (p) => p.experience[0]?.title,
    },
    {
      field: "total_years",
      pattern: /total (years of )?experience|years of (professional |relevant )?experience$/,
      value: (p) => (p.totalYears === undefined ? undefined : String(p.totalYears)),
    },
  ];

/** A compact profile for the agent prompt: contact, recent roles and skills, without the long highlights. */
export function profileForPrompt(profile: Profile): Record<string, unknown> {
  return {
    name: profile.name,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    headline: profile.headline,
    links: profile.links,
    totalYears: profile.totalYears,
    experience: profile.experience.slice(0, 4).map((e) => ({
      company: e.company,
      title: e.title,
      start: e.start,
      end: e.end,
    })),
    education: profile.education.map((e) => ({
      school: e.school,
      degree: e.degree,
      field: e.field,
      end: e.end,
    })),
    skills: profile.skills.map((s) => (s.years ? `${s.name} (${s.years}y)` : s.name)),
    resumeFile: profile.resumeFile,
  };
}
