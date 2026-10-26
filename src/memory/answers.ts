import type { DB } from "../core/db.js";
import { now } from "../core/db.js";
import { norm, sameQuestion, similarity } from "../core/text.js";
import { countriesInText } from "./countries.js";
import { PROFILE_FIELDS, type Profile } from "./profile.js";
import { STANDARD_QUESTIONS, standardQuestion } from "./seed.js";

/**
 * Answer memory: one row per answer, with a canonical question, other wordings, and a scope.
 * The agent never sees the whole memory; it gets the entries that match the form in front of it,
 * and every answer it types must cite the id of the entry it came from.
 */
export type Scope = "global" | "company" | "ats";

export interface Answer {
  id: number;
  key: string | null;
  question: string;
  aliases: string[];
  answer: string;
  type: string;
  scope: Scope;
  scope_value: string | null;
  sensitive: boolean;
  source: string;
  created_at: string;
  updated_at: string;
  uses: number;
}

interface AnswerRow extends Omit<Answer, "aliases" | "sensitive"> {
  aliases: string;
  sensitive: number;
}

function fromRow(r: AnswerRow): Answer {
  return { ...r, aliases: JSON.parse(r.aliases), sensitive: !!r.sensitive };
}

export interface NewAnswer {
  key?: string | null;
  question: string;
  answer: string;
  aliases?: string[];
  type?: string;
  scope?: Scope;
  scopeValue?: string | null;
  sensitive?: boolean;
  source?: "resume" | "setup" | "you" | "default" | "demo";
}

