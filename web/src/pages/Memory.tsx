import { useMemo, useState } from "react";
import { type Answer, api } from "../api";
import { Icon } from "../icons";
import { ago, Empty, toast, usePoll } from "../ui";

export function Memory() {
  const { data, reload } = usePoll(api.memory, 15000);
  const [search, setSearch] = useState("");
  const shown = useMemo(() => {
    const s = search.toLowerCase();
    return (data ?? []).filter(
      (a) => !s || `${a.question} ${a.answer} ${a.aliases.join(" ")}`.toLowerCase().includes(s),
    );
  }, [data, search]);

  return (
    <div className="stack">
      <div className="toolbar">
        <p className="lead muted grow">
          Your stored answers. The agent gets only the ones that match the form in front of it, and must cite
          one for every value it types.
        </p>
        <label className="search">
          <Icon.search />
          <input placeholder="Search answers" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>
      <section className="card flush">
        {shown.length ? (
          <ul className="list table">
            {shown.map((a) => (
              <MemoryRow key={a.id} a={a} onChange={reload} />
            ))}
          </ul>
        ) : (
          <Empty title={data ? "No answers yet" : "Loading…"}>
            Answers you give in Questions or during setup appear here.
          </Empty>
        )}
      </section>
    </div>
  );
}

function MemoryRow({ a, onChange }: { a: Answer; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(a.answer);
  const [reveal, setReveal] = useState(!a.sensitive);
  const save = async () => {
    try {
      await api.updateMemory(a.id, value);
      toast("Saved");
      setEditing(false);
      onChange();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <li className="row static memory">
      <div className="row-main">
        <div className="row-title">
          {a.question}
          {a.scope !== "global" && <span className="tag tag-sm">only {a.scope_value}</span>}
          {a.sensitive && <span className="tag tag-sm tag-amber">private</span>}
        </div>
        {editing ? (
          <div className="inline-edit">
            <textarea
              rows={Math.min(6, Math.max(2, Math.ceil(value.length / 60)))}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <div className="q-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setEditing(false);
                  setValue(a.answer);
                }}
              >
                Cancel
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={save}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="answer-text"
            onClick={() => (reveal ? setEditing(true) : setReveal(true))}
          >
            {reveal ? a.answer : "•••••• (tap to show)"}
          </button>
        )}
        <div className="row-sub">
          mem:{a.id} · from {a.source} · used {a.uses}× · {ago(a.updated_at)}
        </div>
      </div>
      {!editing && (
        <div className="row-meta">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm danger"
            onClick={() =>
              api.deleteMemory(a.id).then(() => {
                toast("Deleted");
                onChange();
              })
            }
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
}
