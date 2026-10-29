import { beforeEach, describe, expect, it } from "vitest";
import { type DB, openMemoryDb } from "../src/core/db.js";
import { addApplication, askQuestion, getApplication, listQuestions, setStatus } from "../src/core/store.js";
import { sameQuestion } from "../src/core/text.js";
import {
  coreAnswers,
  keyForQuestion,
  lookupAnswer,
  relevantAnswers,
  saveAnswer,
} from "../src/memory/answers.js";
import { Profile } from "../src/memory/profile.js";
import { answerQuestion } from "../src/memory/queue.js";

const jane = Profile.parse({
  name: "Jane Doe",
  email: "jane.doe@example.com",
  phone: "+1 555 0100",
  location: "Springfield",
  links: {
    linkedin: "https://www.linkedin.com/in/jane-doe-example",
    github: "https://github.com/janedoe-example",
  },
  experience: [{ company: "Initech", title: "Software Engineer" }],
});

let db: DB;
beforeEach(() => {
  db = openMemoryDb();
});

describe("question matching", () => {
  it("treats a question with extra context as the same question", () => {
    expect(
      sameQuestion(
        "What is your notice period?",
        "What is your notice period? (the form needs a number of days)",
      ),
    ).toBe(true);
  });
  it("keeps templated questions about different companies apart", () => {
    expect(sameQuestion("Did you apply to the Acme role?", "Did you apply to the Globex role?")).toBe(false);
  });
  it("maps many wordings onto one standard key", () => {
    expect(keyForQuestion("How soon can you join?")).toBe("notice_period");
    expect(keyForQuestion("Earliest possible start date")).toBe("notice_period");
    expect(keyForQuestion("When are you available to start full-time?")).toBe("notice_period");
    expect(keyForQuestion("Degree")).toBe("highest_degree");
    expect(
      keyForQuestion("Will you now or in the future require sponsorship for employment visa status?"),
    ).toBe("sponsorship");
    expect(keyForQuestion("Are you legally authorized to work in the United States?")).toBe(
      "work_authorization",
    );
    expect(keyForQuestion("What's your favourite colour?")).toBeUndefined();
  });
});

describe("look-alike questions (found on a real Lever form)", () => {
  const notetaker =
    "As part of our interview process, we use AI notetakers to transcribe conversations for accuracy and efficiency. Please see our candidate privacy policy for more information on how we process your data.";

  it("does not answer 'How do you pronounce your name?' with the pronouns answer", () => {
    expect(keyForQuestion("Name Pronunciation | How do you pronounce your name?")).toBeUndefined();
    expect(keyForQuestion("What are your pronouns?")).toBe("pronouns");
    saveAnswer(db, { key: "pronouns", question: "Pronouns (optional)", answer: "I prefer not to answer" });
    expect(lookupAnswer(db, jane, "Name Pronunciation | How do you pronounce your name?").status).not.toBe(
      "known",
    );
  });

  it("does not treat consent to AI note-takers as privacy consent", () => {
    expect(keyForQuestion(notetaker)).toBeUndefined();
    expect(keyForQuestion("I agree to the privacy policy")).toBe("data_consent");
    saveAnswer(db, {
      key: "data_consent",
      question:
        "Do you agree to companies storing and processing your application data (privacy consent boxes)?",
      answer: "Yes",
    });
    expect(lookupAnswer(db, jane, notetaker).status).not.toBe("known");
  });
});

