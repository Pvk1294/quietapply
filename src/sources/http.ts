import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Fetches text. file:// URLs read from disk, so fixture pages and tests never touch the network. */
export type Fetcher = (url: string) => Promise<string>;

export const defaultFetcher: Fetcher = async (url) => {
  if (url.startsWith("file://")) return readFile(fileURLToPath(url), "utf8");
  const res = await fetch(url, {
    headers: {
      "user-agent": "QuietApply/0.1 (+https://github.com/Pvk1294/quietapply)",
      accept: "application/json, text/html",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
};

export async function getJson<T>(fetcher: Fetcher, url: string): Promise<T> {
  return JSON.parse(await fetcher(url)) as T;
}

/** HTML to readable text (job descriptions), without pulling in a full HTML parser. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/li|\/h\d|\/div)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}
