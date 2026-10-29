import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  finishTour,
  initialTour,
  pauseTour,
  rememberStep,
  TOUR_DONE_KEY,
  TOUR_STEP_KEY,
  type TourStore,
} from "../web/src/tourState.js";

function store(init: Record<string, string> = {}): TourStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const TOTAL = 9;

describe("tour state", () => {
  it("opens at step 1 on the first visit, with no banner", () => {
    expect(initialTour(store(), "#/today", TOTAL)).toEqual({ open: 0, paused: null });
  });

  it("a link in step 2 closes the dialog and offers to continue at step 2, also after a reload", () => {
    const s = store();
    rememberStep(s, 0);
    rememberStep(s, 1);
    expect(pauseTour(s, 1)).toEqual({ open: null, paused: 1 });
    expect(initialTour(s, "#/settings", TOTAL)).toEqual({ open: null, paused: 1 });
  });

  it("a reload while the dialog is open comes back as the banner at that step", () => {
    const s = store();
    rememberStep(s, 4);
    expect(initialTour(s, "#/today", TOTAL)).toEqual({ open: null, paused: 4 });
  });

  it("Done or the banner's × ends it for good", () => {
    const s = store({ [TOUR_STEP_KEY]: "3" });
    expect(finishTour(s)).toEqual({ open: null, paused: null });
    expect(s.data.get(TOUR_DONE_KEY)).toBe("1");
    expect(initialTour(s, "#/today", TOTAL)).toEqual({ open: null, paused: null });
  });

  it("reopening from Help after finishing and leaving again shows the banner", () => {
    const s = store({ [TOUR_DONE_KEY]: "1" });
    rememberStep(s, 0);
    pauseTour(s, 0);
    expect(initialTour(s, "#/today", TOTAL)).toEqual({ open: null, paused: 0 });
  });

  it("?tour=N opens that step, and a broken saved step is ignored", () => {
    expect(initialTour(store({ [TOUR_DONE_KEY]: "1" }), "#/today?tour=3", TOTAL).open).toBe(2);
    expect(initialTour(store({ [TOUR_STEP_KEY]: "42" }), "#/today", TOTAL)).toEqual({
      open: 0,
      paused: null,
    });
  });
});

describe("dashboard copy", () => {
  // Sentences joined with ";" read badly: use two sentences, a comma or a dash.
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
    );

  it("has no semicolons in the tour, the pages or any other text the dashboard shows", () => {
    const hits: string[] = [];
    for (const f of files(join(import.meta.dirname, "../web/src"))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.match(/"[^"\n]*"/g) ?? []) if (/\w; \w/.test(m)) hits.push(`${f}: ${m}`);
      // JSX text: a line of words with no code on it.
      for (const line of src.split("\n"))
        if (/\w; \w/.test(line) && !/[:=(){}"`]/.test(line) && !/^\s*(\/\/|\/\*|\*)/.test(line))
          hits.push(`${f}: ${line}`);
    }
    expect(hits).toEqual([]);
  });
});
