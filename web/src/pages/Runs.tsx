import { api } from "../api";
import { ago, Empty, usePoll } from "../ui";

export function Runs() {
  const { data } = usePoll(api.runs, 6000);
  return (
    <section className="card flush">
      {data?.length ? (
        <ul className="list table">
          {data.map((r) => (
            <li key={r.id} className="row static">
              <span className={`run-dot run-${r.status}`} />
              <div className="row-main">
                <div className="row-title">
                  Run #{r.id} · {r.summary ?? r.status}
                </div>
                <div className="row-sub">
                  {new Date(r.started_at).toLocaleString()} · {r.trigger} · {r.provider}
                  {r.dry_run ? " · dry run" : ""}
                  {r.finished_at
                    ? ` · took ${Math.max(1, Math.round((+new Date(r.finished_at) - +new Date(r.started_at)) / 1000))}s`
                    : " · running"}
                </div>
              </div>
              <span className="muted small">{ago(r.started_at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title={data ? "No runs yet" : "Loading…"}>
          Press Run now to try one. To run on its own at set times, use quietapply schedule on.
        </Empty>
      )}
    </section>
  );
}
