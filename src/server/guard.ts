import { loadConfig } from "../core/config.js";
import type { Paths } from "../core/paths.js";

export type Access =
  | { ok: true; kind: "local"; host: string }
  | { ok: true; kind: "tailnet"; host: string; login: string }
  | { ok: false; status: 403; why: string };

const normHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");

/**
 * Who may talk to the dashboard.
 *
 * - `127.0.0.1:<port>` and `localhost:<port>`: you, on this Mac. Nothing else is needed.
 * - The tailnet host name from `quietapply phone` (reached through `tailscale serve`, which proxies to
 *   127.0.0.1): only if the request carries a `Tailscale-User-Login` that is in `phone.allowedLogins`.
 *   Serve sets that header itself and removes any copy a client sends; Funnel traffic never carries it. An
 *   empty list lets nobody in, and so does a missing header, so a stray request fails closed.
 * - Any other Host header is refused (DNS rebinding).
 */
export function checkAccess(
  headers: { host?: string; login?: string },
  o: { p: Paths; port: number },
): Access {
  const host = normHost(headers.host ?? "");
  if (host === `127.0.0.1:${o.port}` || host === `localhost:${o.port}`)
    return { ok: true, kind: "local", host };

  let phone: ReturnType<typeof loadConfig>["phone"];
  try {
    phone = loadConfig(o.p).phone;
  } catch {
    return { ok: false, status: 403, why: "Forbidden host" };
  }
  if (!phone.host) return { ok: false, status: 403, why: "Forbidden host" };
  const want = normHost(phone.host);
  const [name, port, ...rest] = host.split(":");
  // Browsers leave out the port for 443; Serve on another port keeps it in the Host header.
  const portOk = port === undefined || port === "443" || port === String(phone.httpsPort);
  if (name !== want || rest.length || !portOk) return { ok: false, status: 403, why: "Forbidden host" };

  const login = (headers.login ?? "").trim().toLowerCase();
  const allowed = phone.allowedLogins.map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (!login || !allowed.includes(login))
    return {
      ok: false,
      status: 403,
      why: "This Tailscale account is not allowed. Add it to phone.allowedLogins in config.yaml.",
    };
  return { ok: true, kind: "tailnet", host, login };
}

/** The origin a write must come from: our own host, over http (local) or https (tailnet). */
export function originAllowed(origin: string, access: Extract<Access, { ok: true }>): boolean {
  const o = origin.trim().toLowerCase();
  if (access.kind === "local") return o === `http://${access.host}`;
  const stripped = o.replace(/^https:\/\//, "");
  return o.startsWith("https://") && normHost(stripped) === access.host;
}
