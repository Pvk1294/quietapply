import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Config, saveConfig } from "../core/config.js";
import { type DB, openDb } from "../core/db.js";
import { recordHandoff } from "../core/handoffs.js";
import { ensureHome, packageRoot, paths } from "../core/paths.js";
import { addApplication, askQuestion, finishRun, setStatus, startRun } from "../core/store.js";
import { saveAnswer } from "../memory/answers.js";
import { Profile, saveProfile } from "../memory/profile.js";
import { runFolder } from "../runner/evidence.js";
import { runOnce } from "../runner/run.js";
import { defaultFetcher } from "../sources/http.js";

/** The fake persona used by the demo, fixtures and screenshots. Nothing here is a real person. */
export const DEMO_PROFILE = Profile.parse({
  name: "Jane Doe",
  email: "jane.doe@example.com",
  phone: "+1 555 010 0199",
  location: "Springfield, Oregon",
  headline: "Full-Stack Software Engineer",
  links: {
    linkedin: "https://www.linkedin.com/in/jane-doe-example",
    github: "https://github.com/janedoe-example",
    other: [],
  },
  totalYears: 5,
  experience: [
    { company: "Initech", title: "Software Engineer", start: "Jan 2022", end: "Present", highlights: [] },
    {
      company: "Globex Corporation",
      title: "Junior Developer",
      start: "Jun 2020",
      end: "Dec 2021",
      highlights: [],
    },
  ],
  education: [
    { school: "Springfield State University", degree: "B.S.", field: "Computer Science", end: "2020" },
  ],
  skills: [
    "typescript",
    "javascript",
    "python",
    "sql",
    "react",
    "node.js",
    "django",
    "postgresql",
    "redis",
    "docker",
    "aws",
  ].map((name) => ({ name })),
  resumeFile: "resume.txt",
});

const ANSWERS: [string, string, string, boolean?][] = [
  [
    "work_authorization",
    "Are you legally authorized to work in the countries you are applying to?",
    "Yes, in the United States",
  ],
  ["sponsorship", "Will you now or in the future require visa sponsorship?", "No"],
  ["notice_period", "What is your notice period?", "30 days"],
  ["relocation", "Are you willing to relocate?", "No, remote or Springfield only"],
  ["work_mode", "Which work arrangements are you open to (remote, hybrid, on-site)?", "Remote or hybrid"],
  ["data_consent", "Do you agree to companies storing and processing your application data?", "Yes"],
  ["referral", "How did you hear about this job?", "Company careers page"],
  ["gender", "Gender (voluntary self-identification)", "I prefer not to answer", true],
  ["veteran", "Veteran status (voluntary self-identification)", "I prefer not to answer", true],
  [
    "why_role",
    "In two or three sentences, what kind of role are you looking for and why?",
    "A product-minded full-stack role on a small team, where I can own features end to end in TypeScript.",
  ],
];

