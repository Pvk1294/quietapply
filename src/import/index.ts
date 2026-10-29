import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { type Company, type Config, loadConfig, saveConfig } from "../core/config.js";
import { type DB, now } from "../core/db.js";
import type { Paths } from "../core/paths.js";
import { saveAnswer } from "../memory/answers.js";
import { loadProfile, type Profile, saveProfile } from "../memory/profile.js";
import { detectAts } from "../sources/detect.js";
import { parseCsv } from "./csv.js";

/**
 * `quietapply import <folder>`: bring in what another tracker already knows (a profile, answers you gave,
 * jobs you applied to, what you look for). The folder holds JSON, YAML or CSV files and an optional
 * mapping, `quietapply-import.yaml`, that says which file is which and how its fields are named.
 * Without a mapping, files named profile / answers / applications / targets are read, with common field
 * names recognised (see FIELD_ALIASES). Format reference: docs/import.md.
 */
export const MAPPING_FILES = ["quietapply-import.yaml", "quietapply-import.yml", "quietapply-import.json"];

const Kind = z.enum(["profile", "answers", "applications", "targets"]);
type Kind = z.infer<typeof Kind>;

export const ImportMapping = z.object({
  /** Shown as the source of every imported row, e.g. "my old runner". Default: the folder name. */
  label: z.string().optional(),
  /** File per kind, relative to the folder or absolute. "file.json#items" reads the array at `items`. */
  files: z.partialRecord(Kind, z.string()).default({}),
  /** QuietApply field ← field in your file (dots for nested fields), per kind. Unmapped fields use the aliases. */
  fields: z.partialRecord(Kind, z.record(z.string(), z.string())).default({}),
  /** Application statuses that are not applications yet (drafts, saved jobs). Matched case-insensitively. */
  skipStatuses: z
    .array(z.string())
    .default(["prepared", "draft", "saved", "shortlisted", "blocked", "not applied", "skipped"]),
});
export type ImportMapping = z.infer<typeof ImportMapping>;

/** Field names other trackers commonly use, tried in order when the mapping does not name one. */
export const FIELD_ALIASES: Record<Exclude<Kind, "targets">, Record<string, string[]>> = {
  applications: {
    company: ["company", "company_name", "employer", "organization"],
    title: ["title", "role", "job_title", "position"],
    url: ["url", "job_url", "application_url", "link", "job_link"],
    location: ["location", "city"],
    appliedAt: ["appliedAt", "applied_at", "applied", "date", "applied_date", "date_applied"],
    status: ["status", "state"],
  },
  answers: {
    question: ["question", "q", "prompt"],
    answer: ["answer", "a", "value", "response"],
    key: ["key"],
    scope: ["scope"],
    company: ["company", "scope_value"],
    aliases: ["aliases", "other_wordings"],
    source: ["source", "from", "answered"],
    sensitive: ["sensitive"],
  },
  profile: {
    name: ["name", "full_name", "fullName"],
    firstName: ["firstName", "first_name"],
    lastName: ["lastName", "last_name"],
    email: ["email"],
    phone: ["phone", "mobile", "phone_number"],
    city: ["city"],
    state: ["state", "region"],
    country: ["country"],
    location: ["location"],
    headline: ["headline", "title"],
    summary: ["summary", "about"],
    linkedin: ["linkedin", "links.linkedin"],
    github: ["github", "links.github"],
    portfolio: ["portfolio", "website", "links.portfolio"],
    totalYears: ["totalYears", "total_years", "years_of_experience"],
    resumeFile: ["resumeFile", "resume", "resume_file"],
  },
};

const Targets = z.object({
  roles: z.array(z.string()).optional(),
  excludeTitles: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional(),
  neverApply: z.array(z.string()).optional(),
  /** Careers-page URLs (Greenhouse, Lever, Ashby) or { name, url } / { name, ats, token }. */
  companies: z
    .array(
      z.union([
        z.string(),
        z.object({
          name: z.string().optional(),
          url: z.string().optional(),
          ats: z.string().optional(),
          token: z.string().optional(),
        }),
      ]),
    )
    .optional(),
  experienceYears: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
});

export interface ImportSummary {
  label: string;
  dryRun: boolean;
  files: Partial<Record<Kind, string>>;
  profile: { updated: string[] };
  answers: { added: number; updated: number; skipped: number };
  applications: { imported: number; duplicates: number; notApplied: number; invalid: number };
  targets: { roles: number; excludeTitles: number; locations: number; neverApply: number; companies: number };
  warnings: string[];
}

