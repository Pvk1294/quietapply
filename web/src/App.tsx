import { useEffect, useState } from "react";
import { api, type Summary } from "./api";
import { Icon } from "./icons";
import { Applications } from "./pages/Applications";
import { Handoff } from "./pages/Handoff";
import { Memory } from "./pages/Memory";
import { Questions } from "./pages/Questions";
import { Runs } from "./pages/Runs";
import { Settings } from "./pages/Settings";
import { Today } from "./pages/Today";
import { STEPS, TOUR_KEY, Tour } from "./Tour";
import { Toaster, toast, usePoll } from "./ui";

const PAGES = [
  { id: "today", label: "Today", icon: Icon.today, mobile: true },
  { id: "applications", label: "Applications", icon: Icon.apps, mobile: true },
  { id: "questions", label: "Questions", icon: Icon.question, mobile: true },
  { id: "handoff", label: "Finish yourself", icon: Icon.hand, mobile: false },
  { id: "memory", label: "Memory", icon: Icon.memory, mobile: true },
  { id: "runs", label: "Runs", icon: Icon.runs, mobile: false },
  { id: "settings", label: "Settings", icon: Icon.settings, mobile: true },
] as const;
type PageId = (typeof PAGES)[number]["id"];

function readRoute(): [PageId, string] {
  const [path = "", query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const id = (PAGES.find((p) => p.id === path)?.id ?? "today") as PageId;
  return [id, query];
}

function useRoute(): [PageId, string] {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const on = () => {
      setRoute(readRoute());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function App() {
  const [page, query] = useRoute();
  const { data: summary, error, reload } = usePoll(api.summary, 4000);
  const title = PAGES.find((p) => p.id === page)?.label ?? "";
  // The tour opens by itself the first time, from "Help / Tour", or with ?tour=N in the address.
  const [tour, setTour] = useState<number | null>(() => {
    const n = Number(new URLSearchParams(location.hash.split("?")[1]).get("tour"));
    if (n >= 1 && n <= STEPS.length) return n - 1;
    return localStorage.getItem(TOUR_KEY) ? null : 0;
  });
  const closeTour = () => {
    localStorage.setItem(TOUR_KEY, "1");
    setTour(null);
  };

  useEffect(() => {
    document.title = summary?.openQuestions ? `(${summary.openQuestions}) QuietApply` : "QuietApply";
  }, [summary?.openQuestions]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/today">
          <Icon.logo />
          <span>QuietApply</span>
        </a>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={`nav-item ${page === p.id ? "active" : ""}`}>
              <p.icon />
              <span>{p.label}</span>
              <Badge page={p.id} summary={summary} />
            </a>
          ))}
        </nav>
        <button type="button" className="help-link nav-help" onClick={() => setTour(0)}>
          Help / Tour
        </button>
        <div className="sidebar-foot muted">
          {summary?.profileName ? `Applying as ${summary.profileName}` : "Not set up yet"}
          <br />
          Runs on{" "}
          {summary?.provider === "codex"
            ? "Codex"
            : summary?.provider === "fake"
              ? "demo agent"
              : "Claude Code"}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <a className="brand brand-mobile" href="#/today">
            <Icon.logo />
          </a>
          <h1>{title}</h1>
          <Controls summary={summary} reload={reload} />
        </header>
        {error && <div className="banner banner-red">Cannot reach QuietApply: {error}</div>}
        {summary?.linkedin?.stopped && (
          <div className="banner banner-red">
            <strong>LinkedIn mode is stopped.</strong> LinkedIn showed a warning. Look at your account, then
            resume it in <a href="#/settings">Settings</a>.
          </div>
        )}
        {summary?.dryRun && (
          <div className="banner banner-blue">
            <strong>Dry run is on.</strong> Forms are filled, nothing is submitted. Turn it off in{" "}
            <a href="#/settings">Settings</a> when you trust the setup.
          </div>
        )}
        <div className="content">
          {page === "today" && <Today summary={summary} />}
          {page === "applications" && <Applications query={query} />}
          {page === "questions" && <Questions onChange={reload} />}
          {page === "handoff" && <Handoff />}
          {page === "memory" && <Memory />}
          {page === "runs" && <Runs />}
          {page === "settings" && <Settings onChange={reload} />}
        </div>
      </main>

      <nav className="tabbar" aria-label="Sections">
        {PAGES.filter((p) => p.mobile).map((p) => (
          <a key={p.id} href={`#/${p.id}`} className={`tab ${page === p.id ? "active" : ""}`}>
            <span className="tab-icon">
              <p.icon />
              <Badge page={p.id} summary={summary} dot />
            </span>
            <span>{p.id === "applications" ? "Apps" : p.label}</span>
          </a>
        ))}
      </nav>
      <Toaster />
      {tour !== null && <Tour step={tour} onStep={setTour} onClose={closeTour} />}
    </div>
  );
}

function Badge({ page, summary, dot }: { page: PageId; summary?: Summary; dot?: boolean }) {
  const n =
    page === "questions"
      ? (summary?.openQuestions ?? 0)
      : page === "handoff"
        ? (summary?.counts.blocked ?? 0) + (summary?.counts.unclear ?? 0)
        : page === "applications"
          ? (summary?.counts.awaiting_review ?? 0)
          : 0;
  if (!n) return null;
  return dot ? <span className="dot" aria-hidden="true" /> : <span className="badge">{n}</span>;
}

function Controls({ summary, reload }: { summary?: Summary; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      reload();
    }
  };
  const paused = !!summary?.paused;
  return (
    <div className="controls">
      <span
        className={`state ${summary?.running ? "state-running" : paused ? "state-paused" : "state-idle"}`}
      >
        <span className="state-dot" />
        {summary?.running ? "Running" : paused ? "Paused" : "Idle"}
      </span>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={busy || !summary}
        onClick={() => act(() => api.pause(!paused), paused ? "Resumed" : "Paused: no new runs start")}
      >
        {paused ? <Icon.play /> : <Icon.pause />}
        <span className="hide-sm">{paused ? "Resume" : "Pause"}</span>
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || !summary || paused || summary.running}
        onClick={() => act(api.runNow, "Run started")}
      >
        <Icon.play />
        <span>Run now</span>
      </button>
    </div>
  );
}