/** Build a throwaway data folder with a believable spread of applications, then point QuietApply at it. */
export async function createDemo(home = join(tmpdir(), "quietapply-demo")): Promise<string> {
  rmSync(home, { recursive: true, force: true });
  process.env.QUIETAPPLY_HOME = home;
  const p = ensureHome(paths(home));
  saveConfig(
    Config.parse({
      provider: "fake",
      dryRun: true,
      schedule: ["09:00", "13:00", "19:00"],
      companies: [
        { name: "Acme Rockets", ats: "greenhouse", token: "acmerockets" },
        { name: "Globex Corporation", ats: "lever", token: "globex" },
        { name: "Umbrella Labs", ats: "ashby", token: "umbrella" },
      ],
      rules: {
        roles: ["engineer", "developer"],
        excludeTitles: ["intern", "principal", "staff"],
        locations: ["remote", "Springfield"],
        neverApply: ["Initech"],
      },
    }),
    p,
  );
  saveProfile(DEMO_PROFILE, p);
  copyFileSync(
    join(packageRoot(), "fixtures", "persona", "jane-doe-resume.txt"),
    join(p.resumeDir, "resume.txt"),
  );
  const db = openDb(p);
  for (const [key, question, answer, sensitive] of ANSWERS)
    saveAnswer(db, {
      key,
      question,
      answer,
      sensitive,
      source: key === "gender" || key === "veteran" ? "default" : "setup",
    });

  // History first (older timestamps), so the real fixture run below shows up as the latest activity.
  seedHistory(db);
  db.close();

  // A real run of the scripted agent over the local fixture pages.
  const fx = (f: string) => pathToFileURL(join(packageRoot(), "fixtures", "ats", f)).toString();
  const db2 = openDb(p);
  addApplication(db2, {
    company: "Acme Rockets",
    title: "Software Engineer, Payments",
    url: fx("greenhouse-acme-job.html"),
    ats: "greenhouse",
    location: "Remote - US",
    source: "greenhouse",
  });
  const globex = addApplication(db2, {
    company: "Globex Corporation",
    title: "Backend Developer",
    url: fx("lever-globex-apply.html"),
    ats: "lever",
    location: "Springfield",
    source: "lever",
  });
  addApplication(db2, {
    company: "Umbrella Labs",
    title: "Full-Stack Engineer",
    url: fx("ashby-umbrella-application.html"),
    ats: "ashby",
    location: "Remote",
    source: "ashby",
  });
  addApplication(db2, {
    company: "Initrode",
    title: "Data Engineer",
    url: fx("greenhouse-captcha.html"),
    ats: "greenhouse",
    location: "Remote",
    source: "greenhouse",
  });
  db2.close();
  const run = await runOnce({ p, fetcher: defaultFetcher, trigger: "manual" });
  // The scripted agent has no browser; give the Globex dry run the screenshot a real agent would have taken.
  if (run.runId) {
    const folder = runFolder(p, run.runId, globex.id);
    mkdirSync(folder, { recursive: true });
    copyFileSync(join(packageRoot(), "fixtures", "demo", "globex-dry-run.png"), join(folder, "form.png"));
  }
  return home;
}

