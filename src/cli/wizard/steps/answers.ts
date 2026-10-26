import { listAnswers } from "../../../memory/answers.js";
import { COUNTRIES, countryByName } from "../../../memory/countries.js";
import { STANDARD_QUESTIONS } from "../../../memory/seed.js";
import { remember, type Step, savedAnswer, splitList, type WizardContext } from "../context.js";

export const CURRENCIES = ["INR", "USD", "EUR", "GBP", "CAD", "AUD", "SGD", "AED"];
const DECLINE = "I prefer not to answer";
const DEMOGRAPHIC_KEYS = ["gender", "race_ethnicity", "veteran", "disability", "pronouns"];

/** "Yes in India; No in United States (needs sponsorship)" for the one global answer forms without a country get. */
function summarise(rows: { country: string; authorized: boolean; sponsorship: boolean }[]) {
  if (rows.length === 1)
    return { auth: rows[0]!.authorized ? "Yes" : "No", sponsor: rows[0]!.sponsorship ? "Yes" : "No" };
  const auth = rows.map((r) => `${r.authorized ? "Yes" : "No"} in ${r.country}`).join("; ");
  const needs = rows.filter((r) => r.sponsorship).map((r) => r.country);
  const sponsor = needs.length ? `Yes for ${needs.join(", ")}; no elsewhere` : "No";
  return { auth, sponsor };
}

/** Pre-fill "INR 30,00,000 per year" style answers: split into currency and amount. */
function splitMoney(v: string | undefined): { currency?: string; amount: string } {
  if (!v) return { amount: "" };
  const m = /^([A-Z]{3})\s+(.*?)(\s+per year)?$/.exec(v.trim());
  return m ? { currency: m[1], amount: m[2]! } : { amount: v };
}

