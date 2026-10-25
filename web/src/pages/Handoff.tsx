import { api } from "../api";
import { Icon } from "../icons";
import { Avatar, ago, BLOCKED_LABEL, Empty, toast, usePoll } from "../ui";

export function Handoff() {
  const { data, reload } = usePoll(() => api.applications("blocked,unclear"), 8000);
  const groups = new Map<string, NonNullable<typeof data>>();
  for (const a of data ?? []) {
    const key = a.status === "unclear" ? "unclear" : (a.blocked_category ?? "other");
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }

  return (
    <div className="stack">
      <p className="lead muted">
        Things only you should do: CAPTCHAs, video answers, tests, email-only postings, accounts. The agent
        left the form filled where it could. Entries marked <em>Check</em> may already be submitted: look at
        the site before trying again.
      </p>
      {groups.size === 0 && (
        <section className="card">
          <Empty title={data ? "Nothing to finish" : "Loading…"} />
        </section>
      )}
      {[...groups.entries()].map(([key, apps]) => (
        <section className="card flush" key={key}>
          <div className="card-head pad">
            <h3>{key === "unclear" ? "Check whether it went through" : (BLOCKED_LABEL[key] ?? key)}</h3>
            <span className="chip-n">{apps.length}</span>
          </div>
          <ul className="list table">
            {apps.map((a) => (
              <li key={a.id} className="row static">
                <Avatar name={a.company} />
                <div className="row-main">
                  <div className="row-title">{a.title}</div>
                  <div className="row-sub">
                    {a.company} · {ago(a.updated_at)}
                    {a.reason ? ` · ${a.reason}` : ""}
                  </div>
                </div>
                <div className="row-meta">
                  <a className="btn btn-ghost btn-sm" href={a.url} target="_blank" rel="noreferrer noopener">
                    Open <Icon.external />
                  </a>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      api.act(a.id, "dismiss").then(() => {
                        toast("Marked done");
                        reload();
                      })
                    }
                  >
                    Done
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
