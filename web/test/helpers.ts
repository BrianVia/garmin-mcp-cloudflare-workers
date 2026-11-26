import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { Bindings } from "../src/server";
import { saveLogin } from "../src/state";

const MIGRATIONS = ["0001_schema", "0002_sleep_detail", "0003_intraday", "0005_sleep_scored_at", "0006_sync_state"];

export function openDb(): Database {
  const db = new Database(":memory:");
  for (const name of MIGRATIONS) db.exec(readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8"));
  return db;
}

/** The parts of D1 the Worker uses, over SQLite. `failBatch` makes the next n batches of more than two statements fail. */
export function d1(sqlite: Database) {
  const control = { failBatch: 0 };
  const statement = (sql: string, params: any[] = []): any => ({
    bind: (...next: any[]) => statement(sql, next),
    all: async () => ({ results: sqlite.query(sql).all(...params) }),
    first: async () => sqlite.query(sql).get(...params) ?? null,
    run: async () => ({ meta: { changes: sqlite.query(sql).run(...params).changes } }),
    exec: () => ({ results: sqlite.query(sql).all(...params) }),
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: any[]) => {
      if (statements.length > 2 && control.failBatch-- > 0) throw new Error("D1_ERROR: D1 DB is overloaded.");
      return sqlite.transaction(() => statements.map((s) => s.exec()))();
    },
  };
  return { db: db as unknown as D1Database, control };
}

export const SESSION = {
  cookies: [
    { name: "session", value: "app-session", domain: ".connect.garmin.com", expires: Date.now() / 1000 + 7200 },
    { name: "GARMIN-SSO-CUST-GUID", value: "guid", domain: ".garmin.com", expires: -1 },
    { name: "CASTGC", value: "sso-secret", domain: "sso.garmin.com", expires: -1 },
  ],
  saved_at: Date.now() / 1000,
};

export type Reply = { status?: number; body?: unknown; headers?: [string, string][] };

/** A stand-in for home/proxy.py and Garmin. `override` answers a path first; undefined falls through to the defaults. */
export function garmin(override: (path: string, init: RequestInit) => Reply | undefined | Error = () => undefined) {
  const requests: { path: string; init: RequestInit }[] = [];
  const defaults = (path: string): Reply => {
    if (path === "/app/home") return { body: '<meta name="csrf-token" content="tok"/>' };
    if (path.endsWith("/socialProfile")) return { body: { displayName: "dn-1" } };
    if (path === "/login") return { status: 202 };
    if (path.includes("/usersummary/daily/")) return { body: { calendarDate: path.slice(-10), totalSteps: 1234 } };
    return { status: 204 };
  };
  const fetch = async (url: string, init: RequestInit) => {
    const path = url.replace("http://garmin-home", "");
    requests.push({ path, init });
    const reply = override(path, init) ?? defaults(path);
    if (reply instanceof Error) throw reply;
    const body = reply.body === undefined ? null : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status ?? 200, headers: [["x-garmin-proxy", "garmin"], ...(reply.headers ?? [])] });
  };
  return { fetch, requests, home: { fetch, url: "http://garmin-home", token: "t" } };
}

export async function testEnv(server = garmin()) {
  const sqlite = openDb();
  const { db, control } = d1(sqlite);
  const env = {
    DB: db, GARMIN_HOME: { fetch: server.fetch } as unknown as Fetcher, GARMIN_PROXY_URL: "http://garmin-home",
    GARMIN_PROXY_TOKEN: "t", SESSION_KEY: "k".repeat(40), MCP_BEARER: "m", SLACKPIPES_WEBHOOK: "https://slack.test/hook",
  } as Bindings;
  await saveLogin(env, SESSION);
  return { env, sqlite, control, server };
}
