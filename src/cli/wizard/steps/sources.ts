import { resolveCareersUrl } from "../../../companies/resolve.js";
import { mergeCompanyList, suggestCompanies, toCompany } from "../../../companies/starter.js";
import type { Company } from "../../../core/config.js";
import { type Step, splitList, type WizardContext } from "../context.js";

export const LINKEDIN_NOTE = [
  "LinkedIn stays off. Its User Agreement (section 8.2) forbids bots and automated access, and LinkedIn",
  "restricts accounts that use them. QuietApply v0.1 does not automate LinkedIn at all; it applies on the",
  "company's own job board instead, which is where most LinkedIn job links end up anyway.",
].join("\n");

/** How many starter companies to add when the person takes the recommended set. */
export const RECOMMENDED = 40;

/** Paste careers-page URLs until they all resolve or the person moves on. */
export async function addFromUrls(ctx: WizardContext, companies: Company[]): Promise<Company[]> {
  const { ui } = ctx;
  let out = companies;
  for (;;) {
    const text = await ui.text({
      message: "Paste careers-page URLs of other companies (comma separated, optional)",
      placeholder: "https://boards.greenhouse.io/acme, https://acme.com/careers",
    });
    const urls = splitList(text);
    if (!urls.length) return out;
    const results = await ui.spin(
      `Checking ${urls.length} link${urls.length > 1 ? "s" : ""}`,
      () => Promise.all(urls.map((u) => resolveCareersUrl(u, ctx.deps.fetcher))),
      (rs) => `${rs.filter((r) => r.ok).length} of ${rs.length} found`,
    );
    for (const r of results) {
      if (r.ok) {
        ui.success(`${r.company.name}: ${r.company.ats} board "${r.company.token}", ${r.jobs} open jobs`);
        out = mergeCompanyList(out, [r.company]);
      } else ui.warn(`${r.input}: ${r.reason}`);
    }
    if (results.every((r) => r.ok)) return out;
  }
}

/** Step 5: which job sites, and which companies. */
export const sourcesStep: Step = {
  id: "sources",
  title: "Where to apply",
  async run(ctx: WizardContext) {
    const { ui, config } = ctx;
    const on = await ui.multiselect({
      message: "Job sites to apply on (no login needed on any of these)",
      initial: (["greenhouse", "lever", "ashby"] as const).filter((s) => config.sources[s]),
      options: [
        { value: "greenhouse", label: "Greenhouse" },
        { value: "lever", label: "Lever" },
        { value: "ashby", label: "Ashby" },
      ],
      required: true,
    });
    config.sources.greenhouse = on.includes("greenhouse");
    config.sources.lever = on.includes("lever");
    config.sources.ashby = on.includes("ashby");
    config.sources.linkedin = false;
    ui.note(LINKEDIN_NOTE, "LinkedIn: off");

    const suggestions = suggestCompanies(config);
    if (config.companies.length) ui.info(`${config.companies.length} companies already on your list.`);
    if (suggestions.length) {
      const how = await ui.select({
        message: `${suggestions.length} companies from QuietApply's checked list match your roles and places.`,
        initial: ui.interactive ? "best" : "skip",
        options: [
          {
            value: "best",
            label: `Add the best ${Math.min(RECOMMENDED, suggestions.length)}`,
            hint: suggestions
              .slice(0, 4)
              .map((s) => s.name)
              .join(", "),
          },
          { value: "pick", label: "Let me pick from the list" },
          { value: "skip", label: "None from the list" },
        ],
      });
      let chosen: typeof suggestions = [];
      if (how === "best") chosen = suggestions.slice(0, RECOMMENDED);
      if (how === "pick") {
        const ids = await ui.multiselect({
          message: "Tick the companies to watch",
          initial: suggestions.slice(0, Math.min(20, suggestions.length)).map((s) => `${s.ats}:${s.token}`),
          options: suggestions.slice(0, 120).map((s) => ({
            value: `${s.ats}:${s.token}`,
            label: s.name,
            hint: `${s.jobs} open · ${s.why.join(", ")}`,
          })),
        });
        chosen = suggestions.filter((s) => ids.includes(`${s.ats}:${s.token}`));
      }
      config.companies = mergeCompanyList(config.companies, chosen.map(toCompany));
    } else {
      ui.info("No company on the starter list matches yet; add your own below.");
    }

    if (ui.interactive) config.companies = await addFromUrls(ctx, config.companies);
    ui.success(
      `Watching ${config.companies.length} companies. Change the list in the dashboard (Settings → Companies).`,
    );
  },
};
