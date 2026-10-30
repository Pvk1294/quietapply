import { describe, expect, it } from "vitest";
import { addJob } from "../src/cli/add.js";
import { openMemoryDb } from "../src/core/db.js";
import { getApplication } from "../src/core/store.js";
import type { Fetcher } from "../src/sources/http.js";
import { companyFromToken } from "../src/sources/job.js";
import { fixtureFetcher } from "./helpers/fixtures.js";

const companies = [{ name: "Acme Rockets", ats: "greenhouse" as const, token: "acmerockets" }];

describe("quietapply add <url>", () => {
  it("takes the title, location and description from the Greenhouse API", async () => {
    const db = openMemoryDb();
    const r = await addJob(db, "https://job-boards.greenhouse.io/acmerockets/jobs/5000001", fixtureFetcher, {
      companies,
    });
    expect(r).toMatchObject({
      created: true,
      company: "Acme Rockets",
      title: "Software Engineer, Payments",
      location: "Remote - US",
    });
    expect(getApplication(db, r.id)).toMatchObject({ ats: "greenhouse", source: "manual" });
  });

  it("looks up Lever and Ashby jobs; the company comes from the board name when the API has none", async () => {
    const db = openMemoryDb();
    const lv = await addJob(
      db,
      "https://jobs.lever.co/globex/0a1b2c3d-0000-4000-8000-000000000101",
      fixtureFetcher,
    );
    expect(lv).toMatchObject({ company: "Globex", title: "Backend Developer", location: "Springfield" });
    expect(getApplication(db, lv.id)?.description).toContain("Node.js and PostgreSQL");

    const ab = await addJob(
      db,
      "https://jobs.ashbyhq.com/umbrella/7f3e0000-0000-4000-8000-000000000201",
      fixtureFetcher,
      {
        companies: [{ name: "Umbrella Labs", ats: "ashby", token: "umbrella" }],
      },
    );
    expect(ab).toMatchObject({ company: "Umbrella Labs", title: "Full-Stack Engineer" });
  });

  it("lets --company and --title win, and skips the lookup with --no-fetch", async () => {
    const db = openMemoryDb();
    let calls = 0;
    const counting: Fetcher = async (u) => {
      calls++;
      return fixtureFetcher(u);
    };
    const r = await addJob(
      db,
      "https://jobs.lever.co/globex/0a1b2c3d-0000-4000-8000-000000000101",
      counting,
      {
        company: "Globex Corporation",
      },
    );
    expect(r).toMatchObject({ company: "Globex Corporation", title: "Backend Developer" });
    const n = await addJob(db, "https://jobs.lever.co/globex/another", counting, { fetch: false });
    expect(calls).toBe(1);
    expect(n).toMatchObject({ company: "Globex", title: "Job" });
  });

  it("still queues the job when the lookup fails or the job is unlisted", async () => {
    const db = openMemoryDb();
    const down: Fetcher = async () => {
      throw new Error("503 Service Unavailable");
    };
    const r = await addJob(db, "https://job-boards.greenhouse.io/acme-rockets/jobs/42", down);
    expect(r).toMatchObject({ created: true, company: "Acme Rockets", title: "Job" });
    expect(r.lookupError).toContain("503");
    const gone = await addJob(db, "https://jobs.ashbyhq.com/umbrella/not-a-listed-job", fixtureFetcher);
    expect(gone.lookupError).toContain("not on the public board");
  });

  it("stores Greenhouse jobs from a company's own careers site under the embeddable form", async () => {
    const db = openMemoryDb();
    const api: Fetcher = async () =>
      JSON.stringify({
        id: 6176758,
        title: "Backend/API Engineer",
        company_name: "Initech",
        absolute_url: "https://initech.com/jobs/search?gh_jid=6176758",
        location: { name: "US" },
        content: "&lt;p&gt;Build APIs.&lt;/p&gt;",
      });
    const r = await addJob(db, "https://job-boards.greenhouse.io/initech/jobs/6176758", api);
    expect(r).toMatchObject({ company: "Initech", title: "Backend/API Engineer" });
    expect(getApplication(db, r.id)?.url).toBe(
      "https://job-boards.greenhouse.io/embed/job_app?for=initech&token=6176758",
    );
  });

  it("tidies board names into company names", () => {
    expect(companyFromToken("acme-rockets")).toBe("Acme Rockets");
    expect(companyFromToken("globex_corp")).toBe("Globex Corp");
  });
});
