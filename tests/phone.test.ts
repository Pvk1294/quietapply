import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { phoneOff, phoneOn } from "../src/cli/phone.js";
import { loadConfig, saveConfig } from "../src/core/config.js";
import { createApp } from "../src/server/app.js";
import { checkAccess } from "../src/server/guard.js";
import { makeHome } from "./helpers/home.js";

const FAKE = join(import.meta.dirname, "helpers/fake-tailscale.mjs");
chmodSync(FAKE, 0o755);
const HOME_WAS = process.env.QUIETAPPLY_HOME;
afterEach(() => {
  if (HOME_WAS === undefined) delete process.env.QUIETAPPLY_HOME;
  else process.env.QUIETAPPLY_HOME = HOME_WAS;
});

function setup(state: Record<string, unknown> = {}) {
  const p = makeHome();
  process.env.QUIETAPPLY_HOME = p.home;
  const file = join(mkdtempSync(join(tmpdir(), "qa-ts-")), "state.json");
  writeFileSync(file, JSON.stringify(state));
  process.env.FAKE_TS_STATE = file;
  const read = () =>
    JSON.parse(readFileSync(file, "utf8")) as {
      calls: string[][];
      serve: { Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> };
    };
  return { p, read };
}

describe("quietapply phone (fake tailscale binary)", () => {
  it("prints install steps and runs nothing when Tailscale is missing", async () => {
    setup();
    const r = await phoneOn({ bin: null });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("tailscale.com/download");
    expect(r.lines.join("\n")).toContain("MagicDNS");
  });

  it("asks you to sign in when Tailscale is installed but logged out", async () => {
    const { read } = setup({ mode: "logged_out" });
    const r = await phoneOn({ bin: FAKE });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("not signed in");
    expect(read().calls.every((c) => c[0] === "status")).toBe(true);
  });

  it("serves the dashboard on the tailnet over HTTPS, never Funnel, and saves host and login", async () => {
    const { p, read } = setup();
    const r = await phoneOn({ bin: FAKE, port: 4777 });
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("https://my-mac.tail1234.ts.net:8443");
    const serve = read().calls.find((c) => c[0] === "serve" && c[1] !== "status")!;
    expect(serve).toEqual(["serve", "--bg", "--https=8443", "http://127.0.0.1:4777"]);
    expect(read().calls.flat().join(" ").toLowerCase()).not.toContain("funnel");
    const phone = loadConfig(p).phone;
    expect(phone).toMatchObject({ host: "my-mac.tail1234.ts.net", allowedLogins: ["jane.doe@example.com"] });
  });

  it("leaves other apps' Serve settings alone, and moves to a free port instead of taking over a busy one", async () => {
    const other = {
      Web: { "my-mac.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
      TCP: { "443": { HTTPS: true } },
      AllowFunnel: {},
    };
    const { read } = setup({ serve: other });
    expect((await phoneOn({ bin: FAKE })).ok).toBe(true);
    expect(read().serve.Web["my-mac.tail1234.ts.net:443"]?.Handlers["/"]?.Proxy).toBe(
      "http://127.0.0.1:3000",
    );

    const busy = setup({
      serve: {
        Web: { "my-mac.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
        TCP: { "8443": { HTTPS: true } },
        AllowFunnel: {},
      },
    });
    const r = await phoneOn({ bin: FAKE });
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("https://my-mac.tail1234.ts.net:8444");
    expect(busy.read().serve.Web["my-mac.tail1234.ts.net:8443"]?.Handlers["/"]?.Proxy).toBe(
      "http://127.0.0.1:9999",
    );
    expect(loadConfig(busy.p).phone.httpsPort).toBe(8444);
  });

  it("Serve takes any free port, not only Funnel's 443, 8443 and 10000", async () => {
    // Like a Mac that already serves other apps on 443, 8443, 8444, 8445 and 10000.
    const taken = [443, 8443, 8444, 8445, 10000];
    const serve = {
      Web: Object.fromEntries(
        taken.map((port, i) => [
          `my-mac.tail1234.ts.net:${port}`,
          { Handlers: { "/": { Proxy: `http://127.0.0.1:${9000 + i}` } } },
        ]),
      ),
      TCP: Object.fromEntries(taken.map((port) => [String(port), { HTTPS: true }])),
      AllowFunnel: {},
    };
    const { p, read } = setup({ serve });
    const r = await phoneOn({ bin: FAKE });
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("https://my-mac.tail1234.ts.net:8446");
    expect(loadConfig(p).phone.httpsPort).toBe(8446);
    for (const [i, port] of taken.entries())
      expect(read().serve.Web[`my-mac.tail1234.ts.net:${port}`]?.Handlers["/"]?.Proxy).toBe(
        `http://127.0.0.1:${9000 + i}`,
      );
  });

  it("switches itself off again if Tailscale reports the port as public", async () => {
    const { read } = setup({ funnelOnServe: true });
    const r = await phoneOn({ bin: FAKE });
    expect(r.ok).toBe(false);
    expect(read().serve.Web).toEqual({});
  });

  it("`phone off` removes only its own mapping", async () => {
    const other = {
      Web: { "my-mac.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
      TCP: { "443": { HTTPS: true } },
      AllowFunnel: {},
    };
    const { p, read } = setup({ serve: other });
    await phoneOn({ bin: FAKE });
    expect(Object.keys(read().serve.Web)).toHaveLength(2);
    const r = await phoneOff({ bin: FAKE });
    expect(r.ok).toBe(true);
    expect(Object.keys(read().serve.Web)).toEqual(["my-mac.tail1234.ts.net:443"]);
    expect(loadConfig(p).phone.host).toBeUndefined();
    expect(read().calls.some((c) => c.includes("reset"))).toBe(false);
  });
});

describe("host and CSRF checks for the tailnet", () => {
  const HOST = "my-mac.tail1234.ts.net:8443";
  function guarded(
    logins: string[] = ["jane.doe@example.com"],
    host: string | null = "my-mac.tail1234.ts.net",
  ) {
    const p = makeHome();
    const c = loadConfig(p);
    c.phone = { host: host ?? undefined, httpsPort: 8443, allowedLogins: logins };
    saveConfig(c, p);
    return { p, app: createApp({ p, port: 4777 }) };
  }
  const login = "tailscale-user-login";

  it("lets the allowed login in, and nobody else on the tailnet", () => {
    const { p } = guarded();
    const o = { p, port: 4777 };
    expect(checkAccess({ host: HOST, login: "jane.doe@example.com" }, o)).toMatchObject({
      ok: true,
      kind: "tailnet",
    });
    expect(checkAccess({ host: HOST, login: "JANE.doe@Example.com" }, o)).toMatchObject({ ok: true });
    expect(checkAccess({ host: HOST, login: "someone.else@example.com" }, o)).toMatchObject({ ok: false });
    expect(checkAccess({ host: HOST }, o)).toMatchObject({ ok: false });
    expect(
      checkAccess({ host: "other-mac.tail1234.ts.net:8443", login: "jane.doe@example.com" }, o),
    ).toMatchObject({ ok: false });
    expect(checkAccess({ host: "evil.example:4777", login: "jane.doe@example.com" }, o)).toMatchObject({
      ok: false,
    });
    expect(
      checkAccess({ host: "my-mac.tail1234.ts.net:9999", login: "jane.doe@example.com" }, o),
    ).toMatchObject({ ok: false });
  });

  it("fails closed with no allowed logins or no tailnet host configured", () => {
    expect(
      checkAccess({ host: HOST, login: "jane.doe@example.com" }, { p: guarded([]).p, port: 4777 }),
    ).toMatchObject({ ok: false });
    expect(
      checkAccess(
        { host: HOST, login: "jane.doe@example.com" },
        { p: guarded(undefined, null).p, port: 4777 },
      ),
    ).toMatchObject({ ok: false });
  });

  it("serves the dashboard API to the allowed login and enforces the CSRF header and origin", async () => {
    const { app } = guarded();
    const h = { host: HOST, [login]: "jane.doe@example.com" };
    expect((await app.request("/api/summary", { headers: h })).status).toBe(200);
    expect((await app.request("/api/summary", { headers: { host: HOST } })).status).toBe(403);
    expect((await app.request("/api/summary", { headers: { ...h, [login]: "x@example.com" } })).status).toBe(
      403,
    );
    const post = (extra: Record<string, string>) =>
      app.request("/api/pause", {
        method: "POST",
        headers: { ...h, "content-type": "application/json", ...extra },
        body: '{"paused":false}',
      });
    expect((await post({})).status).toBe(403);
    expect((await post({ "x-quietapply": "1", origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "x-quietapply": "1", origin: `http://${HOST}` })).status).toBe(403);
    expect((await post({ "x-quietapply": "1", origin: `https://${HOST}` })).status).toBe(200);
  });

  it("still accepts 127.0.0.1 with no Tailscale headers", async () => {
    const { app } = guarded();
    expect((await app.request("/api/summary", { headers: { host: "127.0.0.1:4777" } })).status).toBe(200);
    expect(
      (await app.request("/manifest.webmanifest", { headers: { host: "127.0.0.1:4777" } })).headers.get(
        "content-type",
      ),
    ).toContain("manifest+json");
  });
});

describe("Settings → Phone access API (fake tailscale binary)", () => {
  const LOCAL = { host: "127.0.0.1:4777", "x-quietapply": "1", "content-type": "application/json" };
  const TAILNET = {
    host: "my-mac.tail1234.ts.net:8443",
    "tailscale-user-login": "jane.doe@example.com",
    origin: "https://my-mac.tail1234.ts.net:8443",
    "x-quietapply": "1",
    "content-type": "application/json",
  };
  type Info = { tailscale: string; on: boolean; url?: string; canChange: boolean; allowedLogins: string[] };
  const call = async (
    app: ReturnType<typeof createApp>,
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) => {
    const r = await app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Info & { error?: string } };
  };

  it("says when Tailscale is missing or signed out, and offers no switch", async () => {
    const { p } = setup();
    const missing = await call(createApp({ p, port: 4777, tailscaleBin: null }), "GET", "/api/phone", LOCAL);
    expect(missing.json).toMatchObject({ tailscale: "missing", on: false });
    setup({ mode: "logged_out" });
    const out = await call(createApp({ p, port: 4777, tailscaleBin: FAKE }), "GET", "/api/phone", LOCAL);
    expect(out.json).toMatchObject({ tailscale: "logged_out", on: false });
  });

  it("switches on and off from the Mac only, never from the tailnet, and never uses Funnel", async () => {
    const { p, read } = setup();
    const app = createApp({ p, port: 4777, tailscaleBin: FAKE });
    expect((await call(app, "GET", "/api/phone", LOCAL)).json).toMatchObject({ on: false, canChange: true });

    const on = await call(app, "POST", "/api/phone", LOCAL, { on: true });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ on: true, url: "https://my-mac.tail1234.ts.net:8443" });
    expect(on.json.allowedLogins).toEqual(["jane.doe@example.com"]);
    expect(read().calls.flat().join(" ").toLowerCase()).not.toContain("funnel");

    // Opened on the phone: it sees the state, but cannot switch it or change who may open it.
    const seen = await call(app, "GET", "/api/phone", TAILNET);
    expect(seen.json).toMatchObject({ on: true, canChange: false });
    expect((await call(app, "POST", "/api/phone", TAILNET, { on: false })).status).toBe(403);
    expect((await call(app, "PUT", "/api/phone/logins", TAILNET, { logins: ["x@example.com"] })).status).toBe(
      403,
    );
    // A local host name with Tailscale's login header came through Serve: refused too.
    const sneaky = { ...LOCAL, "tailscale-user-login": "jane.doe@example.com" };
    expect((await call(app, "POST", "/api/phone", sneaky, { on: false })).status).toBe(403);
    expect((await call(app, "GET", "/api/phone", LOCAL)).json.on).toBe(true);

    const saved = await call(app, "PUT", "/api/phone/logins", LOCAL, {
      logins: [" Jane.Doe@Example.com ", "partner@example.com"],
    });
    expect(saved.json.allowedLogins).toEqual(["jane.doe@example.com", "partner@example.com"]);
    expect(loadConfig(p).phone.allowedLogins).toEqual(["jane.doe@example.com", "partner@example.com"]);

    const off = await call(app, "POST", "/api/phone", LOCAL, { on: false });
    expect(off.json).toMatchObject({ on: false });
    expect(read().serve.Web).toEqual({});
  });
});