/** Step 3: the questions almost every application form asks, answered once. */
export const answersStep: Step = {
  id: "answers",
  title: "Standard answers",
  async run(ctx: WizardContext) {
    const { ui, db, config, profile } = ctx;
    if (!ui.interactive) {
      // Never store a guess as someone's answer: without a person to ask, only the safe defaults
      // (demographics declined, referral source) are kept, and forms ask the rest in the dashboard.
      ui.info("Standard answers skipped (no terminal). Forms that need them will ask in the dashboard.");
      return "skipped";
    }
    ui.info(
      "Questions almost every form asks. Answer once; change any of them later in the dashboard (Memory).",
    );

    // Countries first: work authorisation and sponsorship are asked per country.
    const known = COUNTRIES.map((c) => c.name);
    const homeCountry = countryByName(profile.country ?? "")?.name;
    const initial = config.rules.countries.length
      ? config.rules.countries.filter((c) => known.includes(c))
      : homeCountry
        ? [homeCountry]
        : [];
    const picked = await ui.multiselect({
      message: "Which countries do you want to work in? (space to tick, enter to continue)",
      initial,
      options: COUNTRIES.map((c) => ({ value: c.name, label: c.name })),
    });
    const others = await ui.text({
      message: "Any other countries? (comma separated, optional)",
      initial: config.rules.countries.filter((c) => !known.includes(c)).join(", "),
    });
    config.rules.countries = [...picked, ...splitList(others)];

    const rows: { country: string; authorized: boolean; sponsorship: boolean }[] = [];
    for (const country of config.rules.countries) {
      const cc = countryByName(country)?.code ?? country.toLowerCase().replace(/\s+/g, "-");
      const prevAuth = savedAnswer(db, `work_authorization:${cc}`);
      const prevSponsor = savedAnswer(db, `sponsorship:${cc}`);
      const status = await ui.select({
        message: `Can you work in ${country}?`,
        initial: prevAuth === "No" ? "no" : prevSponsor === "Yes" ? "visa" : "citizen",
        options: [
          { value: "citizen", label: "Yes: citizen or permanent resident" },
          { value: "visa", label: "Yes, on a visa or permit" },
          { value: "no", label: "No, not yet" },
        ],
      });
      const sponsorship =
        status === "citizen"
          ? false
          : await ui.confirm({
              message: `Will you need visa sponsorship to work in ${country}, now or later?`,
              initial: status === "no" || prevSponsor === "Yes",
            });
      const authorized = status !== "no";
      remember(
        db,
        `work_authorization:${cc}`,
        `Are you legally authorized to work in ${country}?`,
        authorized ? "Yes" : "No",
        { type: "yesno" },
      );
      remember(
        db,
        `sponsorship:${cc}`,
        `Will you now or in the future require visa sponsorship to work in ${country}?`,
        sponsorship ? "Yes" : "No",
        { type: "yesno" },
      );
      rows.push({ country, authorized, sponsorship });
    }
    if (rows.length) {
      const s = summarise(rows);
      remember(
        db,
        "work_authorization",
        STANDARD_QUESTIONS.find((q) => q.key === "work_authorization")!.question,
        s.auth,
      );
      remember(
        db,
        "sponsorship",
        STANDARD_QUESTIONS.find((q) => q.key === "sponsorship")!.question,
        s.sponsor,
      );
    }

    // Notice period / start date.
    const NOTICE = ["Immediately", "15 days", "30 days", "60 days", "90 days"];
    const prevNotice = savedAnswer(db, "notice_period");
    const notice = await ui.select({
      message: "Notice period: how soon could you start after an offer?",
      initial: prevNotice ? (NOTICE.includes(prevNotice) ? prevNotice : "other") : "30 days",
      options: [...NOTICE.map((n) => ({ value: n, label: n })), { value: "other", label: "Something else" }],
    });
    const noticeText =
      notice === "other"
        ? await ui.text({
            message: "Your notice period or earliest start date",
            initial: prevNotice ?? "",
            placeholder: "e.g. 45 days, or from 1 March 2027",
          })
        : notice;
    remember(db, "notice_period", "What is your notice period?", noticeText);

    // Salary, with currency.
    const prevExpected = splitMoney(savedAnswer(db, "salary_expectation"));
    const prevCurrent = splitMoney(savedAnswer(db, "current_salary"));
    const homeCurrency = countryByName(profile.country ?? "")?.code === "in" ? "INR" : undefined;
    const currency = await ui.select({
      message: "Currency for salary answers",
      initial: prevExpected.currency ?? config.rules.minSalary?.currency ?? homeCurrency ?? "USD",
      options: [...CURRENCIES.map((c) => ({ value: c, label: c })), { value: "other", label: "Other" }],
    });
    const cur =
      currency === "other"
        ? (
            await ui.text({ message: "Currency code (e.g. CHF)", initial: prevExpected.currency ?? "" })
          ).toUpperCase()
        : currency;
    const money = (v: string) => (v ? `${cur} ${v} per year` : "");
    const current = await ui.text({
      message: `Current yearly salary in ${cur} (optional; leave empty and forms that ask will come to you)`,
      initial: prevCurrent.amount,
      placeholder: cur === "INR" ? "18,00,000" : "95,000",
    });
    remember(db, "current_salary", "What is your current salary?", money(current), { sensitive: true });
    const expected = await ui.text({
      message: `Expected yearly salary in ${cur}`,
      initial: prevExpected.amount,
      placeholder: cur === "INR" ? "25,00,000 to 30,00,000" : "120,000 to 140,000",
    });
    remember(db, "salary_expectation", "What are your salary expectations?", money(expected), {
      sensitive: true,
    });

    // Relocation, work arrangement, travel.
    const prevReloc = savedAnswer(db, "relocation");
    const reloc = await ui.select({
      message: "Are you open to relocating?",
      initial: prevReloc === "No" ? "No" : prevReloc?.startsWith("Yes") ? prevReloc : "No",
      options: [
        { value: "Yes", label: "Yes" },
        { value: "Yes, within my country", label: "Only within my country" },
        { value: "No", label: "No" },
      ],
    });
    remember(db, "relocation", "Are you willing to relocate?", reloc);

    const prevMode = (savedAnswer(db, "work_mode") ?? "Remote, Hybrid").toLowerCase();
    const modes = await ui.multiselect({
      message: "Which work arrangements suit you?",
      initial: (["remote", "hybrid", "onsite"] as const).filter((m) =>
        prevMode.includes(m === "onsite" ? "on-site" : m),
      ),
      options: [
        { value: "remote", label: "Remote" },
        { value: "hybrid", label: "Hybrid" },
        { value: "onsite", label: "On-site" },
      ],
    });
    const modeText = modes
      .map((m) => (m === "onsite" ? "On-site" : m[0]!.toUpperCase() + m.slice(1)))
      .join(", ");
    remember(db, "work_mode", "Which work arrangements are you open to (remote, hybrid, on-site)?", modeText);
    // Remote work fine → remote roles pass the location filter.
    const hasRemote = config.rules.locations.some((l) => l.toLowerCase() === "remote");
    if (modes.includes("remote") && !hasRemote) config.rules.locations.push("remote");
    if (modes.length && !modes.includes("remote") && hasRemote)
      config.rules.locations = config.rules.locations.filter((l) => l.toLowerCase() !== "remote");

    const TRAVEL = ["No travel", "Up to 10%", "Up to 25%", "Up to 50%", "Any amount"];
    const prevTravel = savedAnswer(db, "travel");
    const travel = await ui.select({
      message: "How much work travel is fine?",
      initial: prevTravel && TRAVEL.includes(prevTravel) ? prevTravel : "Up to 10%",
      options: TRAVEL.map((t) => ({ value: t, label: t })),
    });
    remember(db, "travel", "Are you willing to travel for work? How much?", travel);

    const referral = await ui.text({
      message: 'Default answer for "How did you hear about this job?"',
      initial: savedAnswer(db, "referral") ?? "Company careers page",
    });
    remember(db, "referral", "How did you hear about this job?", referral);

    const consent = await ui.confirm({
      message: "Tick privacy/data-processing consent boxes on forms for you? (most forms require it)",
      initial: savedAnswer(db, "data_consent") !== "No",
    });
    remember(
      db,
      "data_consent",
      STANDARD_QUESTIONS.find((q) => q.key === "data_consent")!.question,
      consent ? "Yes" : "No",
      { type: "yesno" },
    );

    // Demographics: decline by default.
    const demo = listAnswers(db).filter(
      (a) => a.key && DEMOGRAPHIC_KEYS.includes(a.key) && a.scope === "global",
    );
    const allDecline = demo.every((a) => a.answer === DECLINE);
    const keep = await ui.confirm({
      message: `Voluntary diversity questions (gender, race/ethnicity, veteran, disability, pronouns): answer "${DECLINE}"?`,
      initial: allDecline,
    });
    for (const key of DEMOGRAPHIC_KEYS) {
      const q = STANDARD_QUESTIONS.find((x) => x.key === key)!;
      const answer = keep
        ? DECLINE
        : await ui.text({ message: q.question, initial: savedAnswer(db, key) ?? DECLINE });
      remember(db, key, q.question, answer || DECLINE, { sensitive: true });
    }

    // Cover letters.
    config.coverLetterStyle = await ui.select({
      message: "Cover letters, when a form has a box for one",
      initial: config.coverLetterStyle,
      options: [
        { value: "short", label: "Short and direct", hint: "3-4 sentences" },
        { value: "warm", label: "Warm and personal" },
        { value: "formal", label: "Formal" },
        { value: "template", label: "Use my own template" },
        { value: "none", label: "Skip optional cover letters" },
      ],
    });
    if (config.coverLetterStyle !== "none") {
      // Every typed value must come from memory, so the agent writes cover letters from a stored base.
      const t = await ui.text({
        message:
          config.coverLetterStyle === "template"
            ? "Paste your base cover letter (one paragraph; the agent adapts it to each company without adding facts)"
            : "A short base cover letter for the agent to adapt (optional; without one, forms that require a cover letter ask you)",
        initial: savedAnswer(db, "cover_letter") ?? "",
      });
      remember(db, "cover_letter", "A short base cover letter (optional).", t, { type: "long" });
    }

    // The rest: asked now only with --full, otherwise when a form needs them.
    const asked = new Set([
      "work_authorization",
      "sponsorship",
      "notice_period",
      "salary_expectation",
      "current_salary",
      "relocation",
      "work_mode",
      "travel",
      "referral",
      "data_consent",
      "cover_letter",
      ...DEMOGRAPHIC_KEYS,
    ]);
    const extra = STANDARD_QUESTIONS.filter((q) => !asked.has(q.key) && !savedAnswer(db, q.key));
    if (!extra.length) return;
    const more =
      ctx.opts.full ||
      (ui.interactive &&
        (await ui.confirm({
          message: `${extra.length} more questions some forms ask (commute, shifts, background check…). Answer them now?`,
          initial: false,
        })));
    if (!more) {
      ui.info("Skipped. The agent asks you in the dashboard when a form needs one of them.");
      return;
    }
    for (const q of extra) {
      const v =
        q.type === "yesno"
          ? await ui.select({
              message: q.question,
              initial: "",
              options: [
                { value: "Yes", label: "Yes" },
                { value: "No", label: "No" },
                { value: "", label: "Skip" },
              ],
            })
          : await ui.text({ message: q.question, placeholder: q.hint ?? "" });
      remember(db, q.key, q.question, v, { type: q.type });
    }
  },
};
