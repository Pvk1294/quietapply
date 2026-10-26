import { useEffect, useState } from "react";
import { api, type Settings as S } from "../api";
import { COVER_LETTER, CURRENCIES, INDUSTRIES, SENIORITY, SIZES } from "../options";
import { toast } from "../ui";
import { CompaniesEditor } from "./CompaniesEditor";
import { Input as Field, ProfileEditor } from "./ProfileEditor";

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

type Sources = { greenhouse: boolean; lever: boolean; ashby: boolean };

export function Settings({ onChange }: { onChange: () => void }) {
  const [s, setS] = useState<S>();
  const [form, setForm] = useState({
    perDay: "",
    reviewFirst: "",
    perCompany: "",
    schedule: "",
    roles: "",
    locations: "",
    countries: "",
    never: "",
    exclude: "",
    minSalary: "",
    currency: "USD",
  });
  const [dryRun, setDryRun] = useState(true);
  const [seniority, setSeniority] = useState<string[]>([]);
  const [industries, setIndustries] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [sources, setSources] = useState<Sources>({ greenhouse: true, lever: true, ashby: true });
  const [coverLetter, setCoverLetter] = useState<S["config"]["coverLetterStyle"]>("short");

  useEffect(() => {
    api.settings().then((d) => {
      setS(d);
      const c = d.config;
      setDryRun(c.dryRun);
      setSeniority(c.rules.seniority);
      setIndustries(c.preferences.industries);
      setSizes(c.preferences.sizes);
      setSources({ greenhouse: c.sources.greenhouse, lever: c.sources.lever, ashby: c.sources.ashby });
      setCoverLetter(c.coverLetterStyle);
      setForm({
        perDay: String(c.limits.perDay),
        reviewFirst: String(c.limits.reviewFirst),
        perCompany: String(c.limits.perCompany30d),
        schedule: c.schedule.join(", "),
        roles: c.rules.roles.join(", "),
        locations: c.rules.locations.join(", "),
        countries: c.rules.countries.join(", "),
        never: c.rules.neverApply.join(", "),
        exclude: c.rules.excludeTitles.join(", "),
        minSalary: c.rules.minSalary ? String(c.rules.minSalary.amount) : "",
        currency: c.rules.minSalary?.currency ?? "USD",
      });
    });
  }, []);

  if (!s) return <div className="skeleton" />;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    try {
      const min = Number(form.minSalary.replace(/,/g, ""));
      await api.saveSettings({
        dryRun,
        schedule: list(form.schedule),
        limits: {
          perDay: Number(form.perDay),
          reviewFirst: Number(form.reviewFirst),
          perCompany30d: Number(form.perCompany),
        },
        rules: {
          roles: list(form.roles),
          locations: list(form.locations),
          countries: list(form.countries),
          seniority,
          minSalary: form.minSalary && min > 0 ? { amount: min, currency: form.currency } : null,
          neverApply: list(form.never),
          excludeTitles: list(form.exclude),
        },
        sources,
        preferences: { industries, sizes },
        coverLetterStyle: coverLetter,
      });
      toast("Settings saved");
      onChange();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="stack settings">
      <section className="card">
        <h3>Safety</h3>
        <label className="switch-row">
          <div>
            <strong>Dry run</strong>
            <div className="muted small">
              Fill forms but never press Submit. Leave on until you have checked a few dry runs.
            </div>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
        </label>
        <div className="grid3">
          <Field label="Applications per day" value={form.perDay} onChange={set("perDay")} type="number" />
          <Field
            label="Review the first"
            hint="applications before Submit"
            value={form.reviewFirst}
            onChange={set("reviewFirst")}
            type="number"
          />
          <Field
            label="Per company in 30 days"
            value={form.perCompany}
            onChange={set("perCompany")}
            type="number"
          />
        </div>
      </section>

      <section className="card">
        <h3>What to apply for</h3>
        <Field label="Job titles" hint="comma separated" value={form.roles} onChange={set("roles")} />
        <Toggles
          label="Seniority"
          hint="none = any level"
          options={SENIORITY}
          value={seniority}
          onChange={setSeniority}
        />
        <Field label="Skip titles containing" value={form.exclude} onChange={set("exclude")} />
        <Field
          label="Countries"
          hint="a job in Bengaluru counts as India"
          value={form.countries}
          onChange={set("countries")}
        />
        <Field
          label="Cities"
          hint="'remote' matches remote roles"
          value={form.locations}
          onChange={set("locations")}
        />
        <div className="grid3">
          <Field
            label="Minimum yearly salary"
            hint="empty = none"
            value={form.minSalary}
            onChange={set("minSalary")}
            type="number"
          />
          <label className="field">
            <span className="field-label">Currency</span>
            <select value={form.currency} onChange={set("currency")}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <Field
          label="Never apply to"
          hint="e.g. your current employer"
          value={form.never}
          onChange={set("never")}
        />
        <Toggles
          label="Industries you like"
          options={INDUSTRIES}
          value={industries}
          onChange={setIndustries}
        />
        <Toggles label="Company sizes" options={SIZES} value={sizes} onChange={setSizes} />
      </section>

      <section className="card">
        <h3>Job sites</h3>
        <Toggles
          label="Apply on"
          hint="no login needed on any of these"
          options={[
            { id: "greenhouse", label: "Greenhouse" },
            { id: "lever", label: "Lever" },
            { id: "ashby", label: "Ashby" },
          ]}
          value={Object.entries(sources)
            .filter(([, on]) => on)
            .map(([k]) => k)}
          onChange={(v) =>
            setSources({
              greenhouse: v.includes("greenhouse"),
              lever: v.includes("lever"),
              ashby: v.includes("ashby"),
            })
          }
        />
        <label className="field">
          <span className="field-label">Cover letters</span>
          <select value={coverLetter} onChange={(e) => setCoverLetter(e.target.value as typeof coverLetter)}>
            {COVER_LETTER.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="card">
        <h3>Schedule</h3>
        <Field
          label="Run times"
          hint="24h, comma separated, e.g. 09:00, 13:00, 19:00"
          value={form.schedule}
          onChange={set("schedule")}
        />
        <p className="muted small">
          Install the timer once with <code>quietapply schedule on</code>.
        </p>
      </section>

      <div className="save-bar">
        <button type="button" className="btn btn-primary" onClick={save}>
          Save settings
        </button>
      </div>

      <CompaniesEditor initial={s.config.companies} starter={s.starter} />

      <ProfileEditor initial={s.profile} />

      <section className="card">
        <h3>Setup</h3>
        <dl className="kv">
          <dt>AI</dt>
          <dd>
            {s.config.provider} ({s.config.auth})
          </dd>
          <dt>Browser</dt>
          <dd>{s.config.browser}</dd>
          <dt>Resume</dt>
          <dd>{s.profile.resumeFile ?? "none: run quietapply init --step resume"}</dd>
          <dt>Data folder</dt>
          <dd>
            <code>{s.home}</code>
          </dd>
        </dl>
        <p className="muted small">
          Change the AI or the resume with <code>quietapply init --step ai</code> or{" "}
          <code>--step resume</code>. Standard answers (work authorisation, salary, notice period…) are in
          Memory.
        </p>
        <button
          type="button"
          className="btn"
          onClick={() => api.discover().then((r) => toast(`Found ${r.found} roles, queued ${r.added} new`))}
        >
          Find new jobs now
        </button>
      </section>

      <section className="card note-card">
        <h3>LinkedIn: {s.config.sources.linkedin ? "on" : "off"}</h3>
        <p className="muted">
          LinkedIn's User Agreement forbids bots and automated access, and LinkedIn restricts accounts that
          use them. QuietApply keeps it off. It applies on company job boards (Greenhouse, Lever, Ashby)
          instead.
        </p>
      </section>
    </div>
  );
}

function Toggles(props: {
  label: string;
  hint?: string;
  options: { id: string; label: string }[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div className="field">
      <span className="field-label">
        {props.label}
        {props.hint && <span className="muted"> · {props.hint}</span>}
      </span>
      <div className="chips wrap">
        {props.options.map((o) => {
          const on = props.value.includes(o.id);
          return (
            <button
              type="button"
              key={o.id}
              className={`chip ${on ? "active" : ""}`}
              aria-pressed={on}
              onClick={() =>
                props.onChange(on ? props.value.filter((x) => x !== o.id) : [...props.value, o.id])
              }
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
