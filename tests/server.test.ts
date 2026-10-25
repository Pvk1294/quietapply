import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { addApplication, askQuestion, getApplication, setStatus } from "../src/core/store.js";
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
  setStatus(db, r, "awaiting_review");
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
    expect(
      (await app.request(`/api/applications/${r}/approve`, { method: "POST", headers: WRITE })).status,
    ).toBe(200);
    expect(
      (await app.request(`/api/applications/${a}/approve`, { method: "POST", headers: WRITE })).status,
    ).toBe(400);
    const detail = (await (await app.request(`/api/applications/${r}`, { headers: HOST })).json()) as Record<
      string,
      unknown
    >;
    expect(detail).toMatchObject({ status: "queued", review_approved: 1 });
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
});
