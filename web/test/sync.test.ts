import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { acquireLock, loadSession, loginStatus, releaseLock, saveLogin, saveRotated } from "../src/state";
import { scheduledSync, staleWarning, startSync, syncStatus } from "../src/sync";
import { SESSION, garmin, testEnv } from "./helpers";

const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
let slack: string[] = [];
beforeEach(() => {
  slack = [];
  globalThis.fetch = mock(async (_url: any, init: any) => (slack.push(JSON.parse(init.body).text), new Response("ok"))) as any;
  globalThis.setTimeout = ((run: () => void) => realTimeout(run, 0)) as any; // retry delays
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realTimeout;
});

const log = (sqlite: any) => sqlite.query("SELECT status, error FROM sync_log ORDER BY id").all();
const expired = () => garmin((path) => (path === "/app/home" ? { status: 302 } : undefined));

test("a good sync writes its rows and one ok log entry", async () => {
  const { env, sqlite } = await testEnv();
  await scheduledSync(env);
  expect(log(sqlite)).toEqual([{ status: "ok", error: null }]);
  expect(sqlite.query("SELECT total_steps FROM daily_summary").all()).toEqual([{ total_steps: 1234 }, { total_steps: 1234 }]);
  expect(await syncStatus(env.DB)).toMatchObject({ in_progress: false, stale: false, warning: null, login: { needed: false } });
});

test("an expired session is flagged and via-server is asked to log in", async () => {
  const { env, sqlite, server } = await testEnv(expired());
  await scheduledSync(env);
  expect(log(sqlite)).toEqual([{ status: "error", error: "session_expired: Garmin redirected to sign-in" }]);
  expect(server.requests.some((r) => r.path === "/login" && r.init.method === "POST")).toBe(true);
  expect((await loginStatus(env.DB)).needed).toBe(true);
  await saveLogin(env, SESSION);
  expect((await loginStatus(env.DB)).needed).toBe(false);
});

test("being blocked or cut off from home never asks for a login", async () => {
  for (const reply of [{ status: 429 }, new Error("tunnel down")]) {
    const { env, server } = await testEnv(garmin(() => reply));
    await scheduledSync(env);
    expect((await loginStatus(env.DB)).needed).toBe(false);
    expect(server.requests.some((r) => r.path === "/login")).toBe(false);
  }
});

test("a partial sync keeps what it read; it only fails if core data is missing", async () => {
  const minor = await testEnv(garmin((p) => (p.includes("/wellness/dailySpo2/") ? { status: 500 } : undefined)));
  await scheduledSync(minor.env);
  expect(log(minor.sqlite)[0].status).toBe("ok");
  expect(log(minor.sqlite)[0].error).toContain("spo2");

  const core = await testEnv(garmin((p) => (p.includes("/wellness/dailySleepData/") ? { status: 500 } : undefined)));
  await scheduledSync(core.env);
  expect(log(core.sqlite)[0].status).toBe("error");
  expect(core.sqlite.query("SELECT count(*) AS n FROM daily_summary").get()).toEqual({ n: 2 });
});

test("D1 writes are retried, and a lasting failure is logged without losing the lock", async () => {
  const once = await testEnv();
  once.control.failBatch = 1;
  await scheduledSync(once.env);
  expect(log(once.sqlite)).toEqual([{ status: "ok", error: null }]);

  const down = await testEnv();
  down.control.failBatch = 3;
  await scheduledSync(down.env);
  expect(log(down.sqlite)).toEqual([{ status: "error", error: "d1_write: D1_ERROR: D1 DB is overloaded." }]);
  expect((await syncStatus(down.env.DB)).in_progress).toBe(false);
});

test("alerts need two failures in a row and repeat at most hourly", async () => {
  const { env } = await testEnv(garmin(() => new Error("tunnel down")));
  await scheduledSync(env);
  expect(slack).toHaveLength(0);
  await scheduledSync(env);
  await scheduledSync(env);
  expect(slack).toHaveLength(1);
  expect(slack[0]).toContain("home_down");
});

test("only one sync runs at a time", async () => {
  const { env, sqlite } = await testEnv();
  const token = await acquireLock(env.DB);
  expect(await startSync(env, () => {})).toMatchObject({ status: "busy", in_progress: true });
  await releaseLock(env.DB, "someone else's");
  expect(await acquireLock(env.DB)).toBeNull();
  sqlite.exec(`UPDATE sync_state SET value = '${Date.now() - 11 * 60_000}:x' WHERE key = 'sync_lock'`);
  expect(await acquireLock(env.DB)).not.toBe(token);
});

test("the session is stored encrypted, without SSO cookies, and a newer login wins over a rotated one", async () => {
  const { env, sqlite } = await testEnv();
  expect(sqlite.query("SELECT value FROM sync_state").all().some((r: any) => /app-session|sso-secret/.test(r.value))).toBe(false);
  const loaded = (await loadSession(env))!;
  expect(loaded.session.cookies.map((c) => c.name)).toEqual(["session", "GARMIN-SSO-CUST-GUID"]);

  await saveLogin(env, { ...SESSION, cookies: [{ name: "session", value: "newer", domain: ".connect.garmin.com" }] });
  await saveRotated(env, loaded.session, loaded.stored);
  expect((await loadSession(env))!.session.cookies[0]!.value).toBe("newer");
  expect(await loadSession({ ...env, SESSION_KEY: "z".repeat(40) })).toBeNull();
});

test("login is requested before the session expires, and staleness starts after two hours", async () => {
  const { env } = await testEnv();
  const soon = { ...SESSION, cookies: [{ name: "session", value: "v", domain: ".connect.garmin.com", expires: Date.now() / 1000 + 1800 }] };
  await saveLogin(env, soon);
  const login = await loginStatus(env.DB);
  expect(login).toMatchObject({ needed: true, reason: "session is about to expire" });

  const now = Date.parse("2026-11-25T12:00:00Z");
  expect(staleWarning("2026-11-25T10:01:00.000Z", login, now)).toBeNull();
  expect(staleWarning("2026-11-25T09:30:00.123456+00:00", login, now)).toContain("2.5 hours ago");
  expect(staleWarning(null, login, now)).toContain("STALE");
});
