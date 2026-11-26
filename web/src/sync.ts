// One Garmin sync: read yesterday and today over REST through the home proxy, write them to D1.
import { addDays, localToday } from "./brief";
import { activityDetails, syncEndpoints } from "./garmin/endpoints";
import { GarminClient, GarminError, type FailureMode, type Home } from "./garmin/client";
import { Writes, type Statement } from "./garmin/save";
import {
  acquireLock, alertSentWithin, inProgress, loadSession, loginStatus, markAlertSent, markLoginNeeded, releaseLock, saveRotated,
  type LoginStatus,
} from "./state";
import type { Bindings } from "./server";

const ALERT_COOLDOWN_MS = 60 * 60_000;
const STALE_AFTER_MS = 2 * 60 * 60_000;
const D1_RETRY_DELAYS_MS = [5_000, 20_000];
const RECENT_ACTIVITIES = 100;
const MAX_NEW_ACTIVITIES = 25; // five requests each; the rest wait for the next sync
/** A sync that could not read these is a failure, even though whatever else it read is kept. */
const CORE = new Set(["daily_summary", "sleep", "heart_rate", "stress"]);

type Mode = FailureMode | "d1_write" | "partial" | "internal";

export type SyncStatus = {
  in_progress: boolean;
  last_ok: string | null;
  last_attempt: { at: string; status: string; records_upserted: number | null; error: string | null } | null;
  stale: boolean;
  warning: string | null;
  login: LoginStatus;
};

/** Says in words that the data is old, or null when the last good sync is under two hours old. */
export function staleWarning(lastOk: string | null, login: LoginStatus, now = Date.now()): string | null {
  const age = lastOk ? now - Date.parse(lastOk) : Infinity;
  if (age <= STALE_AFTER_MS) return null;
  const since = lastOk ? `the last successful Garmin sync was ${(age / 3_600_000).toFixed(1)} hours ago` : "no Garmin sync has ever succeeded";
  return `STALE DATA: ${since}.${login.needed ? ` Garmin login needed: ${login.reason}.` : ""}`;
}

export async function syncStatus(db: D1Database): Promise<SyncStatus> {
  const [logs, login, running] = await Promise.all([
    db.batch<any>([
      db.prepare("SELECT sync_date FROM sync_log WHERE status = 'ok' ORDER BY sync_date DESC, id DESC LIMIT 1"),
      db.prepare("SELECT sync_date AS at, status, records_upserted, error FROM sync_log ORDER BY sync_date DESC, id DESC LIMIT 1"),
    ]),
    loginStatus(db),
    inProgress(db),
  ]);
  const lastOk: string | null = logs[0]?.results[0]?.sync_date ?? null;
  const warning = staleWarning(lastOk, login);
  return { in_progress: running, last_ok: lastOk, last_attempt: logs[1]?.results[0] ?? null, stale: warning !== null, warning, login };
}

/** Start a sync unless one is running. `defer` keeps it alive after this returns (waitUntil).
 *  ponytail: waitUntil allows 30 s and a sync takes about 5; move to a Workflow if syncs get near that. */
export async function startSync(
  env: Bindings,
  defer: (sync: Promise<void>) => void,
  targetDate: string | null = null,
): Promise<{ status: "started" | "busy" } & SyncStatus> {
  const lock = await acquireLock(env.DB);
  if (lock) defer(runLocked(env, lock, targetDate));
  return { status: lock ? "started" : "busy", ...(await syncStatus(env.DB)) };
}

/** The cron entry point. */
export async function scheduledSync(env: Bindings): Promise<void> {
  let lock: string | null;
  try {
    lock = await acquireLock(env.DB);
  } catch (error) {
    // D1 is down, so there is no sync_log to write or count failures in.
    return alert(env, "d1_write", `could not start a sync: ${message(error)}`);
  }
  if (!lock) return console.log("scheduled sync: busy");
  await runLocked(env, lock, null);
}

