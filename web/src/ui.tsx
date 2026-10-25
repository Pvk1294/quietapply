import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { AppStatus } from "./api";

export const STATUS: Record<
  AppStatus,
  { label: string; tone: "gray" | "blue" | "green" | "amber" | "red" | "violet" }
> = {
  queued: { label: "Queued", tone: "gray" },
  skipped: { label: "Skipped", tone: "gray" },
  in_progress: { label: "Working", tone: "blue" },
  needs_answers: { label: "Needs you", tone: "amber" },
  awaiting_review: { label: "Review", tone: "violet" },
  submitting: { label: "Submitting", tone: "blue" },
  submitted: { label: "Applied", tone: "green" },
  dry_run: { label: "Dry run", tone: "blue" },
  blocked: { label: "Finish yourself", tone: "amber" },
  failed: { label: "Failed", tone: "red" },
  unclear: { label: "Check", tone: "red" },
};

export const BLOCKED_LABEL: Record<string, string> = {
  captcha: "CAPTCHA or human check",
  human_only: "Video, test or essay",
  email_only: "Apply by email",
  account_required: "Needs an account",
  otp: "Code sent to you",
  file_upload_form: "Special upload form",
  site_error: "Site error",
  no_ai_policy: "Posting says no AI",
  missing_data: "Missing information",
  other: "Other",
};

export function Pill({ status }: { status: AppStatus }) {
  const s = STATUS[status] ?? { label: status, tone: "gray" };
  return <span className={`pill pill-${s.tone}`}>{s.label}</span>;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

export function Avatar({ name }: { name: string }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      className="avatar"
      style={{ background: `hsl(${hue} 70% 94%)`, color: `hsl(${hue} 45% 35%)` }}
      aria-hidden="true"
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** Fetch now and every `ms` while the tab is visible. */
export function usePoll<T>(
  load: () => Promise<T>,
  ms = 5000,
): { data: T | undefined; error: string; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => {
    loadRef
      .current()
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    reload();
    const t = setInterval(() => document.visibilityState === "visible" && reload(), ms);
    return () => clearInterval(t);
  }, [reload, ms]);
  return { data, error, reload };
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

let pushToast: ((msg: string) => void) | undefined;
export const toast = (msg: string) => pushToast?.(msg);

export function Toaster() {
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    pushToast = (m) => {
      setMsg(m);
      clearTimeout(t);
      t = setTimeout(() => setMsg(""), 3200);
    };
    return () => {
      pushToast = undefined;
    };
  }, []);
  return (
    <div className={`toast ${msg ? "show" : ""}`} role="status" aria-live="polite">
      {msg}
    </div>
  );
}
