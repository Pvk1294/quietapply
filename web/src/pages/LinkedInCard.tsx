import { useState } from "react";
import { api, type LinkedInInfo } from "../api";
import { toast, usePoll } from "../ui";

/** Settings → LinkedIn mode: off by default, a plain risk statement, and the small daily cap. */
export function LinkedInCard({ onChange }: { onChange: () => void }) {
  const { data, reload } = usePoll(api.linkedin, 8000);
  const [accept, setAccept] = useState(false);
  const [asking, setAsking] = useState(false);
  const [cap, setCap] = useState<string>();
  if (!data) return <section className="card note-card skeleton" />;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      setAsking(false);
      setAccept(false);
      reload();
      onChange();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const i: LinkedInInfo = data;
  return (
    <section className="card note-card" id="linkedin">
      <h3>LinkedIn mode: {i.enabled ? "on" : "off"}</h3>
      {!i.enabled && !asking && (
        <>
          <p className="muted">
            Optional, and off unless you choose it. QuietApply can apply to LinkedIn jobs (Easy Apply too) in
            your own logged-in Chrome, slowly and a few a day. Greenhouse, Lever and Ashby work without it.
          </p>
          <button type="button" className="btn" onClick={() => setAsking(true)}>
            Set up LinkedIn mode…
          </button>
        </>
      )}
      {!i.enabled && asking && (
        <div className="risk-box">
          <strong>Please read this before you turn it on</strong>
          <ul>
            {i.risk.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="small">
            It needs Claude Code with a Claude plan and the Claude in Chrome extension, signed in to LinkedIn
            in that Chrome. It uses at most {i.maxPerDay} applications a day (5 to begin with) and stops at
            the first warning, limit message or CAPTCHA.
          </p>
          {i.setupProblem && <p className="small">{i.setupProblem}</p>}
          <label className="switch-row">
            <span>I have read this and I accept the risk to my LinkedIn account.</span>
            <input
              type="checkbox"
              className="switch"
              checked={accept}
              onChange={(e) => setAccept(e.target.checked)}
            />
          </label>
          <div className="linkedin-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!accept}
              onClick={() =>
                run(() => api.saveLinkedIn({ enabled: true, acceptRisk: true }), "LinkedIn mode is on")
              }
            >
              Turn on LinkedIn mode
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {i.enabled && (
        <>
          <p className="muted">
            You accepted the risk on{" "}
            {i.acceptedAt ? new Date(i.acceptedAt).toLocaleString() : "an earlier date"}. Used today:{" "}
            {i.usedToday} of {i.perDay}.
          </p>
          {i.stopped && (
            <div className="banner banner-red">
              <strong>Stopped.</strong> LinkedIn showed a warning ({i.stopped.reason}). Look at your LinkedIn
              account in the browser first. Then resume.{" "}
              <button
                type="button"
                className="help-link"
                onClick={() => run(api.resumeLinkedIn, "LinkedIn mode resumed")}
              >
                Resume LinkedIn
              </button>
            </div>
          )}
          <div className="linkedin-row">
            <label className="field">
              <span className="field-label">
                Applications per day <span className="muted">· 1 to {i.maxPerDay}</span>
              </span>
              <input
                type="number"
                min={1}
                max={i.maxPerDay}
                value={cap ?? String(i.perDay)}
                onChange={(e) => setCap(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn"
              disabled={cap === undefined}
              onClick={() => run(() => api.saveLinkedIn({ perDay: Number(cap) }), "Saved")}
            >
              Save cap
            </button>
            <button
              type="button"
              className="btn btn-ghost danger"
              onClick={() => run(() => api.saveLinkedIn({ enabled: false }), "LinkedIn mode is off")}
            >
              Turn off
            </button>
          </div>
          <p className="muted small">
            Add a LinkedIn job on the Applications page by pasting its link. Jobs that lead to a company site
            on Greenhouse, Lever or Ashby continue with the normal flow.
          </p>
        </>
      )}
    </section>
  );
}
