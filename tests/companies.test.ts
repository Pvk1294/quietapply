import { describe, expect, it } from "vitest";
import { functionOf, probeBoard } from "../src/companies/probe.js";
import { REGIONS, regionsForPlaces, regionsOf } from "../src/companies/regions.js";
import { atsInHtml, resolveCareersUrl } from "../src/companies/resolve.js";
import { INDUSTRIES, starterList, suggestCompanies } from "../src/companies/starter.js";
import { defaultConfig } from "../src/core/config.js";
import { openDb } from "../src/core/db.js";
import { checkFit, parseSalary, seniorityOf } from "../src/core/rules.js";
import { companiesToScan, discover, STARTER_SCAN } from "../src/runner/discover.js";
import { detectAts } from "../src/sources/detect.js";
import { JANE, makeHome } from "./helpers/home.js";
import { boardFetcher } from "./helpers/wizard.js";

describe("careers URL → ATS and board token", () => {
  it.each([
    [
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs/42",
      { ats: "greenhouse", token: "acme", jobId: "42" },
    ],
    ["https://job-boards.eu.greenhouse.io/acme", { ats: "greenhouse", token: "acme", region: "eu" }],
    ["https://boards.greenhouse.io/embed/job_board?for=acme", { ats: "greenhouse", token: "acme" }],
    ["https://api.lever.co/v0/postings/globex?mode=json", { ats: "lever", token: "globex" }],
    ["https://api.eu.lever.co/v0/postings/globex", { ats: "lever", token: "globex", region: "eu" }],
    ["https://jobs.lever.co/globex/apply", { ats: "lever", token: "globex" }],
    ["https://api.ashbyhq.com/posting-api/job-board/umbrella", { ats: "ashby", token: "umbrella" }],
    [
      "https://jobs.ashbyhq.com/Umbrella%20Corp/embed",
      { ats: "ashby", token: "Umbrella Corp", jobId: undefined },
    ],
  ])("%s", (url, want) => {
    expect(detectAts(url)).toMatchObject(want);
  });

  it("does not mistake Greenhouse's own website or other pages for a job board", () => {
    expect(detectAts("https://www.greenhouse.io/careers")).toBeUndefined();
    expect(detectAts("https://lever.co/about")).toBeUndefined();
    expect(detectAts("https://acme.example/careers?gh_jid=123")).toBeUndefined();
  });

  it("finds a board embedded in a company's own careers page", () => {
    expect(
      atsInHtml('<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>'),
    ).toMatchObject({
      ats: "greenhouse",
      token: "acme",
    });
    expect(atsInHtml('<a href="https://jobs.ashbyhq.com/umbrella">Open roles</a>')).toMatchObject({
      ats: "ashby",
      token: "umbrella",
    });
    expect(atsInHtml('fetch("https://api.lever.co/v0/postings/globex?mode=json")')).toMatchObject({
      ats: "lever",
      token: "globex",
    });
    expect(atsInHtml("<p>Email jobs@acme.example</p>")).toBeUndefined();
  });

  it("checks the board through its public API before adding it", async () => {
    expect(await resolveCareersUrl("boards.greenhouse.io/acmerockets/jobs/1", boardFetcher)).toMatchObject({
      ok: true,
      via: "url",
      jobs: 2,
      company: { name: "Acme Rockets", ats: "greenhouse", token: "acmerockets" },
    });
    expect(await resolveCareersUrl("https://globex.example/careers", boardFetcher)).toMatchObject({
      ok: true,
      via: "page",
      company: { name: "Globex", ats: "lever", token: "globex" },
    });
    expect(await resolveCareersUrl("https://boards.greenhouse.io/no-such-board", boardFetcher)).toMatchObject(
      {
        ok: false,
        reason: 'no greenhouse job board called "no-such-board"',
      },
    );
    expect(await resolveCareersUrl("https://nothing.example/careers", boardFetcher)).toMatchObject({
      ok: false,
    });
    expect(await resolveCareersUrl("https://down.example/careers", boardFetcher)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("could not open the page"),
    });
  });
});

