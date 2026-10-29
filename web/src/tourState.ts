/**
 * Where the tour stands, kept in localStorage. "done" means finished or dismissed for good. "step" is the
 * step it was on while open: when the tour is left unfinished (a link in it, Skip, Escape, a reload) the
 * dashboard shows a small "Continue quick tour" banner that reopens it there.
 */
export const TOUR_DONE_KEY = "quietapply-tour-done";
export const TOUR_STEP_KEY = "quietapply-tour-step";

/** The part of localStorage the tour needs (kept DOM-free so it can be tested in Node). */
export interface TourStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TourState {
  /** The step shown in the dialog, or null when the dialog is closed. */
  open: number | null;
  /** The step the banner offers to continue from, or null for no banner. */
  paused: number | null;
}

function savedStep(store: TourStore, total: number): number | null {
  const raw = store.getItem(TOUR_STEP_KEY);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n < total ? n : null;
}

/** On page load: ?tour=N opens step N; a tour left unfinished shows the banner; the first visit opens step 1. */
export function initialTour(store: TourStore, hash: string, total: number): TourState {
  const n = Number(new URLSearchParams(hash.split("?")[1]).get("tour"));
  if (n >= 1 && n <= total) return { open: n - 1, paused: null };
  const step = savedStep(store, total);
  if (step !== null) return { open: null, paused: step };
  if (store.getItem(TOUR_DONE_KEY)) return { open: null, paused: null };
  return { open: 0, paused: null };
}

/** Called whenever the dialog shows a step, so a reload or a link can come back to it. */
export function rememberStep(store: TourStore, step: number): void {
  store.setItem(TOUR_STEP_KEY, String(step));
}

/** Left unfinished: close the dialog and offer to continue. */
export function pauseTour(store: TourStore, step: number): TourState {
  rememberStep(store, step);
  return { open: null, paused: step };
}

/** Done on the last step, or × on the banner: no dialog, no banner. */
export function finishTour(store: TourStore): TourState {
  store.setItem(TOUR_DONE_KEY, "1");
  store.removeItem(TOUR_STEP_KEY);
  return { open: null, paused: null };
}
