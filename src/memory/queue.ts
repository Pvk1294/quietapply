import type { DB } from "../core/db.js";
import { now } from "../core/db.js";
import { closeHandoffs } from "../core/handoffs.js";
import {
  getApplication,
  getQuestion,
  openQuestionsFor,
  type Question,
  questionApplications,
  setStatus,
} from "../core/store.js";
import { type Answer, keyForQuestion, type Scope, saveAnswer } from "./answers.js";

export interface AnswerInput {
  answer: string;
  /** "global" = remember for every application; "company" = only for the company that asked. */
  scope?: Scope;
}

/**
 * Answer a queued question: store it in the answer memory and release every application that was only
 * waiting on this question, so the next run picks them up again.
 */
export function answerQuestion(
  db: DB,
  questionId: number,
  input: AnswerInput,
): { question: Question; memory: Answer; released: number[] } {
  const q = getQuestion(db, questionId);
  if (!q) throw new Error(`No question ${questionId}`);
  if (q.status !== "open") throw new Error(`Question ${questionId} is already ${q.status}`);
  const text = input.answer.trim();
  if (!text) throw new Error("The answer is empty");

  const appIds = questionApplications(db, questionId);
  const company = appIds.length ? getApplication(db, appIds[0]!)?.company : undefined;
  const scope = input.scope === "company" && company ? "company" : "global";
  const memory = saveAnswer(db, {
    key: keyForQuestion(q.question) ?? null,
    question: q.question,
    answer: text,
    type: q.field_type,
    scope,
    scopeValue: scope === "company" ? company : null,
    source: "you",
  });
  db.prepare(
    "UPDATE questions SET status = 'answered', answer = ?, memory_id = ?, answered_at = ? WHERE id = ?",
  ).run(text, memory.id, now(), questionId);

  const released: number[] = [];
  for (const appId of appIds) {
    const app = getApplication(db, appId);
    if (app?.status === "needs_answers" && openQuestionsFor(db, appId).length === 0) {
      setStatus(db, appId, "queued", { reason: "all questions answered" });
      closeHandoffs(db, appId, "resolved");
      released.push(appId);
    }
  }
  return { question: getQuestion(db, questionId)!, memory, released };
}

export function dismissQuestion(db: DB, questionId: number): void {
  db.prepare(
    "UPDATE questions SET status = 'dismissed', answered_at = ? WHERE id = ? AND status = 'open'",
  ).run(now(), questionId);
}
