import { loadConfig, saveConfig } from "../core/config.js";
import { ensureHome, paths } from "../core/paths.js";
import {
  FIRST_PORT,
  findTailscale,
  PORTS_TO_TRY,
  pickPort,
  servedOn,
  serveOff,
  serveOn,
  serveStatus,
  tailscaleState,
} from "../phone/tailscale.js";

export const INSTALL_STEPS = [
  "Phone access uses Tailscale: a private network between your devices. Nothing is opened to the internet.",
  "",
  "1. Install Tailscale on this Mac:  https://tailscale.com/download   (or: brew install --cask tailscale)",
  "2. Open it and sign in with Google, Microsoft, GitHub or Apple. It is free for personal use.",
  "3. Install the Tailscale app on your phone and sign in with the same account.",
  "4. In the Tailscale admin page, turn on MagicDNS and HTTPS Certificates:  https://login.tailscale.com/admin/dns",
  "5. Run  quietapply phone  again.",
  "",
  "More: docs/phone.md",
];

export interface PhoneResult {
  ok: boolean;
  lines: string[];
}

/** `quietapply phone`: serve the dashboard on the tailnet only, and say what to open on the phone. */
export async function phoneOn(o: { port?: number; bin?: string | null } = {}): Promise<PhoneResult> {
  const p = ensureHome(paths());
  const config = loadConfig(p);
  const port = o.port ?? config.dashboard.port;
  const bin = o.bin === undefined ? findTailscale() : (o.bin ?? undefined);
  const ts = await tailscaleState(bin);
  if (ts.state === "missing")
    return { ok: false, lines: ["Tailscale is not installed on this Mac.", "", ...INSTALL_STEPS] };
  if (ts.state === "logged_out")
    return {
      ok: false,
      lines: [
        `Tailscale is installed but not signed in (${ts.detail}).`,
        "Open the Tailscale app, sign in, then run  quietapply phone  again.",
      ],
    };
  if (!bin) throw new Error("unreachable");

  const logins = new Set(config.phone.allowedLogins.map((l) => l.toLowerCase()));
  const lines: string[] = [];
  if (!logins.size) {
    if (!ts.login)
      return {
        ok: false,
        lines: [
          "Could not tell which Tailscale account you are. Put your login (an email address) in config.yaml:",
          "  phone:",
          "    allowedLogins: [you@example.com]",
        ],
      };
    config.phone.allowedLogins = [ts.login];
    lines.push(
      `Only this Tailscale login can open it: ${ts.login} (change phone.allowedLogins in config.yaml).`,
    );
  }

  const httpsPort = await pickPort(bin, ts.host, config.phone.httpsPort, port);
  if (httpsPort === undefined)
    return {
      ok: false,
      lines: [
        `HTTPS ports ${FIRST_PORT} to ${FIRST_PORT + PORTS_TO_TRY - 1} are all used by other Tailscale Serve settings, so QuietApply left them alone.`,
        "Set phone.httpsPort in config.yaml to any free port, then run this again. tailscale serve status shows which ports are taken.",
      ],
    };
  if (httpsPort !== config.phone.httpsPort) {
    lines.push(`Port ${config.phone.httpsPort} is used by something else, so QuietApply uses ${httpsPort}.`);
    config.phone.httpsPort = httpsPort;
  }
  const res = await serveOn(bin, ts.host, httpsPort, port);
  if (!res.ok) {
    return {
      ok: false,
      lines: [
        res.error,
        ...(res.error.toLowerCase().includes("https")
          ? [
              "",
              "If it says HTTPS is not enabled: turn on HTTPS Certificates at https://login.tailscale.com/admin/dns",
            ]
          : []),
      ],
    };
  }
  config.phone.host = ts.host;
  saveConfig(config, p);

  const up = await fetch(`http://127.0.0.1:${port}/api/summary`, {
    headers: { host: `127.0.0.1:${port}` },
    signal: AbortSignal.timeout(1500),
  })
    .then((r) => r.ok)
    .catch(() => false);
  return {
    ok: true,
    lines: [
      "Phone access is on (your tailnet only, never public).",
      "",
      `  ${res.url}`,
      "",
      "Open that address on your phone while Tailscale is on, then Share → Add to Home Screen.",
      ...lines,
      ...(up
        ? []
        : ["", `The dashboard is not running yet. Start it with  quietapply dashboard  (port ${port}).`]),
      "Turn it off again with  quietapply phone off",
    ],
  };
}

/** `quietapply phone off`: remove our mapping only. */
export async function phoneOff(o: { port?: number; bin?: string | null } = {}): Promise<PhoneResult> {
  const p = ensureHome(paths());
  const config = loadConfig(p);
  const port = o.port ?? config.dashboard.port;
  const bin = o.bin === undefined ? findTailscale() : (o.bin ?? undefined);
  const ts = await tailscaleState(bin);
  if (ts.state !== "ready" || !bin) {
    // Tailscale is gone or signed out, so nothing can be served; forget our host so the dashboard refuses it.
    config.phone.host = undefined;
    saveConfig(config, p);
    return {
      ok: true,
      lines: ["Tailscale is not running, so nothing is being served. Phone access is off."],
    };
  }
  const was = servedOn(await serveStatus(bin), ts.host, config.phone.httpsPort);
  if (was && was.target !== `http://127.0.0.1:${port}`)
    return {
      ok: false,
      lines: [
        `HTTPS port ${config.phone.httpsPort} serves something that is not QuietApply (${was.target}), so it was left alone.`,
      ],
    };
  if (was) {
    const r = await serveOff(bin, config.phone.httpsPort, port);
    if (!r.ok) return { ok: false, lines: [`tailscale could not switch it off: ${r.out}`] };
  }
  config.phone.host = undefined;
  saveConfig(config, p);
  return { ok: true, lines: ["Phone access is off. Your other Tailscale Serve settings were not touched."] };
}
