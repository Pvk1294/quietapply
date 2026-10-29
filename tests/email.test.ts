import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addJob } from "../src/cli/add.js";
import { Config, loadConfig, saveConfig } from "../src/core/config.js";
import { openDb } from "../src/core/db.js";
import { listHandoffs } from "../src/core/handoffs.js";
import type { Paths } from "../src/core/paths.js";
import { evidenceHash } from "../src/core/safety.js";
import { addApplication, approveReview, getApplication } from "../src/core/store.js";
import { emailsFor, onDoNotContact } from "../src/email/apply.js";
import { applyEmailIn, cleanAddress, composeApplicationEmail } from "../src/email/compose.js";
import { declineEmail, smtpPreset, turnOffEmail, turnOnEmail } from "../src/email/mode.js";
import { forgetPassword, readPassword, savePassword } from "../src/email/secret.js";
import { smtpSender } from "../src/email/send.js";
import { Desk } from "../src/mcp/desk.js";
import { saveAnswer } from "../src/memory/answers.js";
import { runOnce } from "../src/runner/run.js";
import { fakeSmtp } from "./helpers/fake-smtp.js";
import { fixtureFetcher } from "./helpers/fixtures.js";
import { JANE, makeHome } from "./helpers/home.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** A data folder where email is on, pointed at an in-process fake SMTP server. Nothing leaves the machine. */
async function emailHome(extra: Partial<Config> = {}, smtp: { reject?: boolean } = {}) {
  const server = await fakeSmtp(smtp);
  closers.push(server.close);
  const base = Config.parse({});
  const p = makeHome({
    provider: "codex", // not "fake": the fake provider forces dry run
    dryRun: false,
    email: turnOnEmail(
      {
        ...base,
        email: {
          ...base.email,
          from: "jane.doe@example.com",
          smtp: { host: "127.0.0.1", port: server.port, secure: false, user: "jane.doe@example.com" },
        },
      },
      { accept: true },
    ).email,
    ...extra,
  });
  writeFileSync(join(p.resumeDir, "resume.pdf"), "%PDF-1.4 fake resume for tests");
  const config = loadConfig(p);
  const sender = smtpSender(config, "app-password-123", { plainLocal: true });
  return { p, server, sender };
}

function queueEmailJob(p: Paths, title = "Backend Engineer", to = "jobs@initrode.example") {
  const db = openDb(p);
  const id = addApplication(db, {
    company: "Initrode",
    title,
    url: `mailto:${to}?role=${encodeURIComponent(title)}`,
    ats: "email",
  }).id;
  db.prepare("UPDATE applications SET apply_email = ? WHERE id = ?").run(to, id);
  db.close();
  return id;
}

const run = (p: Paths, sender: ReturnType<typeof smtpSender>) =>
  runOnce({ p, fetcher: fixtureFetcher, emailSender: sender });

describe("finding email applications", () => {
  it.each([
    ["To apply, send your resume to Jobs@Initrode.example.", "jobs@initrode.example"],
    ["Please email your CV and a short note to hiring@globex.example", "hiring@globex.example"],
    ["Apply by email: careers@umbrella.example", "careers@umbrella.example"],
  ])("%s", (text, to) => {
    expect(applyEmailIn(text)).toBe(to);
  });
  it("does not treat a contact address as an email application", () => {
    expect(applyEmailIn("For accommodations during the process, contact accessibility@acme.example.")).toBe(
      undefined,
    );
    expect(applyEmailIn("Questions? Email recruiting@acme.example.")).toBe(undefined);
  });
  it("cleans addresses and mailto links", () => {
    expect(cleanAddress("mailto:Jobs@Acme.example?subject=Hi")).toBe("jobs@acme.example");
    expect(cleanAddress("not an address")).toBe(undefined);
  });
});

describe("the email text", () => {
  it("is built from the profile and stored answers only, with the agreed subject", () => {
    const p = makeHome();
    const db = openDb(p);
    saveAnswer(db, { key: "notice_period", question: "What is your notice period?", answer: "30 days" });
    const e = composeApplicationEmail(
      db,
      { ...JANE, headline: "Full-Stack Software Engineer" },
      { title: "Backend Engineer", company: "Initrode" },
      "jobs@initrode.example",
    );
    expect(e.subject).toBe("Application: Backend Engineer, Jane Doe");
    expect(e.body).toContain("I would like to apply for the Backend Engineer role at Initrode.");
    expect(e.body).toContain("I am a Full-Stack Software Engineer with 5 years of experience.");
    expect(e.body).toContain("I currently work as Software Engineer at Initech.");
    expect(e.body).toContain("My notice period is 30 days.");
    expect(e.body).toContain("Kind regards,\nJane Doe\n+1 555 010 0199\njane.doe@example.com");
    expect(e.attachment).toBe("resume.pdf");
    // Nothing that is not in the profile or memory: no claims about the company, no invented skills.
    expect(e.body.split(/\s+/).length).toBeLessThan(120);
  });

  it("uses your base cover letter when you saved one", () => {
    const p = makeHome();
    const db = openDb(p);
    saveAnswer(db, {
      key: "cover_letter",
      question: "A short base cover letter (optional).",
      answer: "I like building tools.",
    });
    const e = composeApplicationEmail(db, JANE, { title: "Dev", company: "Acme" }, "a@acme.example");
    expect(e.body).toContain("I like building tools.");
  });
});