describe("answer memory", () => {
  it("answers profile fields from the profile", () => {
    const r = lookupAnswer(db, jane, "Email");
    expect(r).toMatchObject({ status: "known", memoryId: "profile:email", answer: "jane.doe@example.com" });
    expect(lookupAnswer(db, jane, "First Name")).toMatchObject({ answer: "Jane" });
    expect(lookupAnswer(db, jane, "LinkedIn Profile")).toMatchObject({ memoryId: "profile:linkedin" });
    expect(lookupAnswer(db, jane, "Who is your current or previous employer?")).toMatchObject({
      memoryId: "profile:current_company",
      answer: "Initech",
    });
    expect(lookupAnswer(db, jane, "What is your current or previous job title?")).toMatchObject({
      memoryId: "profile:current_title",
    });
  });

  it("finds a stored answer under a different wording and cites its id", () => {
    const saved = saveAnswer(db, {
      key: "notice_period",
      question: "What is your notice period?",
      answer: "30 days",
    });
    const r = lookupAnswer(db, jane, "When can you start?");
    expect(r).toMatchObject({ status: "known", memoryId: `mem:${saved.id}`, answer: "30 days" });
  });

  it("returns unknown instead of guessing", () => {
    saveAnswer(db, { key: "notice_period", question: "What is your notice period?", answer: "30 days" });
    expect(lookupAnswer(db, jane, "Describe your experience with Kubernetes operators").status).toBe(
      "unknown",
    );
  });

  it("prefers a company-only answer for that company and ignores it elsewhere", () => {
    saveAnswer(db, { key: "relocation", question: "Are you willing to relocate?", answer: "No" });
    saveAnswer(db, {
      key: "relocation",
      question: "Are you willing to relocate?",
      answer: "Yes, to Springfield",
      scope: "company",
      scopeValue: "Acme",
    });
    expect(lookupAnswer(db, jane, "Willing to relocate?", { company: "acme" })).toMatchObject({
      answer: "Yes, to Springfield",
    });
    expect(lookupAnswer(db, jane, "Willing to relocate?", { company: "Globex" })).toMatchObject({
      answer: "No",
    });
  });

  it("updates instead of duplicating an answer with the same key", () => {
    saveAnswer(db, { key: "notice_period", question: "What is your notice period?", answer: "30 days" });
    const b = saveAnswer(db, {
      key: "notice_period",
      question: "How soon can you join?",
      answer: "Immediately",
    });
    expect(b.answer).toBe("Immediately");
    expect(b.aliases).toContain("How soon can you join?");
    expect(db.prepare("SELECT COUNT(*) AS n FROM answers").get()).toEqual({ n: 1 });
  });

  it("builds a small relevant set rather than the whole memory", () => {
    saveAnswer(db, { key: "notice_period", question: "What is your notice period?", answer: "30 days" });
    saveAnswer(db, { key: "sponsorship", question: "Do you need sponsorship?", answer: "No" });
    saveAnswer(db, { key: "travel", question: "Willing to travel?", answer: "Up to 20%" });
    const rel = relevantAnswers(db, jane, ["Email", "When can you start?"]);
    expect(rel.map((r) => r.answer)).toEqual(["jane.doe@example.com", "30 days"]);
    expect(coreAnswers(db).map((a) => a.answer)).toEqual(["30 days", "No"]);
  });
});

describe("question queue", () => {
  it("dedupes open questions and releases every waiting application once answered", () => {
    const a = addApplication(db, { company: "Acme", title: "Engineer", url: "https://example.com/a" }).id;
    const b = addApplication(db, { company: "Globex", title: "Engineer", url: "https://example.com/b" }).id;
    setStatus(db, a, "needs_answers");
    setStatus(db, b, "needs_answers");
    const q1 = askQuestion(db, { applicationId: a, question: "What is your expected salary range?" });
    const q2 = askQuestion(db, { applicationId: b, question: "What is your expected salary range?" });
    expect(q2).toEqual({ id: q1.id, duplicate: true });
    expect(listQuestions(db)).toHaveLength(1);

    const res = answerQuestion(db, q1.id, { answer: "USD 100k-120k" });
    expect(res.released.sort()).toEqual([a, b].sort());
    expect(getApplication(db, a)?.status).toBe("queued");
    expect(res.memory.key).toBe("salary_expectation");
    expect(res.memory.sensitive).toBe(true);
    expect(lookupAnswer(db, jane, "Desired salary")).toMatchObject({ answer: "USD 100k-120k" });
  });

  it("can remember an answer for one company only", () => {
    const a = addApplication(db, { company: "Acme", title: "Engineer", url: "https://example.com/a" }).id;
    const q = askQuestion(db, { applicationId: a, question: "Why do you want to work at Acme?" });
    const res = answerQuestion(db, q.id, { answer: "I use Acme rockets daily.", scope: "company" });
    expect(res.memory).toMatchObject({ scope: "company", scope_value: "Acme" });
    expect(lookupAnswer(db, jane, "Why do you want to work at Acme?", { company: "Globex" }).status).not.toBe(
      "known",
    );
  });
});
