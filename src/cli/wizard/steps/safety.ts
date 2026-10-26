import { saveConfig } from "../../../core/config.js";
import type { Step, WizardContext } from "../context.js";

const mark = (ok: boolean | "warn") => (ok === true ? "✓" : ok === "warn" ? "!" : "✗");

/** Step 7: dry run, review mode, a doctor check, and the schedule. */
export const safetyStep: Step = {
  id: "safety",
  title: "Safety and first run",
  async run(ctx: WizardContext) {
    const { ui, config } = ctx;
    config.dryRun = await ui.confirm({
      message: "Keep dry run on? Forms are filled but never submitted until you turn it off (recommended).",
      initial: config.dryRun,
    });
    const review = await ui.text({
      message: "Once dry run is off, how many applications should wait for your OK before Submit?",
      initial: String(config.limits.reviewFirst),
      validate: (v) => (/^\d{1,3}$/.test(v) ? undefined : "A number, e.g. 10"),
    });
    config.limits.reviewFirst = Number(review);
    // The doctor and scheduler read the saved config.
    saveConfig(config, ctx.dirs);

    const checks = await ui.spin(
      "Running quietapply doctor",
      () => ctx.deps.doctor(),
      () => "Checked your setup",
    );
    ui.note(
      checks.map((c) => `${mark(c.ok)} ${c.name.padEnd(26)} ${c.detail}`).join("\n"),
      "quietapply doctor",
    );
    const broken = checks.filter((c) => c.ok === false && c.name !== "Schedule");
    if (broken.length) ui.warn(`Fix ${broken.map((c) => c.name).join(", ")} before the first run.`);

    if (!ui.interactive) return;
    const schedule = await ui.confirm({
      message: `Run automatically at ${config.schedule.join(", ")} every day? (quietapply schedule on)`,
      initial: false,
    });
    if (schedule) {
      const r = ctx.deps.scheduleOn();
      (r.ok ? ui.success : ui.warn)(r.message);
    } else ui.info("No schedule. Turn it on later with `quietapply schedule on`.");

    if (
      config.companies.length &&
      (await ui.confirm({ message: "Look for matching open jobs now?", initial: true }))
    ) {
      const s = await ui.spin(
        "Checking your companies' job boards",
        () => ctx.deps.discover(),
        (r) => `Found ${r.found} open roles; ${r.added} fit and are queued`,
      );
      if (s.errors.length)
        ui.warn(`${s.errors.length} boards could not be read: ${s.errors.map((e) => e.company).join(", ")}`);
    }
  },
};