describe("asking first", () => {
  it("is off by default, and stays off without a stored yes", () => {
    expect(Config.parse({}).email.enabled).toBe(false);
    const p = makeHome({ email: { ...Config.parse({}).email, enabled: true } });
    expect(loadConfig(p).email.enabled).toBe(false);
  });
  it("stores the yes or the no with its time", () => {
    const at = new Date("2026-10-29T10:00:00Z");
    expect(turnOnEmail(Config.parse({}), { accept: true, at }).email).toMatchObject({
      enabled: true,
      acceptedAt: at.toISOString(),
    });
    expect(turnOnEmail(Config.parse({}), { accept: false }).email.enabled).toBe(false);
    expect(declineEmail(Config.parse({}), at).email).toMatchObject({
      enabled: false,
      declinedAt: at.toISOString(),
    });
  });
  it("knows the common mail servers", () => {
    expect(smtpPreset("jane@gmail.com")).toEqual({ host: "smtp.gmail.com", port: 465, secure: true });
    expect(smtpPreset("jane@outlook.com")?.host).toBe("smtp-mail.outlook.com");
    expect(smtpPreset("jane@small-isp.example")).toBe(undefined);
  });
});

describe("with email off", () => {
  it("sends nothing and puts the ready text in Finish yourself", async () => {
    const p = makeHome({ provider: "codex", dryRun: false });
    const id = queueEmailJob(p);
    const server = await fakeSmtp();
    closers.push(server.close);
    await runOnce({
      p,
      fetcher: fixtureFetcher,
      emailSender: smtpSender(
        Config.parse({ email: { smtp: { host: "127.0.0.1", port: server.port, user: "x" } } }),
        "x",
        { plainLocal: true },
      ),
    });
    expect(server.mails).toHaveLength(0);
    const db = openDb(p);
    expect(getApplication(db, id)).toMatchObject({ status: "blocked", blocked_category: "email_only" });
    const h = listHandoffs(db).find((x) => x.application_id === id)!;
    expect(h.reason).toBe("email_only");
    expect(h.filled.map((f) => f.field)).toEqual(["To", "Subject", "Body", "Attach"]);
    expect(h.filled[1]!.value).toBe("Application: Backend Engineer, Jane Doe");
  });

  it("an email-only posting the agent finds is handed back with the text, never sent by the agent", () => {
    const p = makeHome();
    const db = openDb(p);
    const id = addApplication(db, {
      company: "Globex",
      title: "Dev",
      url: "https://jobs.lever.co/globex/1",
    }).id;
    const desk = new Desk(db, Config.parse({}), JANE, p, id);
    desk.markBlocked({ category: "email_only", notes: "Apply by email", email: "Jobs@Globex.example" });
    expect(getApplication(db, id)).toMatchObject({ status: "blocked", apply_email: "jobs@globex.example" });
    expect(listHandoffs(db)[0]!.filled[0]).toEqual({ field: "To", value: "jobs@globex.example" });
  });
});

