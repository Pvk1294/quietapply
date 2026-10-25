import { useState } from "react";
import { api, type Question } from "../api";
import { ago, Empty, toast, usePoll } from "../ui";

export function Questions({ onChange }: { onChange: () => void }) {
  const { data: open, reload } = usePoll(() => api.questions("open"), 5000);
  const { data: answered, reload: reloadAnswered } = usePoll(() => api.questions("answered"), 15000);
  const done = () => {
    reload();
    reloadAnswered();
    onChange();
  };

  return (
    <div className="stack">
      <p className="lead muted">
        The agent never guesses. When a form asks something it does not know, the application waits here.
        Answer once; it is saved to your memory and reused on every form that asks the same thing.
      </p>
      {open?.length ? (
        <div className="cards">
          {open.map((q) => (
            <QuestionCard key={q.id} q={q} onDone={done} />
          ))}
        </div>
      ) : (
        <section className="card">
          <Empty title={open ? "All caught up" : "Loading…"}>{open ? "No questions are waiting." : ""}</Empty>
        </section>
      )}

      {answered && answered.length > 0 && (
        <details className="card answered">
          <summary>
            Answered recently <span className="chip-n">{answered.length}</span>
          </summary>
          <ul className="list">
            {answered.slice(0, 30).map((q) => (
              <li key={q.id} className="row static">
                <div className="row-main">
                  <div className="row-title">{q.question}</div>
                  <div className="row-sub">
                    {q.answer} · {ago(q.answered_at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function QuestionCard({ q, onDone }: { q: Question; onDone: () => void }) {
  const [answer, setAnswer] = useState("");
  const [scope, setScope] = useState<"global" | "company">("global");
  const [busy, setBusy] = useState(false);
  const company = q.applications[0]?.company;
  const long = q.field_type === "long";

  const save = async () => {
    if (!answer.trim()) return;
    setBusy(true);
    try {
      const r = await api.answer(q.id, answer.trim(), scope);
      toast(
        r.released.length
          ? `Saved. ${r.released.length} application${r.released.length > 1 ? "s" : ""} will continue next run.`
          : "Saved to memory",
      );
      onDone();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card question">
      <div className="q-context">
        {q.applications.length ? (
          q.applications.map((a) => (
            <span key={a.id} className="tag">
              {a.company} · {a.title}
            </span>
          ))
        ) : (
          <span className="tag">{q.context}</span>
        )}
        <span className="muted small">{ago(q.created_at)}</span>
      </div>
      <h3 className="q-text">{q.question}</h3>
      {q.options.length > 0 && (
        <div className="options">
          {q.options.map((o) => (
            <button
              type="button"
              key={o}
              className={`option ${answer === o ? "active" : ""}`}
              onClick={() => setAnswer(o)}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      {long ? (
        <textarea
          rows={4}
          placeholder="Your answer"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
      ) : (
        <input
          placeholder={q.options.length ? "Pick an option or type an answer" : "Your answer"}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
      )}
      <div className="q-foot">
        <div className="segmented">
          <button
            type="button"
            aria-pressed={scope === "global"}
            className={scope === "global" ? "on" : ""}
            onClick={() => setScope("global")}
          >
            Remember for all
          </button>
          {company && (
            <button
              type="button"
              aria-pressed={scope === "company"}
              className={scope === "company" ? "on" : ""}
              onClick={() => setScope("company")}
            >
              Only {company}
            </button>
          )}
        </div>
        <div className="q-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => api.dismissQuestion(q.id).then(onDone)}
          >
            Skip
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !answer.trim()} onClick={save}>
            Save answer
          </button>
        </div>
      </div>
    </article>
  );
}
