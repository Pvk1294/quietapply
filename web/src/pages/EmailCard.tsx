import { useState } from "react";
import { api, type EmailInfo } from "../api";
import { toast, usePoll } from "../ui";

/**
 * Settings → Email applications: off unless you say yes. Your address, the mail server, an app password
 * (kept in the keychain, never shown again), the daily cap and the do-not-contact list.
 */
export function EmailCard() {
  const { data, reload } = usePoll(api.email, 15000);
  const [asking, setAsking] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [password, setPassword] = useState("");
  if (!data) return <section className="card note-card skeleton" />;
  const i: EmailInfo = data;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      setAsking(false);
      setForm({});
      setPassword("");
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const val = (k: string, fallback: string | number) => form[k] ?? String(fallback);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <section className="card note-card" id="email">
      <h3>Email applications: {i.enabled ? "on" : "off"}</h3>
      {!i.enabled && !asking && (
        <>
          <p className="muted">
            Some postings ask you to send your resume by email. While this is off, QuietApply sends no mail at
            all: those jobs go to Finish yourself with the email text ready to copy.
            {i.declinedAt && ` You said no on ${new Date(i.declinedAt).toLocaleDateString()}.`}
          </p>
          <button type="button" className="btn" onClick={() => setAsking(true)}>
            Set up email applications…
          </button>
        </>
      )}
      {!i.enabled && asking && (
        <div className="risk-box">
          <strong>{i.question}</strong>
          <ul>
            {i.risk.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="linkedin-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                run(() => api.saveEmail({ enabled: true, accept: true }), "Email applications are on")
              }
            >
              Yes, it may send them
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => run(() => api.saveEmail({ decline: true }), "Left off. No mail is ever sent")}
            >
              No
            </button>
          </div>
        </div>
      )}
      {i.enabled && (
        <>
          <p className="muted">
            You said yes on {i.acceptedAt ? new Date(i.acceptedAt).toLocaleString() : "an earlier date"}. Sent
            today: {i.sentToday} of {i.perDay}.
            {i.reviewLeft > 0 && ` The next ${i.reviewLeft} wait for your OK on the Applications page.`}
          </p>
          <div className="grid3">
            <label className="field">
              <span className="field-label">Your address</span>
              <input
                type="email"
                value={val("from", i.from)}
                onChange={set("from")}
                placeholder="you@gmail.com"
              />
            </label>
            <label className="field">
              <span className="field-label">Mail server (SMTP)</span>
              <input value={val("host", i.smtp.host)} onChange={set("host")} placeholder="smtp.gmail.com" />
            </label>
            <label className="field">
              <span className="field-label">Port</span>
              <input inputMode="numeric" value={val("port", i.smtp.port)} onChange={set("port")} />
            </label>
            <label className="field">
              <span className="field-label">Login</span>
              <input value={val("user", i.smtp.user)} onChange={set("user")} />
            </label>
            <label className="field">
              <span className="field-label">
                Emails per day <span className="muted">· 1 to 50</span>
              </span>
              <input inputMode="numeric" value={val("perDay", i.perDay)} onChange={set("perDay")} />
            </label>
          </div>
          <label className="field">
            <span className="field-label">
              Do not contact{" "}
              <span className="muted">· one per line: an address, a domain, a LinkedIn link or a name</span>
            </span>
            <textarea rows={3} value={val("dnc", i.doNotContact.join("\n"))} onChange={set("dnc")} />
          </label>
          <div className="linkedin-row">
            <button
              type="button"
              className="btn"
              disabled={!Object.keys(form).length}
              onClick={() =>
                run(
                  () =>
                    api.saveEmail({
                      ...(form.from !== undefined && { from: form.from }),
                      ...(form.host !== undefined && { host: form.host }),
                      ...(form.port !== undefined && {
                        port: Number(form.port),
                        secure: Number(form.port) === 465,
                      }),
                      ...(form.user !== undefined && { user: form.user }),
                      ...(form.perDay !== undefined && { perDay: Number(form.perDay) }),
                      ...(form.dnc !== undefined && { doNotContact: form.dnc.split("\n") }),
                    }),
                  "Saved",
                )
              }
            >
              Save
            </button>
          </div>
          <label className="field">
            <span className="field-label">
              App password{" "}
              <span className="muted">
                · {i.hasPassword ? "stored in your keychain or a private file" : "not set yet"}. Make one in
                your mail account's security settings (for Gmail: App passwords). Never your normal password.
              </span>
            </span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={i.hasPassword ? "••••••••" : "paste the app password"}
            />
          </label>
          <div className="linkedin-row">
            <button
              type="button"
              className="btn"
              disabled={password.length < 4}
              onClick={() => run(() => api.setEmailPassword(password), "App password stored")}
            >
              Store password
            </button>
            {i.hasPassword && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => run(api.forgetEmailPassword, "App password removed")}
              >
                Remove password
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost danger"
              onClick={() => run(() => api.saveEmail({ enabled: false }), "Email applications are off")}
            >
              Turn off
            </button>
          </div>
          <p className="muted small">
            Each email is short and plain, written from your profile and saved answers only, with your resume
            attached. Nothing is sent while dry run is on.
          </p>
        </>
      )}
    </section>
  );
}
