import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { Config } from "../src/core/config.js";
import { openDb } from "../src/core/db.js";
import { addApplication, getApplication, setStatus } from "../src/core/store.js";
import {
  approveMessage,
  composeRecruiterMessage,
  declineMessages,
  draftMessage,
  MESSAGE_MAX_WORDS,
  MESSAGE_MIN_WORDS,
  messagesEnabled,
  messagesFor,
  normalizeProfileUrl,
  turnOffMessages,
  turnOnMessages,
} from "../src/linkedin/messages.js";
import { stopLinkedIn } from "../src/linkedin/mode.js";
import { Desk } from "../src/mcp/desk.js";
import { Profile } from "../src/memory/profile.js";
import { runOnce } from "../src/runner/run.js";
import { fixtureFetcher } from "./helpers/fixtures.js";
import { JANE, makeHome } from "./helpers/home.js";

const AT = "2026-10-28T09:00:00.000Z";
const PAT = { name: "Pat Recruiter", profileUrl: "https://www.linkedin.com/in/pat-recruiter-example/" };
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** LinkedIn mode and messages both on (unless said otherwise), live, review done. */
function cfg(over: Record<string, unknown> = {}) {
  return Config.parse({
    provider: "claude-code",
    dryRun: false,
    sources: { linkedin: true },
    linkedin: { acceptedAt: AT, messages: { enabled: true, acceptedAt: AT, perDay: 3 } },
    limits: { reviewFirst: 0 },
    ...over,
  });
}

function submittedLinkedInApp() {
  const p = makeHome();
  const db = openDb(p);
  const id = addApplication(db, {
    company: "Hooli",
    title: "Frontend Engineer",
    url: "https://www.linkedin.com/jobs/view/4000000001/",
    ats: "linkedin",
    source: "linkedin",
  }).id;
  setStatus(db, id, "submitted");
  return { p, db, id, app: getApplication(db, id)! };
}

describe("the message text", () => {
  it("is one paragraph of 40 to 90 words, from the profile only", () => {
    const text = composeRecruiterMessage(
      { ...JANE, headline: "Full-Stack Software Engineer" },
      { title: "Frontend Engineer", company: "Hooli" },
      "Pat Recruiter",
    );
    expect(text.startsWith("Hi Pat, I just applied for the Frontend Engineer role at Hooli")).toBe(true);
    expect(text).toContain("I currently work as Software Engineer at Initech.");
    expect(text).not.toContain("\n");
    expect(words(text)).toBeGreaterThanOrEqual(MESSAGE_MIN_WORDS);
    expect(words(text)).toBeLessThanOrEqual(MESSAGE_MAX_WORDS);
  });

  it.each([
    ["an empty profile", Profile.parse({ name: "Jo" })],
    [
      "a long headline",
      {
        ...JANE,
        headline:
          "Senior Staff Principal Distinguished Full-Stack Platform Infrastructure Reliability and Developer Experience Engineer and Team Lead".repeat(
            2,
          ),
      },
    ],
    ["a summary", { ...JANE, summary: "I build calm, accessible web apps. I also mentor juniors." }],
  ])("stays within 40 to 90 words with %s", (_, profile) => {
    const text = composeRecruiterMessage(profile as Profile, { title: "Engineer", company: "Hooli" }, "Pat");
    expect(words(text)).toBeGreaterThanOrEqual(MESSAGE_MIN_WORDS);
    expect(words(text)).toBeLessThanOrEqual(MESSAGE_MAX_WORDS);
  });

  it("knows one person whatever shape the link has", () => {
    expect(normalizeProfileUrl("https://linkedin.com/in/Pat-Recruiter-Example/?trk=x")).toBe(
      "https://www.linkedin.com/in/pat-recruiter-example",
    );
    expect(normalizeProfileUrl("https://evil.example/in/pat")).toBe(undefined);
    expect(normalizeProfileUrl("https://www.linkedin.com/company/hooli")).toBe(undefined);
  });
});

describe("asking first", () => {
  it("is off by default and needs LinkedIn mode plus its own yes", () => {
    const base = Config.parse({});
    expect(messagesEnabled(base)).toBe(false);
    expect(turnOnMessages(base, { accept: true })).toMatchObject({
      ok: false,
      error: "Turn on LinkedIn mode first.",
    });
    const li = Config.parse({ sources: { linkedin: true }, linkedin: { acceptedAt: AT } });
    expect(turnOnMessages(li, { accept: false }).ok).toBe(false);
    const on = turnOnMessages(li, { accept: true, at: new Date(AT) });
    expect(on.ok && on.config.linkedin.messages).toMatchObject({ enabled: true, acceptedAt: AT });
    expect(on.ok && messagesEnabled(on.config)).toBe(true);
    expect(declineMessages(li, new Date(AT)).linkedin.messages).toMatchObject({
      enabled: false,
      declinedAt: AT,
    });
    expect(on.ok && messagesEnabled(turnOffMessages(on.config))).toBe(false);
  });

  it("caps at 10 a day", () => {
    expect(() => Config.parse({ linkedin: { messages: { perDay: 11 } } })).toThrow();
    expect(Config.parse({}).linkedin.messages.perDay).toBe(3);
  });
});