describe("regions and job families", () => {
  it.each([
    ["Bengaluru, Karnataka, India", ["in"]],
    ["Gurugram", ["in"]],
    ["Remote - US", ["remote", "us"]],
    ["Austin, TX", ["us"]],
    ["London, UK", ["uk"]],
    ["Toronto, Canada", ["ca"]],
    ["Berlin, Germany", ["eu"]],
    ["San José, Costa Rica", ["latam"]],
    ["Singapore", ["apac"]],
    ["Anywhere", ["remote"]],
  ])("%s", (loc, want) => {
    expect(regionsOf(loc).sort()).toEqual([...want].sort());
  });

  it("reads people's places too", () => {
    expect(regionsForPlaces(["India", "remote"]).sort()).toEqual(["in", "remote"]);
    expect(regionsForPlaces(["Pune", "Berlin"]).sort()).toEqual(["eu", "in"]);
  });

  it("sorts job titles into families", () => {
    expect(functionOf("Senior Data Engineer")).toBe("data");
    expect(functionOf("Staff Software Engineer, Payments")).toBe("engineering");
    expect(functionOf("Product Designer")).toBe("design");
    expect(functionOf("Enterprise Account Executive")).toBe("sales");
    expect(functionOf("Senior Product Manager")).toBe("product");
    expect(functionOf("Chef")).toBeUndefined();
  });

  it("probes a board: job count, regions and families", async () => {
    expect(await probeBoard(boardFetcher, "greenhouse", "acmerockets")).toMatchObject({
      name: "Acme Rockets",
      jobs: 2,
      regions: expect.arrayContaining(["in", "us", "remote"]),
      functions: expect.arrayContaining(["engineering", "design"]),
    });
    await expect(probeBoard(boardFetcher, "ashby", "missing")).rejects.toThrow(/404/);
  });
});

