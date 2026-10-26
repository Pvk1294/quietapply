import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type Profile, saveProfile } from "../../../memory/profile.js";
import { type Step, splitList, type WizardContext } from "../context.js";
import type { Prompter } from "../prompter.js";

export function expandHome(f: string): string {
  return f === "~" ? homedir() : f.startsWith("~/") ? `${homedir()}${f.slice(1)}` : f;
}

/** A path as typed or dragged into a terminal: quotes, "\ " escapes and ~ are allowed. */
export function cleanPath(v: string): string {
  return resolve(
    expandHome(
      v
        .trim()
        .replace(/^['"]|['"]$/g, "")
        .replace(/\\ /g, " "),
    ),
  );
}

const isEmail = (v: string) =>
  !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? undefined : "That doesn't look like an email";
const isUrl = (v: string) =>
  !v || /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v) ? undefined : "Paste a link";

function withScheme(v: string): string | undefined {
  if (!v) return undefined;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/** Show a list (jobs, schools) and let the person fix, add or remove entries until it looks right. */
async function editList<T extends Record<string, unknown>>(
  ui: Prompter,
  o: {
    what: string;
    items: T[];
    describe: (x: T) => string;
    fields: { key: keyof T & string; label: string }[];
    blank: () => T;
  },
): Promise<T[]> {
  const items = [...o.items];
  for (;;) {
    ui.note(
      items.length ? items.map((x, i) => `${i + 1}. ${o.describe(x)}`).join("\n") : "(none found)",
      o.what,
    );
    const action = await ui.select({
      message: `Is your ${o.what.toLowerCase()} right?`,
      initial: "ok",
      options: [
        { value: "ok", label: "Looks right" },
        { value: "edit", label: "Fix an entry" },
        { value: "add", label: "Add an entry" },
        { value: "remove", label: "Remove an entry" },
      ].filter((x) => items.length || x.value === "ok" || x.value === "add"),
    });
    if (action === "ok") return items;
    let idx = items.length;
    if (action !== "add") {
      const pick = await ui.select({
        message: action === "edit" ? "Which one?" : "Remove which one?",
        options: items.map((x, i) => ({ value: String(i), label: o.describe(x) })),
      });
      idx = Number(pick);
      if (action === "remove") {
        items.splice(idx, 1);
        continue;
      }
    }
    const entry: T = { ...(items[idx] ?? o.blank()) };
    for (const f of o.fields) {
      const v = await ui.text({ message: f.label, initial: String(entry[f.key] ?? "") });
      (entry as Record<string, unknown>)[f.key] = v || undefined;
    }
    items[idx] = entry;
  }
}

/** Step 2: read the resume, pre-fill the profile, and let the person confirm or fix every part of it. */
export const resumeStep: Step = {
  id: "resume",
  title: "Resume and profile",
  async run(ctx: WizardContext) {
    const { ui, dirs } = ctx;
    let file = ctx.opts.resume;
    if (!file && ui.interactive) {
      const replace = ctx.profile.resumeFile
        ? (await ui.select({
            message: `You already gave a resume (${ctx.profile.resumeFile}).`,
            initial: "keep",
            options: [
              { value: "keep", label: "Keep it and review my profile" },
              { value: "new", label: "Read a new resume" },
            ],
          })) === "new"
        : true;
      if (replace)
        file = await ui.text({
          message: "Path to your resume (PDF, DOCX or text). Tip: drag the file into this window.",
          placeholder: "~/Documents/resume.pdf",
          validate: (v) =>
            !v || existsSync(cleanPath(v)) ? undefined : "File not found (leave empty to skip)",
        });
    }

    let profile = ctx.profile;
    if (file) {
      const path = cleanPath(file);
      const provider = ctx.config.provider === "fake" ? undefined : ctx.deps.providers[ctx.config.provider];
      const r = await ui.spin(
        provider ? `Reading your resume (with ${provider.label}, about a minute)` : "Reading your resume",
        () => ctx.deps.importResume(path, dirs, provider),
        (x) =>
          `Read ${x.profile.experience.length} jobs, ${x.profile.education.length} schools and ${x.profile.skills.length} skills${x.usedAgent ? " (checked by your AI)" : ""}`,
      );
      profile = r.profile;
    } else if (!profile.resumeFile) {
      ui.warn("No resume yet. Add one later with `quietapply init --step resume`; most forms need it.");
    }

    ui.step("Check your details. Forms are filled from exactly these values; press Enter to keep one.");
    profile.name = await ui.text({ message: "Full name", initial: profile.name });
    profile.email = await ui.text({
      message: "Email for applications",
      initial: profile.email,
      validate: isEmail,
    });
    profile.phone = await ui.text({
      message: "Phone, with country code",
      initial: profile.phone,
      placeholder: "+91 98765 43210",
    });
    const [guessCity, ...rest] = profile.location.split(",").map((x) => x.trim());
    profile.city =
      (await ui.text({ message: "City you live in", initial: profile.city ?? guessCity ?? "" })) || undefined;
    profile.country =
      (await ui.text({ message: "Country you live in", initial: profile.country ?? rest.at(-1) ?? "" })) ||
      undefined;
    profile.location = [profile.city, profile.country].filter(Boolean).join(", ") || profile.location;
    profile.links.linkedin = withScheme(
      await ui.text({
        message: "LinkedIn profile URL (optional)",
        initial: profile.links.linkedin ?? "",
        validate: isUrl,
      }),
    );
    profile.links.github = withScheme(
      await ui.text({
        message: "GitHub URL (optional)",
        initial: profile.links.github ?? "",
        validate: isUrl,
      }),
    );
    profile.links.portfolio = withScheme(
      await ui.text({
        message: "Portfolio or website (optional)",
        initial: profile.links.portfolio ?? "",
        validate: isUrl,
      }),
    );

    profile.experience = await editList<Profile["experience"][number]>(ui, {
      what: "Work history",
      items: profile.experience,
      describe: (e) => `${e.title || "?"} at ${e.company || "?"} (${e.start ?? "?"} – ${e.end ?? "?"})`,
      fields: [
        { key: "title", label: "Job title" },
        { key: "company", label: "Company" },
        { key: "start", label: "Start (e.g. Jan 2022)" },
        { key: "end", label: "End (e.g. Present)" },
      ],
      blank: () => ({ company: "", title: "", highlights: [] }),
    });
    profile.experience = profile.experience.map((e) => ({
      ...e,
      company: e.company ?? "",
      title: e.title ?? "",
      highlights: e.highlights ?? [],
    }));

    profile.education = await editList<Profile["education"][number]>(ui, {
      what: "Education",
      items: profile.education,
      describe: (e) =>
        [e.degree, e.field, e.school].filter(Boolean).join(", ") + (e.end ? ` (${e.end})` : ""),
      fields: [
        { key: "school", label: "School or university" },
        { key: "degree", label: "Degree (e.g. B.Tech, BSc, MBA)" },
        { key: "field", label: "Field of study" },
        { key: "end", label: "Year finished" },
      ],
      blank: () => ({ school: "" }),
    });
    profile.education = profile.education.map((e) => ({ ...e, school: e.school ?? "" }));

    const skills = await ui.text({
      message: "Skills (comma separated)",
      initial: profile.skills.map((s) => s.name).join(", "),
    });
    const byName = new Map(profile.skills.map((s) => [s.name.toLowerCase(), s]));
    profile.skills = splitList(skills).map((name) => ({ ...byName.get(name.toLowerCase()), name }));

    const years = await ui.text({
      message: "Total years of work experience",
      initial: profile.totalYears === undefined ? "" : String(profile.totalYears),
      validate: (v) => (!v || /^\d{1,2}(\.\d)?$/.test(v) ? undefined : "A number, e.g. 4 or 4.5"),
    });
    profile.totalYears = years ? Number(years) : undefined;

    saveProfile(profile, dirs);
    ctx.profile = profile;
    ui.success(`Profile saved. Edit it any time in the dashboard (Settings → Profile) or ${dirs.profile}.`);
  },
};
