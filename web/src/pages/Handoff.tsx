import { useState } from "react";
import { api, type HandoffReason, type Handoff as HandoffRecord } from "../api";
import { Icon } from "../icons";
import { Avatar, ago, copyText, Empty, toast, usePoll } from "../ui";

/** Order of the groups: things that need a person first, rules and limits last. */
const ORDER: HandoffReason[] = [
  "captcha",
  "login_required",
  "unknown_question",
  "file_upload",
  "external_redirect",
  "unsupported_ats",
  "linkedin_limit",
  "unclear_submit",
  "other",
  "form_error",
  "cap",
  "fit_gate",
];

export function Handoff() {
  const { data, reload } = usePoll(api.handoffs, 8000);
  const groups = new Map<HandoffReason, HandoffRecord[]>();
  for (const h of data ?? []) groups.set(h.reason, [...(groups.get(h.reason) ?? []), h]);
  const ordered = ORDER.filter((r) => groups.has(r));

  return (
    <div className="stack">
      <p className="lead muted">
        Every job QuietApply skipped or stopped on, with the reason. Open the job, copy what you need, and
        finish it yourself, or tell it to leave the job alone. Entries marked <em>Unclear</em> may already be
        sent: look at the site before doing anything.
      </p>
      {ordered.length === 0 && (
        <section className="card">
          <Empty title={data ? "Nothing to finish" : "Loading…"} />
        </section>
      )}
      {ordered.map((reason) => {
        const items = groups.get(reason)!;
        return (
          <section className="card flush" key={reason}>
            <div className="card-head pad">
              <h3>{items[0]!.label}</h3>
              <span className="chip-n">{items.length}</span>
            </div>
            <p className="group-help muted">{items[0]!.help}</p>
            <ul className="list table">
              {items.map((h) => (
                <Entry key={h.id} h={h} reload={reload} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Entry({ h, reload }: { h: HandoffRecord; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const a = h.application;
  const act = async (action: "applied" | "not_interested" | "retry", ok: string) => {
    setBusy(true);
    try {
      await api.handoffAct(h.id, action);
      toast(ok);
      reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Values already typed come first; your own details follow, minus anything listed twice.
  const seen = new Set(h.filled.map((f) => f.value));
  const mine = h.mine.filter((m) => !seen.has(m.value));

  return (
    <li className="handoff">
      <div className="row static">
        <Avatar name={a.company} />
        <div className="row-main">
          <div className="row-title">{a.title}</div>
          <div className="row-sub">
            {a.company} · {ago(h.created_at)}
          </div>
        </div>
        <div className="row-meta">
          <a className="btn btn-ghost btn-sm" href={a.url} target="_blank" rel="noreferrer noopener">
            Open job <Icon.external />
          </a>
        </div>
      </div>
      <div className="handoff-body">
        <p className="handoff-detail">{h.detail}</p>
        {h.rule && (
          <p className="muted">
            Rule that hit: <code>{h.rule}</code>
          </p>
        )}
        <p className="handoff-needed">
          <strong>What is needed:</strong> {h.needed}
        </p>
        {h.questions.length > 0 && (
          <p>
            Open questions: {h.questions.join(" · ")} <a href="#/questions">Answer them</a>
          </p>
        )}

        <button type="button" className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : "Show"} the answers to copy ({h.filled.length + mine.length})
        </button>
        {open && (
          <div className="copy-grid">
            {[...h.filled.map((f) => ({ label: f.field, value: f.value })), ...mine].map((c) => (
              <CopyRow key={`${c.label}=${c.value}`} label={c.label} value={c.value} />
            ))}
            {h.filled.length + mine.length === 0 && <span className="muted">Nothing filled in yet.</span>}
          </div>
        )}

        <div className="handoff-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => act("applied", "Marked as applied by you")}
          >
            I applied myself
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => act("not_interested", "Left alone")}
          >
            Not interested
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy || !h.canRetry}
            title={h.retryBlocker ?? "Queue it for the next run"}
            onClick={() => act("retry", "Queued again")}
          >
            Retry
          </button>
        </div>
        {!h.canRetry && h.retryBlocker && <p className="muted small">Retry: {h.retryBlocker}</p>}
      </div>
    </li>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-row">
      <div className="copy-text">
        <span className="copy-label">{label}</span>
        <span className="copy-value">{value}</span>
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={async () => {
          if (await copyText(value)) {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          } else toast("Could not copy; select the text instead");
        }}
      >
        {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
