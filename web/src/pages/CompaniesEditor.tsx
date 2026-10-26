import { useEffect, useState } from "react";
import { api, type Company, type Suggestion } from "../api";
import { toast } from "../ui";

/** The watch list: remove companies, add one by careers URL, or add matches from the starter list. */
export function CompaniesEditor({ initial, starter }: { initial: Company[]; starter: number }) {
  const [companies, setCompanies] = useState(initial);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>();

  useEffect(() => {
    api.suggestions().then(setSuggestions, () => setSuggestions([]));
  }, []);

  const add = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await api.addCompanyUrl(url.trim());
      setCompanies(r.companies);
      setUrl("");
      toast(`Added ${r.added.name} (${r.jobs} open jobs)`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (c: Company) => setCompanies((await api.removeCompany(c)).companies);
  const addSuggested = async (ids: string[]) => {
    const r = await api.addSuggested(ids);
    setCompanies(r.companies);
    setSuggestions((s) => s?.filter((x) => !ids.includes(`${x.ats}:${x.token}`)));
    toast(`Watching ${r.companies.length} companies`);
  };

  return (
    <section className="card">
      <h3>Companies ({companies.length})</h3>
      <p className="muted small">
        QuietApply checks these companies' public job boards for roles that fit your rules. No board tokens
        needed: paste any careers-page link.
      </p>
      <div className="company-list">
        {companies.map((c) => (
          <span className="tag" key={`${c.ats}:${c.token}`} title={`${c.ats}: ${c.token}`}>
            {c.name}
            <button type="button" aria-label={`Remove ${c.name}`} onClick={() => remove(c)}>
              ×
            </button>
          </span>
        ))}
        {!companies.length && <span className="muted small">None yet.</span>}
      </div>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          placeholder="https://jobs.lever.co/acme or https://acme.com/careers"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Careers page URL"
        />
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Checking…" : "Add"}
        </button>
      </form>
      {suggestions && suggestions.length > 0 && (
        <div className="field">
          <span className="field-label">
            Suggested from the starter list <span className="muted">· {starter} checked companies</span>
          </span>
          <div className="company-list">
            {suggestions.slice(0, 24).map((s) => (
              <button
                type="button"
                className="chip"
                key={`${s.ats}:${s.token}`}
                title={`${s.jobs} open · ${s.why.join(", ")}`}
                onClick={() => addSuggested([`${s.ats}:${s.token}`])}
              >
                + {s.name}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => addSuggested(suggestions.slice(0, 24).map((s) => `${s.ats}:${s.token}`))}
          >
            Add all {Math.min(24, suggestions.length)}
          </button>
        </div>
      )}
    </section>
  );
}
