import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { addApplication, askQuestion, getApplication, setStatus } from "../src/core/store.js";
import { runFolder } from "../src/runner/evidence.js";
import { createApp } from "../src/server/app.js";
import { makeHome } from "./helpers/home.js";

const PORT = 4777;
const HOST = { host: `127.0.0.1:${PORT}` };
const WRITE = { ...HOST, "x-quietapply": "1", "content-type": "application/json" };

function setup() {
  const p = makeHome();
  const db = openDb(p);
  const a = addApplication(db, {
    company: "Acme Rockets",
    title: "Engineer",
    url: "https://example.com/a",
  }).id;
  setStatus(db, a, "needs_answers");
  const q = askQuestion(db, { applicationId: a, question: "What are your salary expectations?" }).id;
  const r = addApplication(db, { company: "Globex", title: "Developer", url: "https://example.com/b" }).id;
  setStatus(db, r, "awaiting_review", {
    evidence: JSON.stringify({
      filled: [{ field: "Email", value: "jane.doe@example.com", source: "profile:email" }],
    }),
  });
  db.close();
  let started = 0;
  const app = createApp({ p, port: PORT, startRun: () => started++ });
  return { p, app, a, q, r, started: () => started };
}

describe("dashboard API", () => {
  it("refuses other host names (DNS rebinding) and writes without the custom header (CSRF)", async () => {
    const { app } = setup();
    expect((await app.request("/api/summary", { headers: { host: "evil.example:4777" } })).status).toBe(403);
    const noHeader = await app.request("/api/pause", {
      method: "POST",
      headers: HOST,
      body: '{"paused":true}',
    });
    expect(noHeader.status).toBe(403);
    const crossOrigin = await app.request("/api/pause", {
      method: "POST",
      headers: { ...WRITE, origin: "https://evil.example" },
      body: '{"paused":true}',
    });
    expect(crossOrigin.status).toBe(403);
  });

  it("summarises status for the Today page", async () => {
    const { app } = setup();
    const s = (await (await app.request("/api/summary", { headers: HOST })).json()) as Record<
      string,
      unknown
    >;
    expect(s).toMatchObject({
      profileName: "Jane Doe",
      dryRun: true,
      openQuestions: 1,
      paused: false,
      perDay: 15,
    });
    expect((s.counts as Record<string, number>).awaiting_review).toBe(1);
  });

  it("answers a question and releases the application", async () => {
    const { app, a, q, p } = setup();
    const list = (await (await app.request("/api/questions", { headers: HOST })).json()) as {
      applications: unknown[];
    }[];
    expect(list[0]!.applications).toEqual([{ id: a, company: "Acme Rockets", title: "Engineer" }]);
    const res = await app.request(`/api/questions/${q}/answer`, {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify({ answer: "USD 120,000", scope: "company" }),
    });
    expect(await res.json()).toMatchObject({ released: [a] });
    const db = openDb(p);
    expect(getApplication(db, a)?.status).toBe("queued");
    const mem = (await (await app.request("/api/memory", { headers: HOST })).json()) as {
      scope: string;
      scope_value: string;
    }[];
    expect(mem.at(-1)).toMatchObject({ scope: "company", scope_value: "Acme Rockets" });
  });

  it("approves a reviewed application and refuses to approve others", async () => {
    const { app, a, r } = setup();
    const approve = (id: number, hash?: string) =>
      app.request(`/api/applications/${id}/approve`, {
        method: "POST",
        headers: WRITE,
        body: JSON.stringify(hash ? { hash } : {}),
      });
    // The OK must name the fingerprint of what the page showed.
    const shown = (await (await app.request(`/api/applications/${r}`, { headers: HOST })).json()) as {
      contentHash: string;
    };
    expect(shown.contentHash).toMatch(/^[0-9a-f]{32}$/);
    expect((await approve(r)).status).toBe(409);
    expect((await approve(r, "0".repeat(32))).status).toBe(409);
    expect((await approve(r, shown.contentHash)).status).toBe(200);
    expect((await approve(a)).status).toBe(400);
    const detail = (await (await app.request(`/api/applications/${r}`, { headers: HOST })).json()) as Record<
      string,
      unknown
    >;
    expect(detail).toMatchObject({ status: "queued", review_approved: 1, approved_hash: shown.contentHash });
  });

  it("pauses, blocks Run now while paused, and starts a run when resumed", async () => {
    const { app, p, started } = setup();
    await app.request("/api/pause", { method: "POST", headers: WRITE, body: '{"paused":true}' });
    expect(existsSync(p.pauseFlag)).toBe(true);
    expect((await app.request("/api/run", { method: "POST", headers: WRITE })).status).toBe(409);
    await app.request("/api/pause", { method: "POST", headers: WRITE, body: '{"paused":false}' });
    expect((await app.request("/api/run", { method: "POST", headers: WRITE })).status).toBe(200);
    expect(started()).toBe(1);
  });

  it("updates settings with validation", async () => {
    const { app } = setup();
    const bad = await app.request("/api/settings", {
      method: "PUT",
      headers: WRITE,
      body: '{"schedule":["9am"]}',
    });
    expect(bad.status).toBe(400);
    const ok = await app.request("/api/settings", {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ dryRun: false, limits: { perDay: 5 }, rules: { roles: ["engineer"] } }),
    });
    const { config } = (await ok.json()) as {
      config: {
        dryRun: boolean;
        limits: { perDay: number; reviewFirst: number };
        rules: { roles: string[] };
      };
    };
    expect(config).toMatchObject({
      dryRun: false,
      limits: { perDay: 5, reviewFirst: 10 },
      rules: { roles: ["engineer"] },
    });
  });

  it("shows the agent's screenshots for an application, and serves nothing outside its run folders", async () => {
    const { app, p, a, r } = setup();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    for (const [run, file] of [
      [1, "page-2026-10-28T07-00-00-000Z.png"],
      [2, "form.png"],
    ] as const) {
      mkdirSync(runFolder(p, run, a), { recursive: true });
      writeFileSync(`${runFolder(p, run, a)}/${file}`, png);
    }
    writeFileSync(`${runFolder(p, 2, a)}/transcript.jsonl`, "{}");
    writeFileSync(`${runFolder(p, 2, a)}/blocked-requests.jsonl`, '{"method":"POST"}\n{"method":"POST"}\n');
    mkdirSync(runFolder(p, 2, r), { recursive: true });
    writeFileSync(`${runFolder(p, 2, r)}/other.png`, png);

    const detail = (await (await app.request(`/api/applications/${a}`, { headers: HOST })).json()) as {
      screenshots: { run: number; file: string; url: string; blockedRequests: number }[];
    };
    expect(detail.screenshots.map((s) => s.file).sort()).toEqual([
      "form.png",
      "page-2026-10-28T07-00-00-000Z.png",
    ]);
    const form = detail.screenshots.find((s) => s.file === "form.png")!;
    expect(form).toMatchObject({ run: 2, blockedRequests: 2 });

    const img = await app.request(form.url, { headers: HOST });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer()).equals(png)).toBe(true);

    for (const bad of [
      `/api/applications/${a}/screenshots/2/transcript.jsonl`,
      `/api/applications/${a}/screenshots/2/other.png`,
      `/api/applications/${a}/screenshots/2/..%2F..%2Fapp-${r}%2Fother.png`,
      `/api/applications/${a}/screenshots/x/form.png`,
    ])
      expect((await app.request(bad, { headers: HOST })).status).toBe(404);

    const none = (await (await app.request(`/api/applications/${r}`, { headers: HOST })).json()) as {
      screenshots: unknown[];
    };
    expect(none.screenshots).toHaveLength(1);
  });
});

describe("starting the dashboard", () => {
  it("says the port is taken instead of crashing with a stack trace", async () => {
    const { createServer } = await import("node:net");
    const { startDashboard } = await import("../src/server/index.js");
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, "127.0.0.1", () => r()));
    const port = (busy.address() as { port: number }).port;
    process.env.QUIETAPPLY_HOME = makeHome().home;
    try {
      await expect(startDashboard({ port })).rejects.toThrow(`port ${port} is already in use`);
    } finally {
      delete process.env.QUIETAPPLY_HOME;
      busy.close();
    }
  });
});
