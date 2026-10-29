import { type ReactNode, useEffect } from "react";
import "./tour.css";

interface Step {
  title: string;
  body: string[];
  link?: { label: string; href: string };
  warn?: boolean;
}

/** The first-run walkthrough. Plain words, one idea per step. */
export const STEPS: Step[] = [
  {
    title: "Welcome! Here is what QuietApply does",
    body: [
      "QuietApply fills in job applications for you, on your own computer, using the Claude or Codex you already have.",
      "It finds jobs at companies you pick, checks that each one fits your rules, and fills in the form. If a form asks something it does not know, it asks you here instead of guessing.",
      "Nothing leaves your computer except the applications themselves. This tour takes about two minutes, and you can skip it any time.",
    ],
  },
  {
    title: "Your profile comes from your resume",
    body: [
      "In the terminal, run quietapply init and give it your resume (PDF, Word or text). It builds your profile: name, contact details, past roles and skills.",
      "It also asks a few questions almost every form asks, like work authorization and notice period. Skip any you are unsure about. You will be asked later, only if a form needs it.",
    ],
    link: { label: "See your settings", href: "#/settings" },
  },
  {
    title: "Answer memory and the Questions page",
    body: [
      "Every answer you give is saved once in Memory. After that the agent reuses it on every form that asks the same thing, and it has to point to the saved answer for every value it types.",
      "When a form asks something new, the application waits on the Questions page. Answer it once, choose whether it applies to every company or just this one, and the application carries on at the next run.",
      "Some questions always come back to you, even with a saved answer: work authorization and visa, gender and other EEO questions, criminal history, statements you certify, agreements and consent boxes. You see the saved answer and confirm it for that job. You can change this list in config.yaml (safety.alwaysAsk).",
    ],
    link: { label: "Open Questions", href: "#/questions" },
  },
  {
    title: "Dry run first, then your OK on the first 10",
    body: [
      "Dry run is on at the start. The agent fills the forms but never presses Submit, so you can look at what it typed on the Applications page.",
      "When you turn dry run off, the first 10 applications still stop right before Submit and wait for your OK. That is the review. After 10 good ones, it applies on its own, up to your daily limit.",
      "Your OK covers exactly what you saw. If a value changes before it is sent, it waits for you again. Email applications work the same way, and they are off until you say yes in Settings.",
    ],
    link: { label: "Open Applications", href: "#/applications" },
  },
  {
    title: "Choose Claude or Codex",
    body: [
      "QuietApply does not come with its own AI. It runs the one you already use: Claude Code (with a Claude plan or an API key) or OpenAI Codex (with a ChatGPT plan or an API key).",
      "You choose during quietapply init. quietapply doctor checks that the one you picked is installed and signed in.",
    ],
  },
  {
    title: "Choose the browser",
    body: [
      "By default the agent uses its own separate Chrome window, so your everyday browser stays untouched. You can watch it work, and it keeps that window's sign-ins between runs.",
      "Claude plan users can instead let it drive their own Chrome through Claude in Chrome. That is what the optional LinkedIn mode uses.",
    ],
  },
  {
    title: "LinkedIn mode (optional, and it carries a risk)",
    warn: true,
    body: [
      "LinkedIn mode is off. It lets the agent apply to LinkedIn jobs, Easy Apply included, in your own logged-in browser, at a human pace and with a small daily limit of 5 (at most 15). It stops straight away on any warning or CAPTCHA and hands that job to you.",
      "Be clear about the risk: LinkedIn's User Agreement forbids automation. Accounts can be restricted, even with a small limit. If you turn it on, that risk is yours. Many people skip it, and that is a fine choice: Greenhouse, Lever and Ashby need none of this.",
      "Messages to recruiters are a second, separate yes on top of LinkedIn mode, and they add more risk. They are off by default: one short message per person at most, 3 a day, and your OK on the first 10.",
    ],
    link: { label: "LinkedIn settings", href: "#/settings" },
  },
  {
    title: "Limits",
    body: [
      "Limits keep things calm: 15 applications a day and 2 per company every 30 days by default. Fewer, well-matched applications get more replies.",
      "Run now starts a run whenever you like. Pause stops everything until you resume.",
    ],
    link: { label: "Open Settings", href: "#/settings" },
  },
  {
    title: "It runs on its own while your computer is on",
    body: [
      "With Run automatically on (setup asks, and it is on unless you said no), this dashboard starts by itself when you log in, and QuietApply runs at the times in Settings: 09:00, 13:00 and 19:00 to begin with.",
      "Nothing runs while the computer is off. If it was off or asleep at a run time, that run happens once, soon after you log in or it wakes, never several times.",
      "Turn it on or off any time in Settings, under Run automatically, or with quietapply schedule on or off. Dry run still applies: nothing is submitted until you turn dry run off.",
    ],
    link: { label: "Open Run automatically", href: "#/settings?autostart" },
  },
  {
    title: "Use it on your phone",
    body: [
      "The same dashboard can open on your phone through Tailscale, a free private network between your own devices.",
      "It stays inside your own Tailscale network. Nothing is public, and only the Tailscale logins you allow can open it. Turn it on in Settings, under Phone access.",
    ],
    link: { label: "Open Phone access", href: "#/settings?phone" },
  },
  {
    title: "What “Finish yourself” means",
    body: [
      "Every job QuietApply skipped or stopped on lands on the Finish yourself page, grouped by the reason: a CAPTCHA, a login, a video answer, a site it does not support, your own rules or limits, or a LinkedIn limit or warning.",
      "Each entry says what happened and what is needed, and lists the answers already filled in, with a Copy button for each. Open the job, finish it, then press I applied myself. Not interested leaves it alone. Retry queues it again when that makes sense. Entries marked Unclear may already have gone through, so look at the site first.",
      "That is everything. You can reopen this tour any time from Help / Tour in the sidebar.",
    ],
    link: { label: "Open Finish yourself", href: "#/handoff" },
  },
];

