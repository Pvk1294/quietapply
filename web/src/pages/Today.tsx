import { api, type Summary } from "../api";
import { Avatar, ago, Empty, Pill, usePoll } from "../ui";

export function Today({ summary }: { summary?: Summary }) {
  const { data: apps } = usePoll(() => api.applications(), 6000);
  const { data: questions } = usePoll(() => api.questions("open"), 6000);
  if (!summary) return <div className="skeleton" />;
  const c = summary.counts;
  const handoff = summary.handoffs.open;
  const t = summary.today;
  const recent = (apps ?? []).filter((a) => a.status !== "queued" && a.status !== "skipped").slice(0, 6);

  return (
    <div className="stack">
      <section className="hero card">
        <div>
          <div className="eyebrow">
            {greeting()}
            {summary.profileName ? `, ${summary.profileName.split(" ")[0]}` : ""}
          </div>
          <h2 className="hero-title">
            {summary.openQuestions
              ? `${summary.openQuestions} question${summary.openQuestions > 1 ? "s" : ""} waiting for you`
              : c.awaiting_review
                ? `${c.awaiting_review} application${c.awaiting_review > 1 ? "s" : ""} ready for your review`
                : "Nothing needs you right now"}
          </h2>
          <p className="today-line">
            <strong>
              {summary.dryRun ? "Filled" : "Applied"} {t.done}
            </strong>
            , couldn't do {t.couldnt}
            {t.couldnt > 0 && (
              <>
                {" "}
                (<a href="#/handoff">{t.needYou} need you</a>)
              </>
            )}
          </p>
          <p className="muted">
            Next runs at {summary.schedule.join(", ")}
            {summary.scheduleInstalled ? "" : " (schedule not installed: run quietapply schedule on)"}.
            {summary.lastRun
              ? ` Last run ${ago(summary.lastRun.started_at)}: ${summary.lastRun.summary ?? summary.lastRun.status}.`
              : ""}
          </p>
        </div>
        <Meter value={summary.submittedToday} max={summary.perDay} />
      </section>

      <section className="stats">
        <Stat href="#/questions" label="Questions for you" value={summary.openQuestions} tone="amber" />
        <Stat
          href="#/applications?status=awaiting_review"
          label="Waiting for review"
          value={c.awaiting_review}
          tone="violet"
        />
        <Stat href="#/applications?status=submitted" label="Applied" value={c.submitted} tone="green" />
        <Stat
          href="#/handoff"
          label="Finish yourself"
          value={summary.handoffs.needYou || handoff}
          tone="red"
        />
      </section>

      {summary.reviewMode && (
        <div className="note">
          <strong>Review mode.</strong> Your first {summary.reviewFirst} applications stop before Submit and
          wait for your OK, so you can check how the agent fills forms.
        </div>
      )}

      <div className="two-col">
        <section className="card">
          <div className="card-head">
            <h3>Waiting on you</h3>
            <a href="#/questions">All questions</a>
          </div>
          {questions?.length ? (
            <ul className="list">
              {questions.slice(0, 4).map((q) => (
                <li key={q.id}>
                  <a className="row" href="#/questions">
                    <div className="row-main">
                      <div className="row-title">{q.question}</div>
                      <div className="row-sub">
                        {q.applications.map((a) => a.company).join(", ") || q.context}
                      </div>
                    </div>
                    <span className="chev">›</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No questions">
              The agent asks here when a form needs something it does not know.
            </Empty>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Recent activity</h3>
            <a href="#/applications">All applications</a>
          </div>
          {recent.length ? (
            <ul className="list">
              {recent.map((a) => (
                <li key={a.id}>
                  <a className="row" href={`#/applications?open=${a.id}`}>
                    <Avatar name={a.company} />
                    <div className="row-main">
                      <div className="row-title">{a.title}</div>
                      <div className="row-sub">
                        {a.company} · {ago(a.updated_at)}
                      </div>
                    </div>
                    <Pill status={a.status} />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No activity yet">Add companies in Settings, then press Run now.</Empty>
          )}
        </section>
      </div>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Stat({ href, label, value, tone }: { href: string; label: string; value: number; tone: string }) {
  return (
    <a className={`stat stat-${tone}`} href={href}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </a>
  );
}

function Meter({ value, max }: { value: number; max: number }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const r = 34;
  const len = 2 * Math.PI * r;
  return (
    <div className="meter" role="img" aria-label={`${value} of ${max} applications today`}>
      <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
        <circle cx="48" cy="48" r={r} className="meter-track" />
        <circle
          cx="48"
          cy="48"
          r={r}
          className="meter-fill"
          strokeDasharray={len}
          strokeDashoffset={len - (len * pct) / 100}
          transform="rotate(-90 48 48)"
        />
      </svg>
      <div className="meter-label">
        <strong>{value}</strong>
        <span>of {max} today</span>
      </div>
    </div>
  );
}
