import { saveConfig } from "../../core/config.js";
import { seedDefaults } from "../setup.js";
import { loadState, STEP_IDS, type Step, type StepId, saveState, type WizardContext } from "./context.js";
import { SetupCancelled } from "./prompter.js";
import { aiStep } from "./steps/ai.js";
import { answersStep } from "./steps/answers.js";
import { loginsStep } from "./steps/logins.js";
import { resumeStep } from "./steps/resume.js";
import { safetyStep } from "./steps/safety.js";
import { sourcesStep } from "./steps/sources.js";
import { targetsStep } from "./steps/targets.js";

export const STEPS: Step[] = [
  aiStep,
  resumeStep,
  answersStep,
  targetsStep,
  sourcesStep,
  loginsStep,
  safetyStep,
];

export function isStepId(s: string): s is StepId {
  return (STEP_IDS as readonly string[]).includes(s);
}

/** Which steps to run: everything, the unfinished rest, or one step the person picked. */
async function plan(ctx: WizardContext, done: StepId[], only?: StepId): Promise<Step[]> {
  if (only) return STEPS.filter((s) => s.id === only);
  const { ui } = ctx;
  if (!done.length || !ui.interactive) return STEPS;
  const remaining = STEPS.filter((s) => !done.includes(s.id));
  const pickOne = async () => {
    const id = await ui.select({
      message: "Which part?",
      options: STEPS.map((s, i) => ({
        value: s.id,
        label: `${i + 1}. ${s.title}`,
        hint: done.includes(s.id) ? "done" : undefined,
      })),
    });
    return STEPS.filter((s) => s.id === id);
  };
  if (!remaining.length) {
    const what = await ui.select({
      message: "Setup is complete. What would you like to do?",
      initial: "one",
      options: [
        { value: "one", label: "Change one part" },
        { value: "all", label: "Go through everything again", hint: "your answers are pre-filled" },
        { value: "exit", label: "Nothing, exit" },
      ],
    });
    return what === "one" ? pickOne() : what === "all" ? STEPS : [];
  }
  const first = remaining[0]!;
  const what = await ui.select({
    message: `You finished ${done.length} of ${STEPS.length} steps last time.`,
    initial: "continue",
    options: [
      { value: "continue", label: `Continue at step ${STEPS.indexOf(first) + 1}: ${first.title}` },
      { value: "all", label: "Start from the beginning", hint: "your answers are pre-filled" },
      { value: "one", label: "Change one part" },
    ],
  });
  return what === "one" ? pickOne() : what === "all" ? STEPS : remaining;
}

/**
 * `quietapply init`: the setup wizard. Each step saves its answers as soon as it ends, and the list of
 * finished steps is kept in setup-state.json, so quitting halfway loses nothing.
 */
export async function runWizard(ctx: WizardContext, o: { step?: StepId } = {}): Promise<"done" | "stopped"> {
  const { ui, dirs } = ctx;
  const state = loadState(dirs);
  seedDefaults(ctx.db);
  ui.intro("QuietApply setup");
  ui.info(`Your data stays on this computer, in ${dirs.home} (only you can read it).`);
  let current: Step | undefined;
  try {
    const steps = await plan(ctx, state.done, o.step);
    for (const step of steps) {
      current = step;
      ui.step(`Step ${STEPS.indexOf(step) + 1} of ${STEPS.length}: ${step.title}`);
      const result = await step.run(ctx);
      saveConfig(ctx.config, dirs);
      if (result !== "skipped" && !state.done.includes(step.id)) state.done.push(step.id);
      saveState(dirs, state);
    }
  } catch (err) {
    if (!(err instanceof SetupCancelled)) throw err;
    saveConfig(ctx.config, dirs);
    ui.outro(
      `Stopped${current ? ` during "${current.title}"` : ""}. Everything before it is saved; run \`quietapply init\` to continue.`,
    );
    return "stopped";
  }
  const left = STEPS.filter((s) => !state.done.includes(s.id));
  if (left.length) {
    ui.outro(
      `Saved. Still to do: ${left.map((s) => s.title).join(", ")}. Run \`quietapply init\` to continue.`,
    );
    return "done";
  }
  ui.note(
    [
      "quietapply dashboard     answers, settings and applications: http://127.0.0.1:4777",
      "quietapply discover      find open roles at your companies",
      "quietapply run           one run now (dry run: nothing is submitted)",
      "quietapply init          change any answer later (or use the dashboard)",
    ].join("\n"),
    "Next",
  );
  ui.outro(
    ctx.config.dryRun
      ? `Dry run is ON: nothing is submitted. After you turn it off, the first ${ctx.config.limits.reviewFirst} applications wait for your OK.`
      : `Dry run is off. The first ${ctx.config.limits.reviewFirst} applications wait for your OK in the dashboard.`,
  );
  return "done";
}
