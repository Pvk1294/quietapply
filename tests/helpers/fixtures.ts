import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Fetcher } from "../../src/sources/http.js";

export const FIXTURES = join(import.meta.dirname, "../../fixtures/ats");
export const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
export const fixtureUrl = (name: string) => pathToFileURL(join(FIXTURES, name)).toString();

/** Serves the public ATS API URLs from fixture files; anything else is an error (no network in tests). */
export const fixtureFetcher: Fetcher = async (url) => {
  const routes: [RegExp, string][] = [
    [/boards-api\.greenhouse\.io\/v1\/boards\/acmerockets\/jobs\?content=true$/, "greenhouse-acme-jobs.json"],
    [
      /boards-api\.greenhouse\.io\/v1\/boards\/acmerockets\/jobs\/5000001\?questions=true$/,
      "greenhouse-acme-job-questions.json",
    ],
    [
      /boards-api\.greenhouse\.io\/v1\/boards\/acmerockets\/jobs\/5000001$/,
      "greenhouse-acme-job-questions.json",
    ],
    [/api\.lever\.co\/v0\/postings\/globex\?mode=json$/, "lever-globex-postings.json"],
    [
      /api\.lever\.co\/v0\/postings\/globex\/0a1b2c3d-0000-4000-8000-000000000101$/,
      "lever-globex-posting.json",
    ],
    [/api\.ashbyhq\.com\/posting-api\/job-board\/umbrella$/, "ashby-umbrella-jobs.json"],
    [/jobs\.lever\.co\/globex\/.+\/apply$/, "lever-globex-apply.html"],
    [/jobs\.ashbyhq\.com\/umbrella\/.+\/application$/, "ashby-umbrella-application.html"],
    [/job-boards\.greenhouse\.io\/acmerockets\/jobs\/5000001$/, "greenhouse-acme-job.html"],
  ];
  if (url.startsWith("file://")) return readFileSync(new URL(url), "utf8");
  const hit = routes.find(([re]) => re.test(url));
  if (!hit) throw new Error(`no fixture for ${url}`);
  return fixture(hit[1]);
};