type Row = Record<string, unknown>;

/** Read the folder, write what it holds into the data folder. With `dryRun` nothing is written. */
export function importFolder(
  db: DB,
  p: Paths,
  folder: string,
  opts: { dryRun?: boolean; config?: Config } = {},
): ImportSummary {
  const dir = resolve(folder);
  if (!existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
  const mapping = readMapping(dir);
  const label = mapping.label ?? basename(dir);
  const sum: ImportSummary = {
    label,
    dryRun: !!opts.dryRun,
    files: {},
    profile: { updated: [] },
    answers: { added: 0, updated: 0, skipped: 0 },
    applications: { imported: 0, duplicates: 0, notApplied: 0, invalid: 0 },
    targets: { roles: 0, excludeTitles: 0, locations: 0, neverApply: 0, companies: 0 },
    warnings: [],
  };
  const file = (kind: Kind) => {
    const f = locate(dir, kind, mapping);
    if (f) sum.files[kind] = f.path;
    return f;
  };
  const config = opts.config ?? loadConfig(p);
  const profile = loadProfile(p);

  // Everything in the database happens in one transaction, rolled back for a dry run.
  db.exec("BEGIN");
  try {
    const pf = file("profile");
    if (pf) importProfile(readOne(pf), mapping, profile, p, dir, sum, db);
    const af = file("answers");
    if (af) importAnswers(db, readRows(af), mapping, label, sum);
    const apf = file("applications");
    if (apf) importApplications(db, readRows(apf), mapping, label, sum);
    const tf = file("targets");
    if (tf) importTargets(Targets.parse(readOne(tf)), config, sum);
    db.exec(opts.dryRun ? "ROLLBACK" : "COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  if (!Object.keys(sum.files).length)
    throw new Error(
      `Nothing to import in ${dir}: expected profile, answers, applications or targets files (JSON, YAML or CSV), or a ${MAPPING_FILES[0]} that names them.`,
    );
  if (!opts.dryRun) {
    if (sum.profile.updated.length) saveProfile(profile, p);
    if (Object.values(sum.targets).some(Boolean)) saveConfig(config, p);
  }
  return sum;
}

function readMapping(dir: string): ImportMapping {
  const f = MAPPING_FILES.map((n) => join(dir, n)).find((x) => existsSync(x));
  if (!f) return ImportMapping.parse({});
  const raw = f.endsWith(".json") ? JSON.parse(readFileSync(f, "utf8")) : YAML.parse(readFileSync(f, "utf8"));
  return ImportMapping.parse(raw ?? {});
}

interface Located {
  path: string;
  /** Dotted path to the array inside the file ("#items"). */
  inner?: string;
}

function locate(dir: string, kind: Kind, mapping: ImportMapping): Located | undefined {
  const named = mapping.files[kind];
  if (named) {
    const [f, inner] = named.split("#");
    const path = isAbsolute(f!) ? f! : join(dir, f!);
    if (!existsSync(path)) throw new Error(`${kind}: file not found: ${path}`);
    return { path, inner };
  }
  for (const ext of [".json", ".yaml", ".yml", ".csv"]) {
    const path = join(dir, `${kind}${ext}`);
    if (existsSync(path)) return { path };
  }
  return undefined;
}

function parseFile(f: Located): unknown {
  const text = readFileSync(f.path, "utf8").replace(/^﻿/, "");
  const ext = extname(f.path).toLowerCase();
  const data =
    ext === ".csv" ? parseCsv(text) : ext === ".json" ? JSON.parse(text) : (YAML.parse(text) ?? {});
  return f.inner ? get(data, f.inner) : data;
}

/** A list of rows: a JSON/YAML array, an object holding exactly one array, or CSV rows. */
function readRows(f: Located): Row[] {
  const data = parseFile(f);
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object") {
    const arrays = Object.values(data).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as Row[];
  }
  throw new Error(`${f.path}: expected a list of rows (or name it with "#path" in the mapping)`);
}

function readOne(f: Located): Row {
  const data = parseFile(f);
  const one = Array.isArray(data) ? data[0] : data;
  if (!one || typeof one !== "object") throw new Error(`${f.path}: expected one object`);
  return one as Row;
}

function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Row)[part];
  }
  return cur;
}

