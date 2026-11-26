// The sync_state table: the Garmin session (encrypted), login status, the sync lock, and alert cooldowns.
import { connectCookies, sessionExpiry, type Session } from "./garmin/client";
import type { Bindings } from "./server";

const STALE_LOCK_MS = 10 * 60_000;
/** Ask for a new login this long before Garmin ends the session, so a scheduled sync never meets an expired one. */
const RENEW_BEFORE_MS = 45 * 60_000;

type LoginNeeded = { at: string; reason: string };
export type LoginStatus = {
  needed: boolean;
  reason: string | null;
  last_login: string | null;
  session_expires_at: string | null;
};

const KEYS = { session: "session", loginNeeded: "login_needed", lastLogin: "last_login", expiresAt: "session_expires_at", lock: "sync_lock" };

const upsert = (db: D1Database, key: string, value: string) =>
  db
    .prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, value, new Date().toISOString());

const remove = (db: D1Database, key: string) => db.prepare("DELETE FROM sync_state WHERE key = ?1").bind(key);

async function read(db: D1Database, ...keys: string[]): Promise<Record<string, string | undefined>> {
  const { results } = await db
    .prepare(`SELECT key, value FROM sync_state WHERE key IN (${keys.map(() => "?").join(", ")})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((row) => [row.key, row.value]));
}

// garmin_query can read every table, so the cookies are only ever stored as ciphertext.
async function cryptoKey(env: Bindings): Promise<CryptoKey> {
  if (!env.SESSION_KEY || env.SESSION_KEY.length < 32) throw new Error("SESSION_KEY secret is missing or shorter than 32 characters");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.SESSION_KEY));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(env: Bindings, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(env), new TextEncoder().encode(plain)));
  return btoa(String.fromCharCode(...iv, ...data));
}

export async function decrypt(env: Bindings, sealed: string): Promise<string> {
  const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await cryptoKey(env), bytes.slice(12));
  return new TextDecoder().decode(plain);
}

const expiryStatement = (db: D1Database, session: Session) => {
  const expiry = sessionExpiry(session.cookies);
  return expiry ? upsert(db, KEYS.expiresAt, new Date(expiry).toISOString()) : remove(db, KEYS.expiresAt);
};

/** Store the cookies from a fresh login. */
export async function saveLogin(env: Bindings, upload: Session): Promise<void> {
  const session = { cookies: connectCookies(upload.cookies), saved_at: upload.saved_at };
  await env.DB.batch([
    upsert(env.DB, KEYS.session, await encrypt(env, JSON.stringify(session))),
    upsert(env.DB, KEYS.lastLogin, new Date().toISOString()),
    expiryStatement(env.DB, session),
    remove(env.DB, KEYS.loginNeeded),
  ]);
}

/** `stored` is the ciphertext the session came from; saveRotated uses it to detect a newer login. */
export async function loadSession(env: Bindings): Promise<{ session: Session; stored: string } | null> {
  const stored = (await read(env.DB, KEYS.session)).session;
  if (!stored) return null;
  await cryptoKey(env); // a missing secret is a setup error, not a reason to log in again
  try {
    return { session: JSON.parse(await decrypt(env, stored)), stored };
  } catch (error) {
    console.error("stored Garmin session is unreadable", error);
    return null;
  }
}

/** Keep cookies Garmin replaced during a sync, unless via-server uploaded a new login meanwhile. */
export async function saveRotated(env: Bindings, session: Session, stored: string): Promise<void> {
  const sealed = await encrypt(env, JSON.stringify(session));
  const { meta } = await env.DB
    .prepare("UPDATE sync_state SET value = ?1, updated_at = ?2 WHERE key = ?3 AND value = ?4")
    .bind(sealed, new Date().toISOString(), KEYS.session, stored)
    .run();
  if (meta.changes) await expiryStatement(env.DB, session).run();
}

/** `stored` limits the report to the session that failed, so a login uploaded mid-sync is not thrown away. */
export async function markLoginNeeded(db: D1Database, reason: string, stored: string | null): Promise<void> {
  const value = JSON.stringify({ at: new Date().toISOString(), reason } satisfies LoginNeeded);
  if (stored !== null && (await read(db, KEYS.session)).session !== stored) return;
  await upsert(db, KEYS.loginNeeded, value).run();
}

export async function loginStatus(db: D1Database): Promise<LoginStatus> {
  const rows = await read(db, KEYS.loginNeeded, KEYS.lastLogin, KEYS.expiresAt);
  const flagged: LoginNeeded | null = rows.login_needed ? JSON.parse(rows.login_needed) : null;
  const expiresAt = rows.session_expires_at ?? null;
  const reason =
    flagged?.reason ??
    (!rows.last_login ? "no session uploaded yet" : expiresAt && Date.parse(expiresAt) - Date.now() < RENEW_BEFORE_MS ? "session is about to expire" : null);
  return { needed: reason !== null, reason, last_login: rows.last_login ?? null, session_expires_at: expiresAt };
}

/** Take the one-sync-at-a-time lock. Returns its token, or null while another sync holds it. */
export async function acquireLock(db: D1Database): Promise<string | null> {
  const now = Date.now();
  const token = `${now}:${crypto.randomUUID()}`;
  const row = await db
    .prepare(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE CAST(sync_state.value AS INTEGER) < ?4 RETURNING value`,
    )
    .bind(KEYS.lock, token, new Date(now).toISOString(), now - STALE_LOCK_MS)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function releaseLock(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sync_state WHERE key = ?1 AND value = ?2").bind(KEYS.lock, token).run();
}

export async function inProgress(db: D1Database): Promise<boolean> {
  const lock = (await read(db, KEYS.lock)).sync_lock;
  return lock !== undefined && Number.parseInt(lock, 10) > Date.now() - STALE_LOCK_MS;
}

export async function alertSentWithin(db: D1Database, mode: string, ms: number): Promise<boolean> {
  const sent = (await read(db, `alert:${mode}`))[`alert:${mode}`];
  return sent !== undefined && Date.now() - Number(sent) < ms;
}

export const markAlertSent = (db: D1Database, mode: string) => upsert(db, `alert:${mode}`, String(Date.now())).run();