async function runLocked(env: Bindings, lock: string, targetDate: string | null): Promise<void> {
  try {
    await runSync(env, targetDate);
  } catch (error) {
    const mode: Mode = error instanceof SyncError || error instanceof GarminError ? error.mode : "internal";
    await logSync(env.DB, "error", 0, `${mode}: ${message(error)}`);
    await alert(env, mode, message(error));
  } finally {
    await releaseLock(env.DB, lock).catch((error) => console.error("could not release the sync lock", error));
  }
}

class SyncError extends Error {
  constructor(readonly mode: Mode, text: string) {
    super(text);
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function homeProxy(env: Bindings): Home {
  if (!env.GARMIN_PROXY_TOKEN) throw new SyncError("home_down", "GARMIN_PROXY_TOKEN secret is not set");
  const vpc = env.GARMIN_HOME;
  return {
    // Without the VPC binding (local dev, or a public tunnel hostname) GARMIN_PROXY_URL must be reachable as is.
    fetch: vpc ? (url, init) => vpc.fetch(url, init) : (url, init) => fetch(url, init),
    url: env.GARMIN_PROXY_URL,
    token: env.GARMIN_PROXY_TOKEN,
  };
}

async function runSync(env: Bindings, targetDate: string | null): Promise<void> {
  const started = Date.now();
  const db = env.DB;
  const today = targetDate ?? localToday();
  const yesterday = addDays(today, -1);

  const home = homeProxy(env);
  const loaded = await loadSession(env);
  if (!loaded) {
    await requestLogin(env, home, "no usable session stored", null);
    throw new SyncError("session_expired", "no usable Garmin session stored");
  }

  const client = new GarminClient(home, loaded.session);
  const writes = new Writes();
  try {
    await client.connect();
    for (const { endpoint, data } of await client.fetchAll(syncEndpoints(client.displayName, yesterday, today))) {
      writes.save(endpoint.name, data, endpoint.date);
    }
    if (!client.fatal) await syncActivities(db, client, writes);
    for (const day of [yesterday, today]) writes.addDetail(day);
  } catch (error) {
    if (error instanceof GarminError && error.mode === "session_expired") await requestLogin(env, home, error.message, loaded.stored);
    throw error;
  } finally {
    if (client.sessionRotated) {
      await saveRotated(env, { cookies: client.currentCookies(), saved_at: Date.now() / 1000 }, loaded.stored).catch((error) =>
        console.error("could not keep the rotated Garmin session", error),
      );
    }
  }
  if (client.fatal?.mode === "session_expired") await requestLogin(env, home, client.fatal.message, loaded.stored);

  const failed = client.failed.length ? `${client.failed.length} endpoints failed: ${client.failed.join(", ")}` : null;
  const coreFailed = client.failed.some((name) => CORE.has(name.split(" ")[0]!));
  const ok = !client.fatal && !coreFailed;
  const error = client.fatal ? `${client.fatal.mode}: ${client.fatal.message}; ${failed}` : failed;
  const statements = writes.statements();
  // The log row goes in the same transaction, so "ok" always means the data is in.
  statements.push(logStatement(ok ? "ok" : "error", writes.count, error));
  try {
    await writeAll(db, statements);
  } catch (cause) {
    throw new SyncError("d1_write", message(cause));
  }
  console.log(`garmin sync ${ok ? "ok" : "error"}: ${writes.count} rows, ${statements.length} statements, ${Date.now() - started}ms`, error ?? "");
  if (!ok) await alert(env, client.fatal?.mode ?? "partial", error ?? "");
}

async function syncActivities(db: D1Database, client: GarminClient, writes: Writes): Promise<void> {
  const known = new Set(
    (
      await db
        .prepare(
          `SELECT activity_id FROM activity_splits UNION SELECT activity_id FROM activity_hr_zones
           UNION SELECT activity_id FROM activity_weather UNION SELECT activity_id FROM activity_exercise_sets`,
        )
        .all<{ activity_id: number }>()
    ).results.map((row) => row.activity_id),
  );
  const all = await client.activities();
  const fresh = all.filter((a) => a.activityId && !known.has(a.activityId));
  // Edits to an older activity (a rename, say) are not picked up again.
  writes.save("activities", [...new Set([...all.slice(0, RECENT_ACTIVITIES), ...fresh])]);
  const details = fresh.slice(0, MAX_NEW_ACTIVITIES).flatMap((a) => activityDetails(a.activityId));
  for (const { endpoint, data } of await client.fetchAll(details)) writes.save(endpoint.name, data, endpoint.date);
}

/** Flag the login for via-server's timer, and nudge via-server to do it now. */
async function requestLogin(env: Bindings, home: Home, reason: string, stored: string | null): Promise<void> {
  await markLoginNeeded(env.DB, reason, stored);
  try {
    const res = await home.fetch(`${home.url}/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${home.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`login request to via-server: HTTP ${res.status}`);
    await res.body?.cancel();
  } catch (error) {
    console.warn("could not reach via-server to request a login; its timer will", message(error));
  }
}

const LOG_SQL = "INSERT INTO sync_log (sync_date, sync_type, records_upserted, status, error) VALUES (?1, 'incremental_sync', ?2, ?3, ?4)";
const logStatement = (status: "ok" | "error", count: number, error: string | null): Statement => [
  LOG_SQL,
  [new Date().toISOString(), count, status, error?.slice(0, 500) ?? null],
];

async function logSync(db: D1Database, status: "ok" | "error", count: number, error: string): Promise<void> {
  const [sql, params] = logStatement(status, count, error);
  await db.prepare(sql).bind(...params).run().catch((cause) => console.error("could not write sync_log", cause));
}

/** Apply every write in one D1 batch (a transaction), retrying transient failures. */
async function writeAll(db: D1Database, statements: Statement[]): Promise<void> {
  const batch = statements.map(([sql, params]) => db.prepare(sql).bind(...params));
  for (let attempt = 0; ; attempt++) {
    try {
      await db.batch(batch);
      return;
    } catch (error) {
      const delay = D1_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      console.warn(`D1 write attempt ${attempt + 1} failed, retrying in ${delay}ms`, error);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function failedTwiceInARow(db: D1Database): Promise<boolean> {
  try {
    const { results } = await db
      .prepare("SELECT status FROM sync_log ORDER BY sync_date DESC, id DESC LIMIT 2")
      .all<{ status: string }>();
    return results.length === 2 && results.every((row) => row.status !== "ok");
  } catch {
    return true;
  }
}

const HINTS: Partial<Record<Mode, string>> = {
  session_expired: "on via-server: `journalctl --user -u garmin-login -n 50` (USAGE.md, \"When syncs fail\")",
  blocked: "Garmin is rate limiting. Leave it alone; do not force logins.",
  home_down: "on via-server: `systemctl --user status garmin-proxy; docker logs --tail 50 cloudflared-garmin`",
};

/** Slack alert via SlackPipes after two failed syncs in a row, at most once an hour per failure mode. */
async function alert(env: Bindings, mode: Mode, detail: string): Promise<void> {
  console.error(`garmin sync failed (${mode}): ${detail}`);
  // A one-off timeout, D1 overload or expired session fixes itself on the next run.
  if (!env.SLACKPIPES_WEBHOOK || !(await failedTwiceInARow(env.DB))) return;
  if (await alertSentWithin(env.DB, mode, ALERT_COOLDOWN_MS).catch(() => false)) return;
  const hint = HINTS[mode] ? `\n*fix:* ${HINTS[mode]}` : "";
  const res = await fetch(env.SLACKPIPES_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `:rotating_light: garmin-sync failed\n*mode:* ${mode}\n*detail:* ${detail.slice(0, 1500)}${hint}` }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => console.error("alert failed", error));
  if (res?.ok) await markAlertSent(env.DB, mode).catch((error) => console.error("could not record the alert", error));
}