function seedHistory(db: DB): void {
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const at = (id: number, hours: number) => {
    db.prepare(
      "UPDATE applications SET created_at = ?, updated_at = ?, submitted_at = CASE WHEN status = 'submitted' THEN ? ELSE submitted_at END WHERE id = ?",
    ).run(ago(hours + 1), ago(hours), ago(hours), id);
    db.prepare("UPDATE application_events SET at = ? WHERE application_id = ?").run(ago(hours), id);
  };
  const add = (company: string, title: string, ats: string, location: string, slug: string) =>
    addApplication(db, {
      company,
      title,
      ats,
      location,
      source: ats,
      url: `https://example.com/demo/${slug}`,
    }).id;

  const submitted: [string, string, string, string, number][] = [
    ["Hooli", "Software Engineer, Platform", "greenhouse", "Remote - US", 0.4],
    ["Soylent Labs", "Full-Stack Engineer", "ashby", "Remote", 0.7],
    ["Wonka Industries", "Backend Engineer", "lever", "Springfield", 26],
    ["Massive Dynamic", "Product Engineer", "greenhouse", "Remote", 30],
    ["Tyrell Systems", "Frontend Engineer", "ashby", "Remote - Americas", 50],
  ];
  for (const [company, title, ats, location, h] of submitted) {
    const id = add(company, title, ats, location, company.toLowerCase().replace(/\W+/g, "-"));
    setStatus(db, id, "in_progress");
    setStatus(db, id, "submitting", { reason: "about to click Submit" });
    setStatus(db, id, "submitted", {
      reason: "Confirmation: Thank you for applying!",
      evidence: "Thank you for applying!",
    });
    at(id, h);
  }

  const review = add("Cyberdyne", "Software Engineer, Billing", "greenhouse", "Remote - US", "cyberdyne");
  setStatus(db, review, "awaiting_review", {
    reason: "filled, waiting for your OK in the dashboard",
    evidence: JSON.stringify({
      filled: [
        { field: "First Name", value: "Jane", source: "profile:first_name" },
        { field: "Last Name", value: "Doe", source: "profile:last_name" },
        { field: "Email", value: "jane.doe@example.com", source: "profile:email" },
        { field: "Resume/CV", value: "resume", source: "resume" },
        { field: "Will you require visa sponsorship?", value: "No", source: "mem:2" },
        { field: "When can you start?", value: "30 days", source: "mem:3" },
        {
          field: "Why Cyberdyne?",
          value: "I want to own billing features end to end in TypeScript, on a small product team.",
          source: "tailored:mem:10",
        },
      ],
    }),
  });
  at(review, 2);

  const kafka = add("Oscorp", "Senior Backend Engineer", "lever", "Remote", "oscorp");
  setStatus(db, kafka, "needs_answers", { reason: "waiting for your answers" });
  askQuestion(db, {
    applicationId: kafka,
    question: "How many years of production experience do you have with Kafka?",
    context: "Senior Backend Engineer at Oscorp",
    fieldType: "number",
  });
  at(kafka, 1);

  const email = add("Vandelay Industries", "Software Developer", "greenhouse", "Springfield", "vandelay");
  setStatus(db, email, "blocked", {
    reason: "The posting asks for a CV by email to a recruiter.",
    blockedCategory: "external_redirect",
  });
  recordHandoff(db, {
    applicationId: email,
    reason: "external_redirect",
    detail: "The posting asks for a CV by email to a recruiter.",
    needed: "Email your CV to the recruiter named on the posting.",
    filled: [{ field: "Email", value: "jane.doe@example.com" }],
  });
  at(email, 20);

  const video = add("Prestige Worldwide", "Full-Stack Developer", "ashby", "Remote", "prestige");
  setStatus(db, video, "blocked", {
    reason: "Step 2 asks for a 2-minute video introduction.",
    blockedCategory: "other",
  });
  recordHandoff(db, {
    applicationId: video,
    reason: "other",
    detail: "Step 2 asks for a 2-minute video introduction.",
    needed: "Record the video and finish the form yourself.",
    filled: [
      { field: "First Name", value: "Jane" },
      { field: "Last Name", value: "Doe" },
      { field: "Email", value: "jane.doe@example.com" },
    ],
  });
  at(video, 27);

  const captcha = add("Soylent Corp", "Platform Engineer", "greenhouse", "Remote", "soylent");
  setStatus(db, captcha, "blocked", { reason: "A visible CAPTCHA on the form.", blockedCategory: "captcha" });
  recordHandoff(db, {
    applicationId: captcha,
    reason: "captcha",
    detail: "A visible CAPTCHA on the form. QuietApply never solves these.",
    filled: [
      { field: "First Name", value: "Jane" },
      { field: "Last Name", value: "Doe" },
      { field: "Email", value: "jane.doe@example.com" },
      { field: "Phone", value: "+1 555 010 0199" },
    ],
  });
  at(captcha, 4);

  const workday = add("Wonka Industries", "Software Engineer II", "unknown", "Remote", "wonka");
  setStatus(db, workday, "blocked", {
    reason: "wonka.wd1.myworkdayjobs.com is not automated yet.",
    blockedCategory: "unsupported_ats",
  });
  recordHandoff(db, {
    applicationId: workday,
    reason: "unsupported_ats",
    detail: "wonka.wd1.myworkdayjobs.com is not automated yet.",
  });
  at(workday, 5);

  const skipped: [string, string, string][] = [
    ["Acme Rockets", "Principal Engineer, Propulsion", 'title contains excluded word "principal"'],
    ["Globex Corporation", "Engineering Intern", 'title contains excluded word "intern"'],
    ["Acme Rockets", "Frontend Engineer", "posting asks applicants not to use AI tools"],
  ];
  for (const [company, title, reason] of skipped) {
    const id = add(
      company,
      title,
      "greenhouse",
      "Remote",
      `${company}-${title}`.toLowerCase().replace(/\W+/g, "-"),
    );
    setStatus(db, id, "skipped", { reason });
    recordHandoff(db, {
      applicationId: id,
      reason: "fit_gate",
      detail: `Skipped by your rules: ${reason}.`,
      rule: reason,
    });
    at(id, 28);
  }

  for (const [h, summary] of [
    [50, "2 submitted, 1 skipped"],
    [27, "2 submitted, 1 finish yourself"],
    [1, "2 submitted, 1 review, 1 needs answers"],
  ] as const) {
    const id = startRun(db, "claude-code", false, "schedule");
    finishRun(db, id, "completed", summary);
    db.prepare("UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?").run(ago(h), ago(h - 0.25), id);
  }
}