describe("starter company list", () => {
  const { companies, checkedAt } = starterList();

  it("has 150+ checked companies with valid tags", () => {
    expect(companies.length).toBeGreaterThanOrEqual(150);
    expect(checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const industries = new Set(INDUSTRIES.map((i) => i.id));
    for (const c of companies) {
      expect(["greenhouse", "lever", "ashby"]).toContain(c.ats);
      expect(c.token).toMatch(/^[\w.%-]+$/);
      expect(c.jobs).toBeGreaterThan(0);
      expect(["startup", "scaleup", "large"]).toContain(c.size);
      expect(industries.has(c.industry), `${c.name}: ${c.industry}`).toBe(true);
      for (const r of c.regions) expect(REGIONS).toContain(r);
    }
  });

  it("has no duplicates", () => {
    const boards = companies.map((c) => `${c.ats}:${c.token.toLowerCase()}`);
    expect(new Set(boards).size).toBe(boards.length);
    expect(new Set(companies.map((c) => c.name)).size).toBe(companies.length);
  });

  it("covers India, remote, the US and Europe", () => {
    const n = (r: string) => companies.filter((c) => c.regions.includes(r as never)).length;
    expect(n("in")).toBeGreaterThanOrEqual(50);
    expect(n("remote")).toBeGreaterThanOrEqual(50);
    expect(n("us")).toBeGreaterThanOrEqual(50);
    expect(n("eu") + n("uk")).toBeGreaterThanOrEqual(50);
  });

  it("suggests companies that hire where the person wants to work, for their kind of role", () => {
    const config = defaultConfig();
    config.rules.roles = ["software engineer"];
    config.rules.countries = ["India"];
    const s = suggestCompanies(config);
    expect(s.length).toBeGreaterThan(20);
    for (const c of s) {
      expect(c.regions).toContain("in");
      expect(c.functions).toContain("engineering");
    }
    // With remote work fine, remote-only hirers join, below the local ones.
    config.rules.locations = ["remote"];
    const withRemote = suggestCompanies(config);
    expect(withRemote.length).toBeGreaterThan(s.length);
    expect(withRemote[0]!.regions).toContain("in");
  });

  it("respects job sites, the never-apply list, the watch list and industry taste", () => {
    const config = defaultConfig();
    config.rules.countries = ["United States"];
    const all = suggestCompanies(config);
    const first = all[0]!;
    config.sources.lever = false;
    config.rules.neverApply = [first.name];
    config.companies = [{ name: all[1]!.name, ats: all[1]!.ats, token: all[1]!.token }];
    const s = suggestCompanies(config);
    expect(s.some((c) => c.ats === "lever")).toBe(false);
    expect(s.some((c) => c.name === first.name || c.name === all[1]!.name)).toBe(false);
    config.preferences.industries = ["crypto"];
    expect(suggestCompanies(config)[0]!.industry).toBe("crypto");
  });

  it("is used by discover when the watch list is empty", async () => {
    const p = makeHome({ companies: [] });
    const config = { ...defaultConfig(), rules: { ...defaultConfig().rules, countries: ["India"] } };
    expect(companiesToScan(config)).toMatchObject({ fromStarterList: true });
    expect(companiesToScan(config).companies).toHaveLength(STARTER_SCAN);
    const seen: string[] = [];
    const s = await discover(openDb(p), config, JANE, async (url) => {
      seen.push(url);
      return url.includes("greenhouse") ? '{"jobs":[]}' : url.includes("ashby") ? '{"jobs":[]}' : "[]";
    });
    expect(s).toMatchObject({ fromStarterList: true, companies: STARTER_SCAN, found: 0, errors: [] });
    expect(seen).toHaveLength(STARTER_SCAN);
  });
});

describe("fit gate: countries, seniority, salary", () => {
  const rules = (over: Partial<ReturnType<typeof defaultConfig>["rules"]>) => ({
    ...defaultConfig().rules,
    ...over,
  });
  const job = (title: string, location: string, description = "") => ({
    company: "Acme",
    title,
    location,
    description,
  });

  it("treats Indian cities as India and checks where remote roles may be done from", () => {
    const r = rules({ countries: ["India"], locations: ["remote"] });
    expect(checkFit(job("Engineer", "Bengaluru, Karnataka"), r).fit).toBe(true);
    expect(checkFit(job("Engineer", "Remote"), r).fit).toBe(true);
    expect(checkFit(job("Engineer", "Remote - India"), r).fit).toBe(true);
    expect(checkFit(job("Engineer", "Remote - US"), r)).toMatchObject({
      fit: false,
      reason: expect.stringContaining("remote role limited"),
    });
    expect(checkFit(job("Engineer", "Berlin, Germany"), r).fit).toBe(false);
  });

  it("with cities listed, a job must be in one of them", () => {
    const r = rules({ countries: ["India"], locations: ["Pune"] });
    expect(checkFit(job("Engineer", "Pune, India"), r).fit).toBe(true);
    expect(checkFit(job("Engineer", "Hyderabad, India"), r).fit).toBe(false);
  });

  it("filters by seniority", () => {
    expect(seniorityOf("Senior Software Engineer")).toBe("senior");
    expect(seniorityOf("Staff Engineer")).toBe("staff");
    expect(seniorityOf("Engineering Manager, Payments")).toBe("lead");
    expect(seniorityOf("Product Manager")).toBe("mid");
    expect(seniorityOf("Software Engineering Intern")).toBe("intern");
    const r = rules({ seniority: ["mid", "senior"] });
    expect(checkFit(job("Software Engineer", ""), r).fit).toBe(true);
    expect(checkFit(job("Principal Engineer", ""), r)).toMatchObject({ fit: false });
  });

  it("reads stated pay and skips postings below the minimum", () => {
    expect(parseSalary("The base pay range is $120,000 - $150,000 per year.")).toEqual({
      currency: "USD",
      max: 150000,
    });
    expect(parseSalary("Compensation: €60.000–€75.000")).toEqual({ currency: "EUR", max: 75000 });
    expect(parseSalary("CTC ₹25-30 LPA")).toEqual({ currency: "INR", max: 3000000 });
    expect(parseSalary("Salary: INR 18,00,000 to 24,00,000")).toEqual({ currency: "INR", max: 2400000 });
    expect(parseSalary("$140K – $180K + equity")).toEqual({ currency: "USD", max: 180000 });
    expect(parseSalary("$45 - $60 per hour")).toBeUndefined();
    expect(parseSalary("Get a $5 coffee voucher")).toBeUndefined();
    const r = rules({ minSalary: { amount: 2500000, currency: "INR" } });
    expect(checkFit(job("Engineer", "", "Pay: ₹15-20 LPA"), r)).toMatchObject({ fit: false });
    expect(checkFit(job("Engineer", "", "Pay: ₹25-35 LPA"), r).fit).toBe(true);
    // Another currency, or no pay stated: not filtered.
    expect(checkFit(job("Engineer", "", "Pay: $50,000 - $60,000"), r).fit).toBe(true);
    expect(checkFit(job("Engineer", "", "Great team"), r).fit).toBe(true);
  });
});
