const STOP = new Set(
  "a an the and or of to in on for with at by from is are be you your do does did have has this that what which who how please if any as it its we our us will would can could".split(
    " ",
  ),
);

/** Lowercase, strip punctuation and collapse whitespace. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}

/** Meaningful words of a question, lightly stemmed so "relocating" and "relocate" match. */
export function tokens(s: string): string[] {
  return norm(s)
    .split(" ")
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

function stem(w: string): string {
  if (w.length <= 4) return w;
  return w.replace(/(ations?|ings?|ed|es|s|ly)$/, "").replace(/e$/, "");
}

/**
 * The same question, not merely a similar one: identical after normalising, or one fully contains the other
 * (a queued question often just adds context in brackets). Templated questions such as
 * "Did you apply to the Acme role?" / "...the Globex role?" stay different questions.
 */
export function sameQuestion(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 25 && long.includes(short);
}

/** Jaccard similarity of question tokens, 0..1. */
export function similarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}
