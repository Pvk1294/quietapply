import { existsSync } from "node:fs";
import { mergeCompanyList } from "../companies/starter.js";
import { type Company, defaultConfig, loadConfig, type ProviderId } from "../core/config.js";
import { openDb } from "../core/db.js";
import { ensureHome, paths } from "../core/paths.js";
import { loadProfile } from "../memory/profile.js";
import { PROVIDERS } from "../providers/index.js";
import { discover } from "../runner/discover.js";
import { scheduleOn } from "../scheduler/index.js";
import { detectAts } from "../sources/detect.js";
import { defaultFetcher } from "../sources/http.js";
import { doctor } from "./doctor.js";
import { importResume } from "./setup.js";
import { STEP_IDS, type WizardContext } from "./wizard/context.js";
import { isStepId, runWizard } from "./wizard/index.js";
import { defaultsPrompter, terminalPrompter } from "./wizard/prompter.js";

export interface InitOptions {
  resume?: string;
  provider?: ProviderId;
  yes?: boolean;
  full?: boolean;
  step?: string;
  /** Path of the CLI entry point, for `schedule on`. */
  cliPath: string;
}

/** `quietapply init`: the step-by-step setup wizard (or, with --yes, the same steps with their defaults). */
export async function init(opts: InitOptions): Promise<void> {
  const dirs = ensureHome(paths());
  const step = opts.step;
  if (step !== undefined && !isStepId(step))
    throw new Error(`Unknown step "${step}". Steps: ${STEP_IDS.join(", ")}`);
  const interactive = !opts.yes && !!process.stdin.isTTY;
  const db = openDb(dirs);
  const ctx: WizardContext = {
    ui: interactive ? terminalPrompter : defaultsPrompter((l) => console.log(l)),
    dirs,
    db,
    config: existsSync(dirs.config) ? loadConfig(dirs) : defaultConfig(),
    profile: loadProfile(dirs),
    deps: {
      providers: PROVIDERS,
      fetcher: defaultFetcher,
      importResume,
      doctor,
      scheduleOn: () => scheduleOn(dirs, opts.cliPath),
      discover: () => discover(db, loadConfig(dirs), loadProfile(dirs), defaultFetcher),
    },
    opts: { resume: opts.resume, provider: opts.provider, full: opts.full },
  };
  try {
    await runWizard(ctx, { step });
  } finally {
    db.close();
  }
}

/** Companies from careers-page URLs that name their ATS directly (no network). */
export function mergeCompanies(existing: Company[], urls: string[]): Company[] {
  const found: Company[] = [];
  for (const u of urls) {
    const ref = detectAts(u);
    if (ref) found.push({ name: ref.token.replace(/[-_]/g, " "), ats: ref.ats, token: ref.token });
  }
  return mergeCompanyList(existing, found);
}
