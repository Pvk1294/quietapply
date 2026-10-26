import { norm } from "../core/text.js";

/** Countries people most often target, with the names forms use for them. `code` is ISO 3166-1 alpha-2. */
export const COUNTRIES: { code: string; name: string; aliases: string[] }[] = [
  { code: "in", name: "India", aliases: ["india", "bharat"] },
  {
    code: "us",
    name: "United States",
    aliases: ["united states", "united states of america", "usa", "u s", "us", "america"],
  },
  {
    code: "gb",
    name: "United Kingdom",
    aliases: ["united kingdom", "uk", "u k", "great britain", "britain", "england"],
  },
  { code: "ca", name: "Canada", aliases: ["canada"] },
  { code: "de", name: "Germany", aliases: ["germany", "deutschland"] },
  { code: "nl", name: "Netherlands", aliases: ["netherlands", "the netherlands", "holland"] },
  { code: "ie", name: "Ireland", aliases: ["ireland"] },
  { code: "fr", name: "France", aliases: ["france"] },
  { code: "es", name: "Spain", aliases: ["spain"] },
  { code: "pt", name: "Portugal", aliases: ["portugal"] },
  { code: "pl", name: "Poland", aliases: ["poland"] },
  { code: "se", name: "Sweden", aliases: ["sweden"] },
  { code: "ch", name: "Switzerland", aliases: ["switzerland"] },
  { code: "sg", name: "Singapore", aliases: ["singapore"] },
  { code: "ae", name: "United Arab Emirates", aliases: ["united arab emirates", "uae", "dubai"] },
  { code: "au", name: "Australia", aliases: ["australia"] },
  { code: "nz", name: "New Zealand", aliases: ["new zealand"] },
  { code: "jp", name: "Japan", aliases: ["japan"] },
  { code: "br", name: "Brazil", aliases: ["brazil", "brasil"] },
  { code: "mx", name: "Mexico", aliases: ["mexico"] },
  { code: "il", name: "Israel", aliases: ["israel"] },
];

/** The country a name refers to ("USA", "U.S.", "India"), if it is one we know. */
export function countryByName(name: string): { code: string; name: string } | undefined {
  const n = norm(name);
  const c = COUNTRIES.find((x) => x.code === n || x.aliases.includes(n) || norm(x.name) === n);
  return c ? { code: c.code, name: c.name } : undefined;
}

/** Countries a question mentions, e.g. "authorized to work in the United States?" → us. */
export function countriesInText(text: string): string[] {
  const n = ` ${norm(text)} `;
  const out: string[] = [];
  for (const c of COUNTRIES) {
    // Short aliases ("us", "uk") only count in their upper-case form in the original text, so the word
    // "us" in "tell us" is not read as the United States.
    const hit = c.aliases.some((a) =>
      a.length <= 3
        ? new RegExp(`\\b${a.toUpperCase().replace(/ /g, "\\.? ?")}\\b`).test(text)
        : n.includes(` ${a} `),
    );
    if (hit) out.push(c.code);
  }
  return out;
}