/** Save an answer. An answer with the same key (or same question) and scope is updated instead of duplicated. */
export function saveAnswer(db: DB, a: NewAnswer): Answer {
  const scope = a.scope ?? "global";
  const scopeValue = scope === "global" ? null : (a.scopeValue ?? null);
  const key = a.key ?? null;
  const std = key ? standardQuestion(key) : undefined;
  const existing = listAnswers(db).find(
    (x) =>
      x.scope === scope &&
      (x.scope_value ?? "").toLowerCase() === (scopeValue ?? "").toLowerCase() &&
      // Two keyed answers are the same only when their keys are ("sponsorship" vs "sponsorship:in").
      (key && x.key ? x.key === key : sameQuestion(x.question, a.question)),
  );
  const t = now();
  if (existing) {
    const aliases = [...new Set([...existing.aliases, ...(a.aliases ?? [])])];
    if (!sameQuestion(existing.question, a.question) && !aliases.some((x) => sameQuestion(x, a.question)))
      aliases.push(a.question);
    db.prepare("UPDATE answers SET answer = ?, aliases = ?, source = ?, updated_at = ? WHERE id = ?").run(
      a.answer,
      JSON.stringify(aliases),
      a.source ?? existing.source,
      t,
      existing.id,
    );
    return getAnswer(db, existing.id)!;
  }
  const res = db
    .prepare(
      `INSERT INTO answers(key, question, aliases, answer, type, scope, scope_value, sensitive, source, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      key,
      a.question,
      JSON.stringify(a.aliases ?? []),
      a.answer,
      a.type ?? std?.type ?? "text",
      scope,
      scopeValue,
      (a.sensitive ?? std?.sensitive) ? 1 : 0,
      a.source ?? "you",
      t,
      t,
    );
  return getAnswer(db, Number(res.lastInsertRowid))!;
}

export function getAnswer(db: DB, id: number): Answer | undefined {
  const r = db.prepare("SELECT * FROM answers WHERE id = ?").get(id) as AnswerRow | undefined;
  return r ? fromRow(r) : undefined;
}

export function listAnswers(db: DB): Answer[] {
  return (db.prepare("SELECT * FROM answers ORDER BY id").all() as unknown as AnswerRow[]).map(fromRow);
}

export function updateAnswer(
  db: DB,
  id: number,
  patch: { answer?: string; question?: string },
): Answer | undefined {
  const cur = getAnswer(db, id);
  if (!cur) return undefined;
  db.prepare("UPDATE answers SET answer = ?, question = ?, updated_at = ? WHERE id = ?").run(
    patch.answer ?? cur.answer,
    patch.question ?? cur.question,
    now(),
    id,
  );
  return getAnswer(db, id);
}

export function deleteAnswer(db: DB, id: number): boolean {
  return db.prepare("DELETE FROM answers WHERE id = ?").run(id).changes > 0;
}

export function markUsed(db: DB, id: number): void {
  db.prepare("UPDATE answers SET uses = uses + 1 WHERE id = ?").run(id);
}

/** Which standard key, if any, a form question is asking about. */
export function keyForQuestion(question: string): string | undefined {
  const n = norm(question);
  return STANDARD_QUESTIONS.find((q) => q.patterns.some((p) => p.test(n)))?.key;
}

export interface LookupContext {
  company?: string;
  ats?: string;
}

export type LookupResult =
  | {
      status: "known";
      memoryId: string;
      answer: string;
      question: string;
      confidence: number;
      sensitive: boolean;
    }
  | {
      status: "maybe";
      candidates: { memoryId: string; question: string; answer: string; confidence: number }[];
    }
  | { status: "unknown" };

const KNOWN = 0.6;
const MAYBE = 0.3;

function inScope(a: Answer, ctx: LookupContext): boolean {
  if (a.scope === "global") return true;
  const want = a.scope === "company" ? ctx.company : ctx.ats;
  return !!want && want.toLowerCase() === (a.scope_value ?? "").toLowerCase();
}

/** Narrower scopes win ties: an answer saved "only for Acme" beats the global one when applying to Acme. */
const SCOPE_BONUS: Record<Scope, number> = { company: 0.02, ats: 0.01, global: 0 };

function score(a: Answer, question: string, key: string | undefined): number {
  if (key && a.key === key) return 1;
  const wordings = [a.question, ...a.aliases];
  if (wordings.some((w) => sameQuestion(w, question))) return 0.95;
  return Math.max(...wordings.map((w) => similarity(w, question)));
}

/**
 * Find the stored answer for a form question. Profile fields (name, email, links...) come first,
 * then the answer memory. Below the confidence threshold the result is "maybe" (the agent may use a
 * candidate only if it is clearly the same question) or "unknown" (the agent must ask the human).
 */
export function lookupAnswer(
  db: DB,
  profile: Profile,
  question: string,
  ctx: LookupContext = {},
): LookupResult {
  const n = norm(question);
  const key = keyForQuestion(question);
  if (!key) {
    for (const f of PROFILE_FIELDS) {
      const value = f.pattern.test(n) ? f.value(profile) : undefined;
      if (value)
        return {
          status: "known",
          memoryId: `profile:${f.field}`,
          answer: value,
          question,
          confidence: 1,
          sensitive: false,
        };
    }
  }
  const all = listAnswers(db).filter((a) => inScope(a, ctx));
  // "Are you authorized to work in the United States?" uses the answer saved for that country, if any.
  if (key && PER_COUNTRY_KEYS.includes(key)) {
    for (const cc of countriesInText(question)) {
      const hit = all.find((a) => a.key === `${key}:${cc}`);
      if (hit)
        return {
          status: "known",
          memoryId: `mem:${hit.id}`,
          answer: hit.answer,
          question: hit.question,
          confidence: 1,
          sensitive: hit.sensitive,
        };
    }
  }
  const scored = all
    .map((a) => ({ a, s: score(a, question, key) + SCOPE_BONUS[a.scope] }))
    .sort((x, y) => y.s - x.s);
  const best = scored[0];
  if (best && best.s >= KNOWN) {
    return {
      status: "known",
      memoryId: `mem:${best.a.id}`,
      answer: best.a.answer,
      question: best.a.question,
      confidence: Math.min(1, Number(best.s.toFixed(2))),
      sensitive: best.a.sensitive,
    };
  }
  const candidates = scored
    .filter((x) => x.s >= MAYBE)
    .slice(0, 3)
    .map((x) => ({
      memoryId: `mem:${x.a.id}`,
      question: x.a.question,
      answer: x.a.answer,
      confidence: Number(x.s.toFixed(2)),
    }));
  return candidates.length ? { status: "maybe", candidates } : { status: "unknown" };
}

/** Answers relevant to a set of form questions: used to build a small prompt instead of the whole memory. */
export function relevantAnswers(
  db: DB,
  profile: Profile,
  questions: string[],
  ctx: LookupContext = {},
): { question: string; memoryId: string; answer: string }[] {
  const out = new Map<string, { question: string; memoryId: string; answer: string }>();
  for (const q of questions) {
    const r = lookupAnswer(db, profile, q, ctx);
    if (r.status === "known")
      out.set(`${q}|${r.memoryId}`, { question: q, memoryId: r.memoryId, answer: r.answer });
  }
  return [...out.values()];
}

/** Standard questions that can have one answer per country, saved under keys like "sponsorship:us". */
export const PER_COUNTRY_KEYS = ["work_authorization", "sponsorship"];

/** Answers every form tends to need; sent even when the form's questions are not known in advance. */
export const CORE_KEYS = ["work_authorization", "sponsorship", "notice_period", "relocation", "work_mode"];

export function coreAnswers(
  db: DB,
  ctx: LookupContext = {},
): { question: string; memoryId: string; answer: string }[] {
  return listAnswers(db)
    .filter((a) => a.key && CORE_KEYS.includes(a.key.split(":")[0]!) && inScope(a, ctx))
    .map((a) => ({ question: a.question, memoryId: `mem:${a.id}`, answer: a.answer }));
}

/** Parse "mem:12" / "profile:email" ids the agent cites. */
export function parseMemoryId(
  id: string,
): { kind: "mem"; id: number } | { kind: "profile"; field: string } | null {
  const m = /^mem:(\d+)$/.exec(id);
  if (m) return { kind: "mem", id: Number(m[1]) };
  const p = /^profile:([a-z_]+)$/.exec(id);
  if (p) return { kind: "profile", field: p[1]! };
  return null;
}
