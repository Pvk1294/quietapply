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
  login_required: "Login or account needed",
  unknown_question: "A question with no answer yet",
  file_upload: "File upload problem",
  unsupported_ats: "Job site not supported yet",
  external_redirect: "Sent to another site or email",
  email_only: "Apply by email",
  suspicious_page: "Page talks to the AI",
  linkedin_limit: "LinkedIn limit or warning",
  fit_gate: "Did not pass your rules",
  cap: "Daily or per-company limit",
  form_error: "Form error",
  unclear_submit: "Unclear whether it was sent",
  other: "Something else",
};

/** Copy text to the clipboard; falls back to a hidden textarea where the Clipboard API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

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