describe("drafts and the rules", () => {
  it("writes nothing while messages are off", () => {
    const { db, app } = submittedLinkedInApp();
    expect(draftMessage(db, Config.parse({}), JANE, app, PAT).status).toBe("none");
    expect(messagesFor(db, app.id)).toEqual([]);
  });

  it("never sends in dry run: the draft is kept for you to read", () => {
    const { db, app } = submittedLinkedInApp();
    expect(draftMessage(db, cfg({ dryRun: true }), JANE, app, PAT).status).toBe("dry_run");
  });

  it("waits for your OK on the first ones, bound to the exact text", () => {
    const { db, app } = submittedLinkedInApp();
    const r = draftMessage(db, cfg({ limits: { reviewFirst: 10 } }), JANE, app, PAT);
    expect(r.status).toBe("awaiting_review");
    const m = messagesFor(db, app.id)[0]!;
    expect(() => approveMessage(db, m.id, "0".repeat(32))).toThrow("changed");
    expect(approveMessage(db, m.id, m.hash)).toMatchObject({ status: "approved", approved_hash: m.hash });
  });

  it("one message per person, ever, a daily cap, the do-not-contact list and the LinkedIn stop", () => {
    const { db, p, app, id } = submittedLinkedInApp();
    const config = cfg({
      linkedin: { acceptedAt: AT, messages: { enabled: true, acceptedAt: AT, perDay: 1 } },
    });
    const desk = new Desk(db, config, JANE, p, id);
    expect(draftMessage(db, config, JANE, app, PAT).status).toBe("approved");
    const first = messagesFor(db, id)[0]!;
    const prep = desk.prepareMessage({ messageId: first.id });
    expect(prep).toMatchObject({ send: true, text: first.text });
    desk.recordMessage({ messageId: first.id, outcome: "sent", note: "Message sent" });

    // Same person under another link shape: refused, ever.
    const again = draftMessage(db, cfg(), JANE, app, {
      ...PAT,
      profileUrl: "https://linkedin.com/in/PAT-recruiter-example",
    });
    expect(again).toMatchObject({ status: "refused" });
    expect(again.reason).toContain("one message per person");
    // Another person, but today's cap of 1 is used.
    expect(
      draftMessage(db, config, JANE, app, {
        name: "Sam Hiring",
        profileUrl: "https://www.linkedin.com/in/sam-example",
      }).reason,
    ).toContain("limit");
    // Do-not-contact.
    const dnc = cfg({ doNotContact: ["Lee Manager"] });
    expect(
      draftMessage(db, dnc, JANE, app, { name: "Lee Manager", profileUrl: "https://www.linkedin.com/in/lee" })
        .reason,
    ).toContain("do-not-contact");
    // LinkedIn stopped after a warning.
    stopLinkedIn(db, "unusual activity", id);
    expect(
      draftMessage(db, cfg(), JANE, app, { name: "Kim", profileUrl: "https://www.linkedin.com/in/kim" })
        .reason,
    ).toContain("stopped");
  });

  it("the message run can only send approved text, and stops on a warning", () => {
    const { db, p, app, id } = submittedLinkedInApp();
    const config = cfg();
    const desk = new Desk(db, config, JANE, p, id);
    draftMessage(db, config, JANE, app, PAT);
    const m = messagesFor(db, id)[0]!;
    // Tampered text after the OK: not sent, back to review.
    db.prepare("UPDATE messages SET text = text || ' Please call me.' WHERE id = ?").run(m.id);
    expect(desk.prepareMessage({ messageId: m.id })).toMatchObject({ send: false });
    expect(messagesFor(db, id)[0]!.status).toBe("awaiting_review");
    // A sent result without prepare_message is refused.
    expect(() => desk.recordMessage({ messageId: m.id, outcome: "sent", note: "ok" })).toThrow();
    // A warning while trying stops LinkedIn mode.
    desk.recordMessage({
      messageId: m.id,
      outcome: "failed",
      note: "You've reached the weekly invitation limit",
    });
    expect(desk.prepareMessage({ messageId: m.id })).toMatchObject({ send: false });
  });
});

describe("on the LinkedIn fixture", () => {
  it("reports the hiring team but writes only a dry-run draft, and opens no message run", async () => {
    const p = makeHome({
      ...cfg({ provider: "fake", safety: { alwaysAsk: [] } }),
    });
    const db = openDb(p);
    const url = pathToFileURL(join(import.meta.dirname, "../fixtures/linkedin/easy-apply.html")).toString();
    const id = addApplication(db, {
      company: "LinkedIn job",
      title: "LinkedIn job 1",
      url,
      ats: "linkedin",
      source: "linkedin",
    }).id;
    db.close();
    await runOnce({ p, fetcher: fixtureFetcher, pace: { sleep: async () => {}, random: () => 0.5 } });
    const db2 = openDb(p);
    const drafts = messagesFor(db2, id);
    expect(drafts.map((d) => [d.recipient_name, d.status])).toEqual([["Pat Recruiter", "dry_run"]]);
    expect(drafts[0]!.profile_url).toBe("https://www.linkedin.com/in/pat-recruiter-example");
  });
});
