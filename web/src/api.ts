export type AppStatus =
  | "queued"
  | "skipped"
  | "in_progress"
  | "needs_answers"
  | "awaiting_review"
  | "submitting"
  | "submitted"
  | "dry_run"
  | "blocked"
  | "failed"
  | "unclear";

export interface Application {
  id: number;
  company: string;
  title: string;
  url: string;
  ats: string;
  location: string | null;
  source: string;
  status: AppStatus;
  reason: string | null;
  blocked_category: string | null;
  evidence: string | null;
  review_approved: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  openQuestions?: number;
}

export interface AppDetail extends Application {
  events: { status: string; note: string | null; at: string }[];
  questions: Question[];
}

export interface Question {
  id: number;
  question: string;
  context: string | null;
  options: string[];
  field_type: string;
  status: "open" | "answered" | "dismissed";
  answer: string | null;
  created_at: string;
  answered_at: string | null;
  applications: { id: number; company: string; title: string }[];
}

export interface Answer {
  id: number;
  key: string | null;
  question: string;
  aliases: string[];
  answer: string;
  scope: "global" | "company" | "ats";
  scope_value: string | null;
  sensitive: boolean;
  source: string;
  updated_at: string;
  uses: number;
}

export interface Run {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  provider: string;
  dry_run: number;
  trigger: string;
  summary: string | null;
}

export type HandoffReason =
  | "captcha"
  | "login_required"
  | "unknown_question"
  | "file_upload"
  | "unsupported_ats"
  | "external_redirect"
  | "linkedin_limit"
  | "fit_gate"
  | "cap"
  | "form_error"
  | "unclear_submit"
  | "other";

export interface Handoff {
  id: number;
  reason: HandoffReason;
  label: string;
  help: string;
  detail: string;
  needed: string;
  rule: string | null;
  filled: { field: string; value: string; source?: string }[];
  state: string;
  needsYou: boolean;
  canRetry: boolean;
  retryBlocker: string | null;
  created_at: string;
  application: { id: number; company: string; title: string; url: string; ats: string; status: AppStatus };
  questions: string[];
  /** Your own details (name, email, links) to paste into the form. */
  mine: { label: string; value: string }[];
}

export interface Summary {
  today: { done: number; couldnt: number; needYou: number };
  handoffs: { open: number; needYou: number };
  profileName: string;
  provider: string;
  browser: string;
  dryRun: boolean;
  paused: boolean;
  running: boolean;
  reviewMode: boolean;
  reviewFirst: number;
  perDay: number;
  submittedToday: number;
  remainingToday: number;
  openQuestions: number;
  counts: Record<AppStatus, number>;
  schedule: string[];
  scheduleInstalled: boolean;
  lastRun: Run | null;
  companies: number;
}

export interface Settings {
  config: {
    provider: string;
    auth: string;
    browser: string;
    dryRun: boolean;
    schedule: string[];
    timezone: string;
    limits: { perDay: number; perCompany30d: number; reviewFirst: number; runTimeoutMinutes: number };
    sources: Record<string, boolean>;
    companies: { name: string; ats: string; token: string }[];
    rules: {
      roles: string[];
      excludeTitles: string[];
      locations: string[];
      neverApply: string[];
      minSkillMatch: number;
    };
  };
  profile: { name: string; email: string; location: string; resumeFile?: string };
  home: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-quietapply": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  summary: () => request<Summary>("GET", "/api/summary"),
  applications: (status?: string) =>
    request<Application[]>("GET", `/api/applications${status ? `?status=${status}` : ""}`),
  application: (id: number) => request<AppDetail>("GET", `/api/applications/${id}`),
  act: (id: number, action: "approve" | "requeue" | "dismiss") =>
    request<Application>("POST", `/api/applications/${id}/${action}`),
  handoffs: () => request<Handoff[]>("GET", "/api/handoffs"),
  handoffAct: (id: number, action: "applied" | "not_interested" | "retry") =>
    request<Handoff>("POST", `/api/handoffs/${id}/${action}`),
  questions: (status: "open" | "answered" = "open") =>
    request<Question[]>("GET", `/api/questions?status=${status}`),
  answer: (id: number, answer: string, scope: "global" | "company") =>
    request<{ memoryId: number; released: number[] }>("POST", `/api/questions/${id}/answer`, {
      answer,
      scope,
    }),
  dismissQuestion: (id: number) => request("POST", `/api/questions/${id}/dismiss`),
  memory: () => request<Answer[]>("GET", "/api/memory"),
  updateMemory: (id: number, answer: string) => request<Answer>("PUT", `/api/memory/${id}`, { answer }),
  deleteMemory: (id: number) => request("DELETE", `/api/memory/${id}`),
  runs: () => request<Run[]>("GET", "/api/runs"),
  runNow: () => request<{ started: boolean }>("POST", "/api/run"),
  pause: (paused: boolean) => request<{ paused: boolean }>("POST", "/api/pause", { paused }),
  discover: () => request<{ found: number; added: number }>("POST", "/api/discover"),
  settings: () => request<Settings>("GET", "/api/settings"),
  saveSettings: (s: unknown) => request<{ config: Settings["config"] }>("PUT", "/api/settings", s),
};
