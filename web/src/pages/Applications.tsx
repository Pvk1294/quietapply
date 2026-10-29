import { useEffect, useMemo, useState } from "react";
import { type AppDetail, type AppStatus, api } from "../api";
import { Icon } from "../icons";
import { Avatar, ago, BLOCKED_LABEL, Empty, Pill, STATUS, toast, usePoll } from "../ui";
import { AddJob } from "./AddJob";

const FILTERS: { id: string; label: string; statuses?: AppStatus[] }[] = [
  { id: "all", label: "All" },
  { id: "review", label: "Review", statuses: ["awaiting_review"] },
  { id: "waiting", label: "Needs you", statuses: ["needs_answers"] },
  { id: "applied", label: "Applied", statuses: ["submitted"] },
  { id: "dry", label: "Dry runs", statuses: ["dry_run"] },
  { id: "queued", label: "Queued", statuses: ["queued", "in_progress"] },
  { id: "problems", label: "Problems", statuses: ["failed", "unclear", "blocked"] },
  { id: "skipped", label: "Skipped", statuses: ["skipped"] },
];

export function Applications({ query }: { query: string }) {
  const params = new URLSearchParams(query);
  const initial = FILTERS.find((f) => f.statuses?.includes(params.get("status") as AppStatus))?.id ?? "all";
  const [filter, setFilter] = useState(initial);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<number | null>(params.get("open") ? Number(params.get("open")) : null);
  const { data, reload } = usePoll(() => api.applications(), 5000);

  useEffect(() => setFilter(initial), [initial]);
  const openParam = params.get("open");
  useEffect(() => {
    if (openParam) setOpen(Number(openParam));
  }, [openParam]);

  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter);
    const s = search.trim().toLowerCase();
    return (data ?? []).filter(
      (a) =>
        (!f?.statuses || f.statuses.includes(a.status)) &&
        (!s || `${a.company} ${a.title}`.toLowerCase().includes(s)),
    );
  }, [data, filter, search]);

  return (
    <div className="stack">
      <AddJob onAdded={reload} />
      <div className="toolbar">
        <div className="chips" role="tablist">
          {FILTERS.map((f) => {
            const n = f.statuses
              ? (data ?? []).filter((a) => f.statuses!.includes(a.status)).length
              : (data ?? []).length;
            return (
              <button
                type="button"
                key={f.id}
                role="tab"
                aria-selected={filter === f.id}
                className={`chip ${filter === f.id ? "active" : ""}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
                <span className="chip-n">{n}</span>
              </button>
            );
          })}
        </div>
        <label className="search">
          <Icon.search />
          <input
            placeholder="Search company or role"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>

      <section className="card flush">
        {shown.length ? (
          <ul className="list table">
            {shown.map((a) => (
              <li key={a.id}>
                <button type="button" className="row" onClick={() => setOpen(a.id)}>
                  <Avatar name={a.company} />
                  <div className="row-main">
                    <div className="row-title">{a.title}</div>
                    <div className="row-sub">
                      {a.company}
                      {a.location ? ` · ${a.location}` : ""} · <span className="ats">{a.ats}</span>
                    </div>
                  </div>
                  <div className="row-meta">
                    <Pill status={a.status} />
                    <span className="muted small">{ago(a.updated_at)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={data?.length ? "Nothing here" : "No applications yet"}>
            {!data
              ? "Loading…"
              : data.length
                ? "No applications match this filter."
                : "Nothing to show yet. Add companies with quietapply init (or paste a job link above), then press Run now. While dry run is on, every filled-in form shows up here so you can check it."}
          </Empty>
        )}
      </section>
      {open !== null && <Detail id={open} onClose={() => setOpen(null)} onChange={reload} />}
    </div>
  );
}

function Detail({ id, onClose, onChange }: { id: number; onClose: () => void; onChange: () => void }) {
  const [app, setApp] = useState<AppDetail>();
  const load = () =>
    api
      .application(id)
      .then(setApp)
      .catch((e: Error) => toast(e.message));
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per id
  useEffect(() => {
    load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id]);

  const act = async (action: "approve" | "requeue" | "dismiss", msg: string) => {
    try {
      await api.act(id, action, action === "approve" ? (app?.contentHash ?? undefined) : undefined);
      toast(msg);
      onChange();
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const evidence = app?.evidence
    ? (safeJson(app.evidence) as {
        filled?: { field: string; value: string; source: string }[];
        partial?: boolean;
        email?: { to: string; subject: string; body: string; attachment: string | null };
      })
    : undefined;
  const messageAct = async (id: number, action: "approve" | "dismiss", hash: string, msg: string) => {
    try {
      await api.messageAct(id, action, hash);
      toast(msg);
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const filled = evidence?.filled;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the sheet; Escape is handled above
    <div className="sheet-backdrop" onClick={onClose} onKeyDown={() => {}} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Application"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
      >
        <div className="sheet-grip" />
        {!app ? (
          <div className="skeleton" />
        ) : (
          <>
            <div className="sheet-head">
              <Avatar name={app.company} />
              <div className="row-main">
                <h2>{app.title}</h2>
                <div className="muted">
                  {app.company}
                  {app.location ? ` · ${app.location}` : ""}
                </div>
              </div>
              <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
                <Icon.close />
              </button>
            </div>
            <div className="sheet-status">
              <Pill status={app.status} />
              {app.blocked_category && (
                <span className="muted">{BLOCKED_LABEL[app.blocked_category] ?? app.blocked_category}</span>
              )}
              {app.reason && <p className="reason">{app.reason}</p>}
            </div>

            <div className="sheet-actions">
              {app.status === "awaiting_review" && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => act("approve", "Approved: it will be submitted in the next run")}
                >
                  <Icon.check /> Approve and submit next run
                </button>
              )}
              {["failed", "blocked", "skipped", "dry_run"].includes(app.status) && (
                <button type="button" className="btn" onClick={() => act("requeue", "Queued again")}>
                  Try again
                </button>
              )}
              {!["submitted", "skipped"].includes(app.status) && (
                <button type="button" className="btn btn-ghost" onClick={() => act("dismiss", "Dismissed")}>
                  Dismiss
                </button>
              )}
              <a className="btn btn-ghost" href={app.url} target="_blank" rel="noreferrer noopener">
                Open posting <Icon.external />
              </a>
            </div>

            {app.questions.length > 0 && (
              <div className="note">
                Waiting on {app.questions.length} answer{app.questions.length > 1 ? "s" : ""}:{" "}
                <a href="#/questions">answer in Questions</a>.
              </div>
            )}

            {evidence?.email && (
              <>
                <h3 className="section-title">
                  {app.status === "awaiting_review"
                    ? "The email, exactly as it would be sent"
                    : app.status === "submitted"
                      ? "The email that was sent"
                      : "The email"}
                </h3>
                <dl className="filled">
                  <div>
                    <dt>To</dt>
                    <dd>{evidence.email.to}</dd>
                  </div>
                  <div>
                    <dt>Subject</dt>
                    <dd>{evidence.email.subject}</dd>
                  </div>
                  <div>
                    <dt>Attached</dt>
                    <dd>{evidence.email.attachment ?? "nothing"}</dd>
                  </div>
                </dl>
                <pre className="email-body">{evidence.email.body}</pre>
                {app.emails
                  .filter((e) => e.message_id)
                  .map((e) => (
                    <p key={e.id} className="muted small">
                      Sent {e.sent_at ? new Date(e.sent_at).toLocaleString() : ""} · Message-ID {e.message_id}
                    </p>
                  ))}
              </>
            )}

            {app.messages.length > 0 && (
              <>
                <h3 className="section-title">Message to the hiring team</h3>
                {app.messages.map((m) => (
                  <div key={m.id} className="note">
                    <strong>{m.recipient_name}</strong>{" "}
                    <span className="muted small">
                      · {MESSAGE_STATUS[m.status]}
                      {m.note ? ` · ${m.note}` : ""}
                    </span>
                    <p>{m.text}</p>
                    {m.status === "awaiting_review" && (
                      <div className="linkedin-row">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() =>
                            messageAct(m.id, "approve", m.hash, "Approved: sent in the next run")
                          }
                        >
                          <Icon.check /> Approve this message
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => messageAct(m.id, "dismiss", m.hash, "Dismissed. It is never sent")}
                        >
                          Do not send
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}

            {filled?.length ? (
              <>
                <h3 className="section-title">
                  {evidence?.partial ? "Filled so far (waiting on your answers)" : "What the agent filled in"}
                </h3>
                <dl className="filled">
                  {filled.map((f) => (
                    <div key={f.field}>
                      <dt>{f.field}</dt>
                      <dd>
                        {f.value}
                        <span className="source">{f.source}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : null}

            {app.screenshots.length > 0 && (
              <>
                <h3 className="section-title">
                  What the agent saw
                  {app.screenshots.length > 1 ? ` (${app.screenshots.length} screenshots)` : ""}
                </h3>
                <div className="shots">
                  {app.screenshots.map((s) => (
                    <figure key={s.url} className="shot">
                      <a href={s.url} target="_blank" rel="noreferrer noopener" title="Open full size">
                        <img src={s.url} alt={`Form screenshot from run ${s.run}`} loading="lazy" />
                      </a>
                      <figcaption className="muted small">
                        Run {s.run} · {new Date(s.at).toLocaleString()}
                        {s.blockedRequests > 0 &&
                          ` · dry run blocked ${s.blockedRequests} request${s.blockedRequests > 1 ? "s" : ""}`}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </>
            )}

            <h3 className="section-title">History</h3>
            <ol className="timeline">
              {app.events
                .slice()
                .reverse()
                .map((e) => (
                  <li key={`${e.at}-${e.status}-${e.note ?? ""}`}>
                    <span className="tl-dot" />
                    <div>
                      <strong>{STATUS[e.status as AppStatus]?.label ?? e.status}</strong>
                      <span className="muted small"> · {new Date(e.at).toLocaleString()}</span>
                      {e.note && <div className="muted small">{e.note}</div>}
                    </div>
                  </li>
                ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}

const MESSAGE_STATUS: Record<string, string> = {
  dry_run: "dry run draft, never sent",
  awaiting_review: "waits for your OK",
  approved: "approved, goes out in the next run",
  sending: "being sent",
  sent: "sent",
  failed: "not sent",
  refused: "not sent",
};

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
