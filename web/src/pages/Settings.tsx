import { useEffect, useState } from "react";
import { api, type Settings as S } from "../api";
import { toast } from "../ui";
import { EmailCard } from "./EmailCard";
import { LinkedInCard } from "./LinkedInCard";
import { PhoneCard } from "./PhoneCard";

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function Settings({ onChange }: { onChange: () => void }) {
  const [s, setS] = useState<S>();
  const [form, setForm] = useState({
    perDay: "",
    reviewFirst: "",
    perCompany: "",
    schedule: "",
    roles: "",
    locations: "",
    never: "",
    exclude: "",
  });
  const [dryRun, setDryRun] = useState(true);

  useEffect(() => {
    api.settings().then((d) => {
      setS(d);
      const c = d.config;
      setDryRun(c.dryRun);
      setForm({
        perDay: String(c.limits.perDay),
        reviewFirst: String(c.limits.reviewFirst),
        perCompany: String(c.limits.perCompany30d),
        schedule: c.schedule.join(", "),
        roles: c.rules.roles.join(", "),
        locations: c.rules.locations.join(", "),
        never: c.rules.neverApply.join(", "),
        exclude: c.rules.excludeTitles.join(", "),
      });
    });
  }, []);

  if (!s) return <div className="skeleton" />;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    try {
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
          neverApply: list(form.never),
          excludeTitles: list(form.exclude),
        },
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
        <Field label="Skip titles containing" value={form.exclude} onChange={set("exclude")} />
        <Field
          label="Locations"
          hint="'remote' matches remote roles open in your country"
          value={form.locations}
          onChange={set("locations")}
        />
        <Field
          label="Never apply to"
          hint="e.g. your current employer"
          value={form.never}
          onChange={set("never")}
        />
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

      <section className="card">
        <h3>Setup</h3>
        <dl className="kv">
          <dt>Applying as</dt>
          <dd>
            {s.profile.name || "—"} · {s.profile.email || "no email"}
          </dd>
          <dt>AI</dt>
          <dd>
            {s.config.provider} ({s.config.auth})
          </dd>
          <dt>Browser</dt>
          <dd>{s.config.browser}</dd>
          <dt>Companies</dt>
          <dd>
            {s.config.companies.length
              ? s.config.companies.map((c) => `${c.name} (${c.ats})`).join(", ")
              : "none yet"}
          </dd>
          <dt>Data folder</dt>
          <dd>
            <code>{s.home}</code>
          </dd>
        </dl>
        <button
          type="button"
          className="btn"
          onClick={() => api.discover().then((r) => toast(`Found ${r.found} roles, queued ${r.added} new`))}
        >
          Find new jobs now
        </button>
      </section>

      <PhoneCard />

      <EmailCard />

      <LinkedInCard onChange={onChange} />
    </div>
  );
}

function Field(props: {
  label: string;
  hint?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {props.label}
        {props.hint && <span className="muted"> · {props.hint}</span>}
      </span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={props.onChange}
        inputMode={props.type === "number" ? "numeric" : undefined}
      />
    </label>
  );
}
