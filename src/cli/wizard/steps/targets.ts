import { INDUSTRIES } from "../../../companies/starter.js";
import { SENIORITY } from "../../../core/config.js";
import { type Step, splitList, type WizardContext } from "../context.js";
import { CURRENCIES } from "./answers.js";

/** A sensible first guess of levels from years of experience. */
export function levelsForYears(years: number | undefined): string[] {
  if (years === undefined) return [];
  if (years < 1) return ["intern", "entry"];
  if (years < 3) return ["entry", "mid"];
  if (years < 6) return ["mid", "senior"];
  if (years < 10) return ["senior", "staff", "lead"];
  return ["senior", "staff", "lead", "director"];
}

const isCurrent = (end: string | undefined) => !end || /present|current|now|today/i.test(end);

/** Step 4: what to apply for. */
export const targetsStep: Step = {
  id: "targets",
  title: "What to apply for",
  async run(ctx: WizardContext) {
    const { ui, config, profile } = ctx;
    const rules = config.rules;

    const roles = await ui.text({
      message: "Job titles to look for (comma separated)",
      initial: rules.roles.length ? rules.roles.join(", ") : (profile.experience[0]?.title ?? ""),
      placeholder: "software engineer, backend developer",
    });
    rules.roles = splitList(roles);

    rules.seniority = await ui.multiselect({
      message: "Seniority levels (none ticked = any level)",
      initial: rules.seniority.length ? rules.seniority : levelsForYears(profile.totalYears),
      options: SENIORITY.map((s) => ({ value: s.id, label: s.label })),
    });

    const cities = await ui.text({
      message: `Cities you'd work in, comma separated (empty = anywhere in ${rules.countries.length ? rules.countries.join(", ") : "the world"})`,
      initial: rules.locations.filter((l) => l.toLowerCase() !== "remote").join(", ") || profile.city || "",
      placeholder: "Bengaluru, Pune",
    });
    const remote = await ui.confirm({
      message: "Remote roles are fine?",
      initial: rules.locations.some((l) => l.toLowerCase() === "remote") || !rules.locations.length,
    });
    rules.locations = [...splitList(cities), ...(remote ? ["remote"] : [])];
    if (ui.interactive && rules.countries.length) {
      const countries = await ui.text({ message: "Countries", initial: rules.countries.join(", ") });
      rules.countries = splitList(countries);
    }

    const prevMin = rules.minSalary;
    const min = await ui.text({
      message: "Minimum yearly salary (skip postings that state less; empty = no minimum)",
      initial: prevMin ? String(prevMin.amount) : "",
      placeholder: "e.g. 2500000 or 120000",
      validate: (v) => (!v || /^\d[\d,]*$/.test(v) ? undefined : "Digits only, e.g. 2500000"),
    });
    if (min) {
      const currency = await ui.select({
        message: "In which currency?",
        initial: prevMin?.currency ?? "USD",
        options: CURRENCIES.map((c) => ({ value: c, label: c })),
      });
      rules.minSalary = { amount: Number(min.replace(/,/g, "")), currency };
    } else rules.minSalary = undefined;

    config.preferences.industries = await ui.multiselect({
      message: "Industries you'd like (optional; used to pick companies)",
      initial: config.preferences.industries,
      options: INDUSTRIES.map((i) => ({ value: i.id, label: i.label })),
    });
    config.preferences.sizes = await ui.multiselect({
      message: "Company sizes you'd like (optional)",
      initial: config.preferences.sizes,
      options: [
        { value: "startup", label: "Startup", hint: "under 200 people" },
        { value: "scaleup", label: "Scale-up", hint: "200 to 2,000" },
        { value: "large", label: "Large", hint: "2,000+" },
      ],
    });

    const current = profile.experience.find((e) => isCurrent(e.end))?.company;
    const never = await ui.text({
      message: "Companies never to apply to (e.g. your current employer)",
      initial: rules.neverApply.length ? rules.neverApply.join(", ") : (current ?? ""),
    });
    rules.neverApply = splitList(never);

    const perDay = await ui.text({
      message: "Most applications per day",
      initial: String(config.limits.perDay),
      validate: (v) => (/^\d{1,3}$/.test(v) && Number(v) <= 100 ? undefined : "A number from 0 to 100"),
    });
    config.limits.perDay = Number(perDay);
  },
};