/** The value for a QuietApply field: the mapped source field, else the first alias present. */
function field(row: Row, kind: Exclude<Kind, "targets">, name: string, mapping: ImportMapping): unknown {
  const mapped = mapping.fields[kind]?.[name];
  if (mapped) return get(row, mapped);
  for (const alias of FIELD_ALIASES[kind][name] ?? []) {
    const v = get(row, alias);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

const str = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "string" ? v.trim() : String(v).trim();

function importProfile(
  row: Row,
  mapping: ImportMapping,
  profile: Profile,
  p: Paths,
  dir: string,
  sum: ImportSummary,
  db: DB,
): void {
  const v = (name: string) => str(field(row, "profile", name, mapping));
  const set = (key: string, value: string | number | undefined, apply: () => void) => {
    if (value === undefined || value === "") return;
    apply();
    sum.profile.updated.push(key);
  };
  const full = v("name") || [v("firstName"), v("lastName")].filter(Boolean).join(" ");
  set("name", full, () => {
    profile.name = full;
  });
  set("email", v("email"), () => {
    profile.email = v("email");
  });
  set("phone", v("phone"), () => {
    profile.phone = v("phone");
  });
  // Forms ask for "City" and "Country" both, so the location keeps all three parts.
  const location = v("location") || [v("city"), v("state"), v("country")].filter(Boolean).join(", ");
  set("location", location, () => {
    profile.location = location;
  });
  set("headline", v("headline"), () => {
    profile.headline = v("headline");
  });
  set("summary", v("summary"), () => {
    profile.summary = v("summary");
  });
  for (const k of ["linkedin", "github", "portfolio"] as const)
    set(k, v(k), () => {
      profile.links[k] = v(k);
    });
  const years = Number(v("totalYears"));
  if (v("totalYears") && Number.isFinite(years))
    set("totalYears", years, () => {
      profile.totalYears = years;
    });
  // Lists already in QuietApply's own shape are taken as they are.
  for (const k of ["experience", "education", "skills"] as const) {
    const list = row[k];
    if (Array.isArray(list) && list.length)
      set(k, list.length, () => {
        (profile as Record<string, unknown>)[k] = list;
      });
  }
  const resume = v("resumeFile");
  if (resume) {
    const src = isAbsolute(resume) ? resume : join(dir, resume);
    if (!existsSync(src)) sum.warnings.push(`Resume not found: ${src}`);
    else
      set("resumeFile", basename(src), () => {
        if (!sum.dryRun) copyFileSync(src, join(p.resumeDir, basename(src)));
        profile.resumeFile = basename(src);
      });
  }
  // The country is also the answer to "Which country do you live in?" (and the fit gate's "remote").
  if (v("country"))
    saveAnswer(db, {
      key: "country",
      question: "Which country do you live in?",
      answer: v("country"),
      source: "import",
    });
}

function importAnswers(db: DB, rows: Row[], mapping: ImportMapping, label: string, sum: ImportSummary): void {
  const before = new Set((db.prepare("SELECT id FROM answers").all() as { id: number }[]).map((r) => r.id));
  for (const row of rows) {
    const question = str(field(row, "answers", "question", mapping));
    const answer = str(field(row, "answers", "answer", mapping));
    if (!question || !answer) {
      sum.answers.skipped++;
      continue;
    }
    const company = str(field(row, "answers", "company", mapping));
    const scope = str(field(row, "answers", "scope", mapping)).toLowerCase();
    const aliasesRaw = field(row, "answers", "aliases", mapping);
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw.map(str).filter(Boolean)
      : str(aliasesRaw)
          .split("|")
          .map((x) => x.trim())
          .filter(Boolean);
    const detail = str(field(row, "answers", "source", mapping));
    const sensitive = str(field(row, "answers", "sensitive", mapping)).toLowerCase();
    const saved = saveAnswer(db, {
      key: str(field(row, "answers", "key", mapping)) || null,
      question,
      answer,
      aliases,
      scope: company && scope !== "global" ? "company" : "global",
      scopeValue: company || null,
      sensitive: sensitive ? ["true", "yes", "1"].includes(sensitive) : undefined,
      // Where the answer came from, shown next to it in Memory: "import: my runner (asked 2026-09-28)".
      source: `import: ${label}${detail ? ` (${detail})` : ""}`,
    });
    if (before.has(saved.id)) sum.answers.updated++;
    else {
      sum.answers.added++;
      before.add(saved.id);
    }
  }
}

function importApplications(
  db: DB,
  rows: Row[],
  mapping: ImportMapping,
  label: string,
  sum: ImportSummary,
): void {
  const skip = new Set(mapping.skipStatuses.map((s) => s.toLowerCase()));
  const exists = db.prepare("SELECT id FROM applications WHERE url = ?");
  const insert = db.prepare(
    `INSERT INTO applications(company, title, url, ats, location, source, status, reason, created_at, updated_at, submitted_at)
     VALUES(?, ?, ?, ?, ?, 'import', 'submitted', ?, ?, ?, ?)`,
  );
  const event = db.prepare(
    "INSERT INTO application_events(application_id, status, note, at) VALUES(?, 'submitted', ?, ?)",
  );
  const seen = new Set<string>();
  let undated = 0;
  for (const row of rows) {
    const company = str(field(row, "applications", "company", mapping));
    const title = str(field(row, "applications", "title", mapping));
    if (!company || !title) {
      sum.applications.invalid++;
      continue;
    }
    const status = str(field(row, "applications", "status", mapping));
    if (status && skip.has(status.toLowerCase())) {
      sum.applications.notApplied++;
      continue;
    }
    const date = str(field(row, "applications", "appliedAt", mapping));
    const at = isoOrNow(date);
    if (!validDate(date)) undated++;
    // Rows without a link get a stable made-up one, so importing the same file again adds nothing.
    const url =
      str(field(row, "applications", "url", mapping)) ||
      `import:${slug(label)}/${slug(company)}/${slug(title)}/${at.slice(0, 10)}`;
    if (seen.has(url) || exists.get(url)) {
      sum.applications.duplicates++;
      continue;
    }
    seen.add(url);
    const note = `imported from ${label}${status ? `: ${status}` : ""}`;
    const r = insert.run(
      company,
      title,
      url,
      detectAts(url)?.ats ?? "unknown",
      str(field(row, "applications", "location", mapping)) || null,
      note,
      at,
      at,
      at,
    );
    event.run(Number(r.lastInsertRowid), note, now());
    sum.applications.imported++;
  }
  if (undated)
    sum.warnings.push(
      `${undated} application(s) had no date and count as sent today (for the daily and per-company limits).`,
    );
}

function importTargets(t: z.infer<typeof Targets>, config: Config, sum: ImportSummary): void {
  const merge = (cur: string[], add: string[] | undefined) => {
    const out = [...cur];
    for (const x of add ?? [])
      if (x.trim() && !out.some((y) => y.toLowerCase() === x.trim().toLowerCase())) out.push(x.trim());
    return { list: out, added: out.length - cur.length };
  };
  for (const k of ["roles", "excludeTitles", "locations", "neverApply"] as const) {
    const m = merge(config.rules[k], t[k]);
    config.rules[k] = m.list;
    sum.targets[k] = m.added;
  }
  if (t.experienceYears) {
    config.rules.experienceYears = {
      min: t.experienceYears.min ?? config.rules.experienceYears.min,
      max: t.experienceYears.max ?? config.rules.experienceYears.max,
    };
  }
  for (const c of t.companies ?? []) {
    const company = toCompany(c);
    if (!company) {
      sum.warnings.push(
        `Not a Greenhouse, Lever or Ashby board: ${typeof c === "string" ? c : JSON.stringify(c)}`,
      );
      continue;
    }
    if (config.companies.some((x) => x.ats === company.ats && x.token === company.token)) continue;
    config.companies.push(company);
    sum.targets.companies++;
  }
}

function toCompany(
  c: string | { name?: string; url?: string; ats?: string; token?: string },
): Company | undefined {
  if (typeof c !== "string" && c.ats && c.token && ["greenhouse", "lever", "ashby"].includes(c.ats))
    return { name: c.name ?? c.token, ats: c.ats as Company["ats"], token: c.token };
  const url = typeof c === "string" ? c : c.url;
  const ref = url ? detectAts(url) : undefined;
  if (!ref) return undefined;
  const name = typeof c === "string" ? undefined : c.name;
  return { name: name ?? ref.token.replace(/[-_]/g, " "), ats: ref.ats, token: ref.token };
}

const validDate = (s: string) => !!s && !Number.isNaN(new Date(s).getTime());

function isoOrNow(s: string): string {
  return validDate(s) ? new Date(s).toISOString() : now();
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