/** The tour dialog. `onClose` leaves it unfinished (Skip, Escape, a link in a step); `onDone` finishes it. */
export function Tour({
  step,
  onStep,
  onClose,
  onDone,
}: {
  step: number;
  onStep: (n: number) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const s = STEPS[step]!;
  const last = step === STEPS.length - 1;
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div className="tour-backdrop">
      <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <div className="tour-eyebrow">
          Step {step + 1} of {STEPS.length}
        </div>
        <h2 id="tour-title">{s.title}</h2>
        {s.body.map((t) => (
          <p key={t} className={s.warn && t.startsWith("Be clear") ? "tour-warn" : undefined}>
            {t}
          </p>
        ))}
        {s.link && (
          <a className="tour-link" href={s.link.href} onClick={onClose}>
            {s.link.label} →
          </a>
        )}
        <div className="tour-foot">
          <div className="tour-dots" aria-hidden="true">
            {STEPS.map((x, i) => (
              <span key={x.title} className={i === step ? "on" : ""} />
            ))}
          </div>
          <div className="tour-actions">
            {step > 0 && (
              <button type="button" className="btn btn-ghost" onClick={() => onStep(step - 1)}>
                Back
              </button>
            )}
            {!last && (
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Skip
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => (last ? onDone() : onStep(step + 1))}
            >
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Bottom-right offer to pick a tour left unfinished back up where it was. */
export function TourBanner({
  step,
  onResume,
  onDismiss,
}: {
  step: number;
  onResume: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="tour-banner">
      <button type="button" className="tour-banner-resume" onClick={onResume}>
        <span className="tour-banner-title">Continue quick tour</span>
        <span className="tour-banner-step">
          Step {step + 1} of {STEPS.length}
        </span>
      </button>
      <button
        type="button"
        className="tour-banner-close"
        aria-label="Close the tour for good"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}

/** A friendly "what to do next" box for pages that have nothing to show yet. */
export function Hint({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="hint">
      <strong>{title}</strong>
      {children}
    </div>
  );
}
