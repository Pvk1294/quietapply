import { accessSync, constants } from "node:fs";
import { delimiter, join, win32 } from "node:path";
import { run } from "../providers/spawn.js";

/** Where the Tailscale CLI lives on macOS when it is not on PATH (the app bundle's binary is the CLI). */
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

const isExecutable = (f: string) => {
  try {
    accessSync(f, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** QUIETAPPLY_TAILSCALE_BIN (tests use a fake), then PATH, then the macOS app or the Windows install folder. */
export function findTailscale(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  exists: (f: string) => boolean = isExecutable,
): string | undefined {
  if (env.QUIETAPPLY_TAILSCALE_BIN) return env.QUIETAPPLY_TAILSCALE_BIN;
  const win = platform === "win32";
  const pathJoin = win ? win32.join : join;
  for (const dir of (env.PATH ?? env.Path ?? "").split(win ? ";" : delimiter).filter(Boolean)) {
    const f = pathJoin(dir, win ? "tailscale.exe" : "tailscale");
    if (exists(f)) return f;
  }
  if (platform === "darwin" && exists(MAC_APP_CLI)) return MAC_APP_CLI;
  if (win) {
    // The Windows installer puts the CLI next to the app but does not always add it to PATH.
    const f = win32.join(env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe");
    if (exists(f)) return f;
  }
  return undefined;
}

export type TailscaleState =
  | { state: "missing" }
  | { state: "logged_out"; detail: string }
  | { state: "ready"; host: string; login: string; ip?: string };

interface StatusJson {
  BackendState?: string;
  Self?: { DNSName?: string; UserID?: number; TailscaleIPs?: string[] };
  User?: Record<string, { LoginName?: string }>;
}

async function tailscale(bin: string, args: string[]) {
  // Every command goes through here, so this is the one place to guarantee Funnel is never used.
  if (args.some((a) => /funnel/i.test(a)))
    throw new Error("Funnel is never used: it would make the dashboard public");
  return run(bin, args, { timeoutMs: 30_000 });
}

/** Whether Tailscale is installed and signed in, and who this Mac is on the tailnet. */
export async function tailscaleState(bin: string | undefined): Promise<TailscaleState> {
  if (!bin) return { state: "missing" };
  let r: Awaited<ReturnType<typeof run>>;
  try {
    r = await tailscale(bin, ["status", "--json"]);
  } catch {
    return { state: "missing" };
  }
  let s: StatusJson;
  try {
    s = JSON.parse(r.stdout) as StatusJson;
  } catch {
    return {
      state: "logged_out",
      detail: (r.stderr || r.stdout).trim().split("\n")[0] || "no answer from tailscaled",
    };
  }
  if (s.BackendState !== "Running" || !s.Self?.DNSName)
    return { state: "logged_out", detail: `Tailscale is ${s.BackendState ?? "not running"}` };
  const login = s.User?.[String(s.Self.UserID)]?.LoginName ?? "";
  return {
    state: "ready",
    host: s.Self.DNSName.replace(/\.$/, ""),
    login,
    ip: s.Self.TailscaleIPs?.[0],
  };
}

interface ServeStatus {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

export async function serveStatus(bin: string): Promise<ServeStatus> {
  const r = await tailscale(bin, ["serve", "status", "--json"]);
  try {
    return (JSON.parse(r.stdout || "{}") as ServeStatus) ?? {};
  } catch {
    return {};
  }
}

/** What is served on one HTTPS port of this node: "" when nothing, else the proxy target or a description. */
export function servedOn(
  st: ServeStatus,
  host: string,
  port: number,
): { target: string; funnel: boolean } | undefined {
  const key = `${host}:${port}`;
  const web = st.Web?.[key];
  if (!web && !st.TCP?.[String(port)]) return undefined;
  const target = Object.values(web?.Handlers ?? {})
    .map((h) => h.Proxy ?? h.Path ?? h.Text ?? "")
    .join(",");
  return { target, funnel: !!st.AllowFunnel?.[key] };
}

export const targetFor = (dashboardPort: number) => `http://127.0.0.1:${dashboardPort}`;

/** The address to open on the phone. */
export const phoneUrl = (host: string, httpsPort: number) =>
  `https://${host}${httpsPort === 443 ? "" : `:${httpsPort}`}`;

/**
 * Publish the dashboard on the tailnet only: `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`.
 * Refuses to replace something else on that port, and undoes itself if the port turns out to be on Funnel.
 */
export async function serveOn(
  bin: string,
  host: string,
  httpsPort: number,
  dashboardPort: number,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const target = targetFor(dashboardPort);
  const before = servedOn(await serveStatus(bin), host, httpsPort);
  if (before?.funnel)
    return {
      ok: false,
      error: `Port ${httpsPort} is public (Funnel). Turn that off first: it is not touched here.`,
    };
  if (before && before.target !== target)
    return {
      ok: false,
      error: `HTTPS port ${httpsPort} already serves something else (${before.target || "another service"}). Pick another port with phone.httpsPort in config.yaml (any free port works).`,
    };
  const r = await tailscale(bin, ["serve", "--bg", `--https=${httpsPort}`, target]);
  const out = `${r.stdout}\n${r.stderr}`.trim();
  if (r.code !== 0)
    return {
      ok: false,
      error: out.split("\n").slice(0, 4).join(" ") || `tailscale serve exited with ${r.code}`,
    };
  const after = servedOn(await serveStatus(bin), host, httpsPort);
  if (after?.funnel) {
    await serveOff(bin, httpsPort, dashboardPort);
    return { ok: false, error: "Tailscale reports this port as public (Funnel). It was switched off again." };
  }
  return { ok: true, url: phoneUrl(host, httpsPort) };
}

/** Undo only our own mapping: the same flags plus `off`, nothing else on the node is reset. */
export async function serveOff(bin: string, httpsPort: number, dashboardPort: number) {
  const r = await tailscale(bin, ["serve", `--https=${httpsPort}`, targetFor(dashboardPort), "off"]);
  return { ok: r.code === 0, out: `${r.stdout}\n${r.stderr}`.trim() };
}

/** Serve takes any free HTTPS port (only Funnel is limited to 443, 8443 and 10000), so look this far up from 8443. */
export const FIRST_PORT = 8443;
export const PORTS_TO_TRY = 100;

/**
 * The first HTTPS port Serve may use that is free or already ours: the configured one, then 8443, 8444, …
 * Undefined when the configured port and all of 8443 to 8542 are taken by something else.
 */
export async function pickPort(bin: string, host: string, preferred: number, dashboardPort: number) {
  const st = await serveStatus(bin);
  const ports = [preferred, ...Array.from({ length: PORTS_TO_TRY }, (_, i) => FIRST_PORT + i)];
  for (const port of new Set(ports)) {
    const used = servedOn(st, host, port);
    if (!used || (used.target === targetFor(dashboardPort) && !used.funnel)) return port;
  }
  return undefined;
}
