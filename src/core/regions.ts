import { norm } from "./text.js";

/**
 * Countries and regions as job postings write them, so "remote" in your locations can tell
 * "Remote - Brazil" (not for you unless you live in Brazil) from "Remote" or "Remote, worldwide".
 * Keys are countries; each lists the words postings use for it. Not exhaustive: a country that is
 * not listed here is not recognised, and such a posting is treated like a plain "Remote".
 */
const COUNTRIES: Record<string, string[]> = {
  "united states": ["united states", "united states of america", "usa", "us", "u s", "u s a", "america"],
  canada: ["canada"],
  mexico: ["mexico"],
  brazil: ["brazil", "brasil"],
  argentina: ["argentina"],
  chile: ["chile"],
  colombia: ["colombia"],
  "united kingdom": [
    "united kingdom",
    "uk",
    "u k",
    "great britain",
    "britain",
    "england",
    "scotland",
    "wales",
  ],
  ireland: ["ireland"],
  germany: ["germany", "deutschland"],
  france: ["france"],
  spain: ["spain"],
  portugal: ["portugal"],
  italy: ["italy"],
  netherlands: ["netherlands", "the netherlands", "holland"],
  belgium: ["belgium"],
  switzerland: ["switzerland"],
  austria: ["austria"],
  sweden: ["sweden"],
  norway: ["norway"],
  denmark: ["denmark"],
  finland: ["finland"],
  poland: ["poland"],
  romania: ["romania"],
  ukraine: ["ukraine"],
  "czech republic": ["czech republic", "czechia"],
  greece: ["greece"],
  turkey: ["turkey", "turkiye"],
  israel: ["israel"],
  "united arab emirates": ["united arab emirates", "uae"],
  "saudi arabia": ["saudi arabia"],
  egypt: ["egypt"],
  nigeria: ["nigeria"],
  kenya: ["kenya"],
  "south africa": ["south africa"],
  india: ["india"],
  pakistan: ["pakistan"],
  bangladesh: ["bangladesh"],
  "sri lanka": ["sri lanka"],
  singapore: ["singapore"],
  malaysia: ["malaysia"],
  indonesia: ["indonesia"],
  philippines: ["philippines"],
  vietnam: ["vietnam"],
  thailand: ["thailand"],
  japan: ["japan"],
  "south korea": ["south korea", "korea"],
  china: ["china"],
  "hong kong": ["hong kong"],
  taiwan: ["taiwan"],
  australia: ["australia"],
  "new zealand": ["new zealand"],
};

/** US states, so "Springfield, Oregon" counts as living in the United States. */
const US_STATES =
  "alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada new_hampshire new_jersey new_mexico new_york north_carolina north_dakota ohio oklahoma oregon pennsylvania rhode_island south_carolina south_dakota tennessee texas utah vermont virginia washington west_virginia wisconsin wyoming"
    .split(" ")
    .map((s) => s.replace(/_/g, " "));

const EUROPE = [
  "united kingdom",
  "ireland",
  "germany",
  "france",
  "spain",
  "portugal",
  "italy",
  "netherlands",
  "belgium",
  "switzerland",
  "austria",
  "sweden",
  "norway",
  "denmark",
  "finland",
  "poland",
  "romania",
  "ukraine",
  "czech republic",
  "greece",
];
const MIDDLE_EAST_AFRICA = [
  "turkey",
  "israel",
  "united arab emirates",
  "saudi arabia",
  "egypt",
  "nigeria",
  "kenya",
  "south africa",
];
const ASIA_PACIFIC = [
  "india",
  "pakistan",
  "bangladesh",
  "sri lanka",
  "singapore",
  "malaysia",
  "indonesia",
  "philippines",
  "vietnam",
  "thailand",
  "japan",
  "south korea",
  "china",
  "hong kong",
  "taiwan",
  "australia",
  "new zealand",
];
const NORTH_AMERICA = ["united states", "canada", "mexico"];
const LATIN_AMERICA = ["mexico", "brazil", "argentina", "chile", "colombia"];

/** Regions postings use, and the countries in each. */
const REGIONS: { words: string[]; countries: string[] }[] = [
  { words: ["europe", "eu", "european union"], countries: EUROPE },
  { words: ["emea"], countries: [...EUROPE, ...MIDDLE_EAST_AFRICA] },
  { words: ["apac", "asia pacific", "asia"], countries: ASIA_PACIFIC },
  { words: ["north america"], countries: NORTH_AMERICA },
  { words: ["latam", "latin america", "south america"], countries: LATIN_AMERICA },
  { words: ["americas", "amer"], countries: [...NORTH_AMERICA, ...LATIN_AMERICA] },
];

const ANYWHERE = /\b(anywhere|worldwide|global|globally|international)\b/;

const has = (text: string, word: string) => ` ${text} `.includes(` ${word} `);

/** The country a piece of text names ("Springfield, Oregon", "United States", "Bengaluru, India"), if any. */
export function countryOf(text: string | undefined): string | undefined {
  const t = norm(text ?? "");
  if (!t) return undefined;
  // Longest names first, so "united states of america" wins over "america".
  const all = Object.entries(COUNTRIES).flatMap(([country, words]) => words.map((w) => ({ country, w })));
  all.sort((a, b) => b.w.length - a.w.length);
  const hit = all.find((x) => has(t, x.w));
  if (hit) return hit.country;
  if (US_STATES.some((s) => has(t, s))) return "united states";
  return undefined;
}

/** Every country a posting's location limits it to; empty when it names none. */
function placesIn(location: string): { countries: Set<string>; anywhere: boolean } {
  const t = norm(location);
  const countries = new Set<string>();
  for (const [country, words] of Object.entries(COUNTRIES))
    if (words.some((w) => has(t, w))) countries.add(country);
  for (const r of REGIONS) if (r.words.some((w) => has(t, w))) for (const c of r.countries) countries.add(c);
  if (US_STATES.some((s) => has(t, s))) countries.add("united states");
  return { countries, anywhere: ANYWHERE.test(t) };
}

export type RemoteMatch = { ok: true } | { ok: false; limitedTo: string };

/**
 * Whether a remote posting is open to someone living in `home`. A plain "Remote", or one that says
 * anywhere or worldwide, is open to everyone. One that names countries or regions ("Remote - US",
 * "Remote, EMEA") is open only to people in them. With no known home country such a posting is not
 * a match, so a role restricted to another country is never queued by accident.
 */
export function remoteOpenTo(location: string, home: string | undefined): RemoteMatch {
  const { countries, anywhere } = placesIn(location);
  if (anywhere || countries.size === 0) return { ok: true };
  if (home && countries.has(home)) return { ok: true };
  const named = location.replace(/\s+/g, " ").trim();
  return { ok: false, limitedTo: named };
}