describe("with email on (fake SMTP server on 127.0.0.1)", () => {
  it("writes but never sends in dry run", async () => {
    const { p, server, sender } = await emailHome({ dryRun: true });
    const id = queueEmailJob(p);
    await run(p, sender);
    expect(server.mails).toHaveLength(0);
    const db = openDb(p);
    expect(getApplication(db, id)?.status).toBe("dry_run");
    expect(emailsFor(db, id).map((e) => e.status)).toEqual(["dry_run"]);
  });

  it("waits for your OK on the first emails, sends exactly what you approved, and records it", async () => {
    const { p, server, sender } = await emailHome();
    const id = queueEmailJob(p);
    await run(p, sender);
    expect(server.mails).toHaveLength(0);
    let db = openDb(p);
    const waiting = getApplication(db, id)!;
    expect(waiting.status).toBe("awaiting_review");
    const shown = JSON.parse(waiting.evidence!).email;
    expect(shown.subject).toBe("Application: Backend Engineer, Jane Doe");

    approveReview(db, id, evidenceHash(waiting.evidence)!);
    db.close();
    await run(p, sender);
    expect(server.mails).toHaveLength(1);
    const mail = server.mails[0]!;
    expect(mail.to).toEqual(["jobs@initrode.example"]);
    expect(mail.from).toBe("jane.doe@example.com");
    expect(mail.auth).toBe("jane.doe@example.com:app-password-123");
    expect(mail.data).toContain("Subject: Application: Backend Engineer, Jane Doe");
    expect(mail.data).toContain("filename=resume.pdf");

    db = openDb(p);
    expect(getApplication(db, id)?.status).toBe("submitted");
    const [sent] = emailsFor(db, id);
    expect(sent).toMatchObject({ status: "sent", to_addr: "jobs@initrode.example", subject: shown.subject });
    expect(sent!.body).toBe(shown.body);
    expect(sent!.message_id).toMatch(/^<.+@.+>$/);
  });

  it("asks again when the email changed after your OK", async () => {
    const { p, server, sender } = await emailHome();
    const id = queueEmailJob(p);
    await run(p, sender);
    let db = openDb(p);
    approveReview(db, id, evidenceHash(getApplication(db, id)!.evidence)!);
    // A new saved answer changes the text before it goes out.
    saveAnswer(db, { key: "notice_period", question: "What is your notice period?", answer: "Immediately" });
    db.close();
    await run(p, sender);
    expect(server.mails).toHaveLength(0);
    db = openDb(p);
    expect(getApplication(db, id)).toMatchObject({ status: "awaiting_review", review_approved: 0 });
    expect(getApplication(db, id)!.reason).toContain("changed since you approved");
  });

  it("never writes twice to the same address in 30 days, and keeps the daily cap", async () => {
    const { p, server, sender } = await emailHome({ limits: { ...Config.parse({}).limits, reviewFirst: 0 } });
    const config = loadConfig(p);
    saveConfig({ ...config, email: { ...config.email, perDay: 1 } }, p);
    const a = queueEmailJob(p, "Backend Engineer", "jobs@initrode.example");
    const b = queueEmailJob(p, "Frontend Engineer", "jobs@initrode.example");
    const c = queueEmailJob(p, "Data Engineer", "careers@globex.example");
    await run(p, sender);
    expect(server.mails).toHaveLength(1);
    const db = openDb(p);
    expect(getApplication(db, a)?.status).toBe("submitted");
    expect(getApplication(db, b)).toMatchObject({ status: "skipped" });
    expect(getApplication(db, b)!.reason).toContain("in the last 30 days");
    expect(getApplication(db, c)).toMatchObject({ status: "queued" });
    expect(getApplication(db, c)!.reason).toContain("email limit");
  });

  it("never writes to anyone on the do-not-contact list", async () => {
    const { p, server, sender } = await emailHome({
      doNotContact: ["initrode.example"],
      limits: { ...Config.parse({}).limits, reviewFirst: 0 },
    });
    const id = queueEmailJob(p);
    await run(p, sender);
    expect(server.mails).toHaveLength(0);
    expect(getApplication(openDb(p), id)).toMatchObject({ status: "skipped" });
    const conf = Config.parse({
      doNotContact: ["@acme.example", "Pat Recruiter", "https://www.linkedin.com/in/pat/"],
    });
    expect(onDoNotContact(conf, "hr@acme.example")).toBe(true);
    expect(onDoNotContact(conf, "pat recruiter")).toBe(true);
    expect(onDoNotContact(conf, "https://www.linkedin.com/in/pat")).toBe(true);
    expect(onDoNotContact(conf, "hr@other.example")).toBe(false);
  });

  it("records a refused login as failed, without the password", async () => {
    const { p, sender } = await emailHome(
      { limits: { ...Config.parse({}).limits, reviewFirst: 0 } },
      { reject: true },
    );
    const id = queueEmailJob(p);
    await run(p, sender);
    const db = openDb(p);
    expect(getApplication(db, id)?.status).toBe("failed");
    const [row] = emailsFor(db, id);
    expect(row!.status).toBe("failed");
    expect(JSON.stringify([row, listHandoffs(db)])).not.toContain("app-password-123");
  });

  it("is queued from the command line with a mailto link", async () => {
    const p = makeHome();
    const db = openDb(p);
    const r = await addJob(db, "mailto:Jobs@Initrode.example", fixtureFetcher, {
      company: "Initrode",
      title: "Backend Engineer",
    });
    expect(getApplication(db, r.id)).toMatchObject({ ats: "email", apply_email: "jobs@initrode.example" });
    await expect(addJob(db, "mailto:jobs@initrode.example", fixtureFetcher, {})).rejects.toThrow("--company");
  });
});

