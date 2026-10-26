import { useState } from "react";
import { api, type Profile } from "../api";
import { toast } from "../ui";

type Exp = Profile["experience"][number];
type Edu = Profile["education"][number];

/** The profile the agent fills forms from: contact, links, work history, education, skills. */
export function ProfileEditor({ initial }: { initial: Profile }) {
  const [p, setP] = useState<Profile>(initial);
  const [skills, setSkills] = useState(initial.skills.map((s) => s.name).join(", "));
  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setP({ ...p, [k]: e.target.value });
  const setLink = (k: "linkedin" | "github" | "portfolio") => (e: React.ChangeEvent<HTMLInputElement>) =>
    setP({ ...p, links: { ...p.links, [k]: e.target.value || undefined } });
  const setExp = (i: number, k: keyof Exp, v: string) =>
    setP({ ...p, experience: p.experience.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  const setEdu = (i: number, k: keyof Edu, v: string) =>
    setP({ ...p, education: p.education.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });

  const save = async () => {
    try {
      const names = skills
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const old = new Map(p.skills.map((s) => [s.name.toLowerCase(), s]));
      const body: Profile = {
        ...p,
        totalYears:
          p.totalYears === undefined || String(p.totalYears) === "" ? undefined : Number(p.totalYears),
        skills: names.map((name) => ({ ...old.get(name.toLowerCase()), name })),
        experience: p.experience.filter((x) => x.company || x.title),
        education: p.education.filter((x) => x.school),
      };
      const r = await api.saveProfile(body);
      setP(r.profile);
      toast("Profile saved");
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <section className="card">
      <h3>Profile</h3>
      <p className="muted small">
        Forms are filled from exactly these values. Built from your resume during setup.
      </p>
      <div className="grid3">
        <Input label="Full name" value={p.name} onChange={set("name")} />
        <Input label="Email" value={p.email} onChange={set("email")} type="email" />
        <Input label="Phone" value={p.phone} onChange={set("phone")} />
        <Input label="City" value={p.city ?? ""} onChange={set("city")} />
        <Input label="Country" value={p.country ?? ""} onChange={set("country")} />
        <Input
          label="Years of experience"
          value={p.totalYears === undefined ? "" : String(p.totalYears)}
          onChange={set("totalYears")}
          type="number"
        />
        <Input label="LinkedIn" value={p.links.linkedin ?? ""} onChange={setLink("linkedin")} />
        <Input label="GitHub" value={p.links.github ?? ""} onChange={setLink("github")} />
        <Input label="Portfolio" value={p.links.portfolio ?? ""} onChange={setLink("portfolio")} />
      </div>
      <Input
        label="Skills"
        hint="comma separated"
        value={skills}
        onChange={(e) => setSkills(e.target.value)}
      />

      <div className="field">
        <span className="field-label">Work history</span>
        <div className="entries">
          {p.experience.map((x, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place and have no id
            <div className="entry" key={i}>
              <input
                aria-label="Job title"
                placeholder="Title"
                value={x.title}
                onChange={(e) => setExp(i, "title", e.target.value)}
              />
              <input
                aria-label="Company"
                placeholder="Company"
                value={x.company}
                onChange={(e) => setExp(i, "company", e.target.value)}
              />
              <input
                aria-label="Start"
                placeholder="Start"
                value={x.start ?? ""}
                onChange={(e) => setExp(i, "start", e.target.value)}
              />
              <input
                aria-label="End"
                placeholder="End"
                value={x.end ?? ""}
                onChange={(e) => setExp(i, "end", e.target.value)}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm danger"
                onClick={() => setP({ ...p, experience: p.experience.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            setP({ ...p, experience: [...p.experience, { company: "", title: "", highlights: [] }] })
          }
        >
          Add a job
        </button>
      </div>

      <div className="field">
        <span className="field-label">Education</span>
        <div className="entries">
          {p.education.map((x, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place and have no id
            <div className="entry" key={i}>
              <input
                aria-label="School"
                placeholder="School"
                value={x.school}
                onChange={(e) => setEdu(i, "school", e.target.value)}
              />
              <input
                aria-label="Degree"
                placeholder="Degree"
                value={x.degree ?? ""}
                onChange={(e) => setEdu(i, "degree", e.target.value)}
              />
              <input
                aria-label="Field"
                placeholder="Field"
                value={x.field ?? ""}
                onChange={(e) => setEdu(i, "field", e.target.value)}
              />
              <input
                aria-label="Year finished"
                placeholder="Year"
                value={x.end ?? ""}
                onChange={(e) => setEdu(i, "end", e.target.value)}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm danger"
                onClick={() => setP({ ...p, education: p.education.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setP({ ...p, education: [...p.education, { school: "" }] })}
        >
          Add a school
        </button>
      </div>

      <div className="inline-form">
        <button type="button" className="btn btn-primary" onClick={save}>
          Save profile
        </button>
      </div>
    </section>
  );
}

export function Input(props: {
  label: string;
  hint?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  placeholder?: string;
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
        placeholder={props.placeholder}
        inputMode={props.type === "number" ? "numeric" : undefined}
      />
    </label>
  );
}