describe("the app password", () => {
  it("goes to the macOS keychain on stdin, never on the command line", () => {
    const calls: { cmd: string; args: string[]; input?: string }[] = [];
    const p = makeHome();
    const run = (cmd: string, args: string[], input?: string) => {
      calls.push({ cmd, args, input });
      return cmd === "security" && args[0] === "find-generic-password" ? "s3cret pass\n" : "";
    };
    expect(savePassword(p, "jane@example.com", "s3cret pass", { platform: "darwin", run })).toBe("keychain");
    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.input).toContain('-w "s3cret pass"');
    expect(calls.flatMap((c) => c.args).join(" ")).not.toContain("s3cret");
    expect(readPassword(p, "jane@example.com", { platform: "darwin", run })).toBe("s3cret pass");
  });

  it("uses a file only you can read when there is no keychain, and forgets it on turn-off", () => {
    const p = makeHome();
    const fail = () => {
      throw new Error("no secret service");
    };
    expect(savePassword(p, "jane@example.com", "pw", { platform: "linux", run: fail })).toBe("file");
    const file = join(p.home, "smtp-password.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readPassword(p, "jane@example.com", { platform: "linux", run: fail })).toBe("pw");
    expect(readPassword(p, "someone@else.example", { platform: "linux", run: fail })).toBe(undefined);
    forgetPassword(p, "jane@example.com", { platform: "linux", run: fail });
    expect(existsSync(file)).toBe(false);
  });

  it("turning email off removes the password and stops sending", () => {
    const p = makeHome();
    savePassword(p, "jane@example.com", "pw", { platform: "win32" });
    const base = Config.parse({});
    const on = turnOnEmail(
      { ...base, email: { ...base.email, smtp: { ...base.email.smtp, user: "jane@example.com" } } },
      { accept: true },
    );
    const off = turnOffEmail(on, p, { platform: "win32" });
    expect(off.email.enabled).toBe(false);
    expect(existsSync(join(p.home, "smtp-password.json"))).toBe(false);
    expect(readFileSync(p.config, "utf8")).not.toContain("pw");
  });
});

describe("dashboard API for email and messages", () => {
  const H = { host: "127.0.0.1:4777", "x-quietapply": "1", "content-type": "application/json" };
  const keychain = new Map<string, string>();
  const fakeKeychain = {
    platform: "darwin" as const,
    run: (cmd: string, args: string[], input?: string) => {
      if (args[0] === "-i") {
        const m = input!.match(/-a "([^"]+)" -w "([^"]+)"/)!;
        keychain.set(m[1]!, m[2]!);
        return "";
      }
      if (args[0] === "find-generic-password") {
        const v = keychain.get(args[args.indexOf("-a") + 1]!);
        if (!v) throw new Error("not found");
        return `${v}\n`;
      }
      if (args[0] === "delete-generic-password") keychain.delete(args[args.indexOf("-a") + 1]!);
      return cmd ? "" : "";
    },
  };

  it("needs the yes, sets the server from the address, and never returns the password", async () => {
    const { createApp } = await import("../src/server/app.js");
    const p = makeHome();
    const app = createApp({ p, port: 4777, secretDeps: fakeKeychain });
    const put = (b: unknown) =>
      app.request("/api/email", { method: "PUT", headers: H, body: JSON.stringify(b) });

    expect((await put({ enabled: true })).status).toBe(400);
    expect(
      ((await (await put({ enabled: true, accept: true })).json()) as { enabled: boolean }).enabled,
    ).toBe(true);
    const set = (await (await put({ from: "Jane.Doe@gmail.com" })).json()) as {
      smtp: { host: string; user: string };
    };
    expect(set.smtp).toMatchObject({ host: "smtp.gmail.com", user: "jane.doe@gmail.com" });

    const stored = await app.request("/api/email/password", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ password: "abcd efgh ijkl mnop" }),
    });
    const body = await stored.text();
    expect(JSON.parse(body)).toMatchObject({ hasPassword: true, storedIn: "keychain" });
    expect(body).not.toContain("abcd");
    expect(await (await app.request("/api/email", { headers: H })).text()).not.toContain("abcd");
    expect(readFileSync(p.config, "utf8")).not.toContain("abcd");

    // Off at once, and the password is gone.
    const off = (await (await put({ enabled: false })).json()) as { enabled: boolean; hasPassword: boolean };
    expect(off).toMatchObject({ enabled: false, hasPassword: false });
  });

  it("recruiter messages need LinkedIn mode and their own yes", async () => {
    const { createApp } = await import("../src/server/app.js");
    const p = makeHome();
    const app = createApp({ p, port: 4777, secretDeps: fakeKeychain });
    const put = (b: unknown) =>
      app.request("/api/linkedin/messages", { method: "PUT", headers: H, body: JSON.stringify(b) });
    const r = await put({ enabled: true, accept: true });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("LinkedIn mode first");
  });
});
