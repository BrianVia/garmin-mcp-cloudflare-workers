// Runs the Python Garmin collector (../collector.py) in a Cloudflare Container and replays its writes on D1.
// This Durable Object owns the Garmin login session and the one-sync-at-a-time lock.
import { Container } from "@cloudflare/containers";
import type { Bindings } from "./server";

const SYNC_TIMEOUT_MS = 10 * 60_000;
const STALE_LOCK_MS = 15 * 60_000;
const ALERT_COOLDOWN_MS = 60 * 60_000;
const D1_RETRY_DELAYS_MS = [5_000, 20_000];

type Statement = [sql: string, params: unknown[]];
type CollectorResponse = {
  status: "ok" | "error";
  error: string | null;
  result: unknown;
  session: unknown;
  statements: Statement[];
  log: string;
};

async function readResponse(res: Response): Promise<CollectorResponse> {
  if (!res.ok) throw new Error(`collector HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json<CollectorResponse>();
}

// ponytail: one collector instance; it's one Garmin account.
export const collector = (env: Bindings) => env.COLLECTOR.getByName("main");

export type SyncStatus = {
  in_progress: boolean;
  last_ok: string | null;
  last_attempt: { at: string; status: string; records_upserted: number | null; error: string | null } | null;
};

export async function syncStatus(db: D1Database, inProgress: boolean): Promise<SyncStatus> {
  const [lastOk, lastAttempt] = await db.batch<any>([
    db.prepare("SELECT sync_date FROM sync_log WHERE status = 'ok' ORDER BY sync_date DESC, id DESC LIMIT 1"),
    db.prepare("SELECT sync_date AS at, status, records_upserted, error FROM sync_log ORDER BY sync_date DESC, id DESC LIMIT 1"),
  ]);
  return {
    in_progress: inProgress,
    last_ok: lastOk?.results[0]?.sync_date ?? null,
    last_attempt: lastAttempt?.results[0] ?? null,
  };
}

export class GarminCollector extends Container<Bindings> {
  defaultPort = 8080;
  sleepAfter = "5m";
  // The Container base class can fire the same scheduled callback from overlapping alarms.
  private running = false;

  constructor(ctx: DurableObjectState<Bindings>, env: Bindings) {
    super(ctx, env);
    this.envVars = { GARMIN_EMAIL: env.GARMIN_EMAIL, GARMIN_PASSWORD: env.GARMIN_PASSWORD, TS_AUTHKEY: env.TS_AUTHKEY ?? "" };
  }

  async inProgress(): Promise<boolean> {
    const started = await this.ctx.storage.get<number>("sync_started");
    return started !== undefined && Date.now() - started < STALE_LOCK_MS;
  }

  async status(): Promise<SyncStatus> {
    return syncStatus(this.env.DB, await this.inProgress());
  }

  /** Replace the Garmin login cookies, e.g. with a garmin_session.json from a machine that could log in. */
  async setSession(session: { cookies: unknown[]; saved_at: number }) {
    await this.ctx.storage.put("garmin_session", session);
  }

  /** Queue a sync unless one is already running. Returns immediately. */
  async startSync(targetDate: string | null = null): Promise<{ status: "started" | "busy" } & SyncStatus> {
    if (await this.inProgress()) return { status: "busy", ...(await this.status()) };
    await this.ctx.storage.put("sync_started", Date.now());
    await this.schedule(0, "runSync", targetDate);
    return { status: "started", ...(await this.status()) };
  }

  async runSync(targetDate: string | null) {
    if (this.running) return;
    this.running = true;
    try {
      await this.collect(targetDate);
    } finally {
      await this.ctx.storage.delete("sync_started");
      this.running = false;
    }
  }

  private async collect(targetDate: string | null) {
    const db = this.env.DB;
    const known = await db
      .prepare(
        `SELECT activity_id FROM activity_splits UNION SELECT activity_id FROM activity_hr_zones
         UNION SELECT activity_id FROM activity_weather UNION SELECT activity_id FROM activity_exercise_sets`,
      )
      .all<{ activity_id: number }>();

    let response: CollectorResponse;
    try {
      await this.startAndWaitForPorts();
      const res = await this.containerFetch("http://collector/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session: (await this.ctx.storage.get("garmin_session")) ?? null,
          known_activity_ids: known.results.map((row) => row.activity_id),
          target_date: targetDate,
        }),
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      });
      // 409: a sync this invocation lost track of (e.g. a retried alarm) is still running. Take its result
      // rather than dropping it, since it holds the refreshed Garmin cookies.
      response = res.status === 409 ? await this.awaitRunningSync() : await readResponse(res);
    } catch (error) {
      // Hung or crashed browser: keep the cookies it saved after logging in (Garmin may have rotated them,
      // and a fresh login is blocked from Cloudflare), then kill the container so the next run starts clean.
      await this.rescueSession();
      await this.destroy().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      await db
        .prepare("INSERT INTO sync_log (sync_date, sync_type, records_upserted, status, error) VALUES (?, 'incremental_sync', 0, 'error', ?)")
        .bind(new Date().toISOString(), message.slice(0, 500))
        .run()
        .catch(() => {});
      return this.alert("collector", message, "");
    }

    if (response.session) await this.ctx.storage.put("garmin_session", response.session);
    console.log(`garmin sync ${response.status}: ${response.statements.length} statements`, response.error ?? "");

    try {
      await this.replay(response.statements);
    } catch (error) {
      return this.alert("d1_write", error instanceof Error ? error.message : String(error), response.log);
    }
    if (response.status !== "ok") {
      console.log(response.log);
      return this.alert("garmin_sync", response.error ?? "unknown error", response.log);
    }
  }

  private async failedTwiceInARow(): Promise<boolean> {
    try {
      const { results } = await this.env.DB
        .prepare("SELECT status FROM sync_log ORDER BY sync_date DESC, id DESC LIMIT 2")
        .all<{ status: string }>();
      return results.length === 2 && results.every((row) => row.status !== "ok");
    } catch {
      return true;
    }
  }

  private async rescueSession() {
    try {
      const res = await this.containerFetch("http://collector/session", { signal: AbortSignal.timeout(10_000) });
      if (res.ok) await this.ctx.storage.put("garmin_session", await res.json());
    } catch (error) {
      console.warn("could not rescue Garmin session", error);
    }
  }

  private async awaitRunningSync(): Promise<CollectorResponse> {
    const deadline = Date.now() + SYNC_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const res = await this.containerFetch("http://collector/result");
      if (res.status !== 409) return readResponse(res);
    }
    throw new Error("timed out waiting for the running collector sync");
  }

  /** Apply the collector's writes in one D1 batch (a transaction), retrying transient failures. */
  private async replay(statements: Statement[]) {
    if (statements.length === 0) return;
    const db = this.env.DB;
    const batch = statements.map(([sql, params]) => db.prepare(sql).bind(...params));
    for (let attempt = 0; ; attempt++) {
      try {
        await db.batch(batch);
        return;
      } catch (error) {
        const delay = D1_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw error;
        console.warn(`D1 replay attempt ${attempt + 1} failed, retrying in ${delay}ms`, error);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /** Slack alert via SlackPipes after two failed syncs in a row, at most once an hour per failure mode. */
  private async alert(mode: string, detail: string, log: string) {
    console.error(`garmin sync failed (${mode}): ${detail}`);
    // A one-off hang fixes itself on the next run. d1_write writes no sync_log row, so it always alerts.
    if (mode !== "d1_write" && !(await this.failedTwiceInARow())) return;
    const key = `alert_sent:${mode}`;
    const last = await this.ctx.storage.get<number>(key);
    if (!this.env.SLACKPIPES_WEBHOOK || (last && Date.now() - last < ALERT_COOLDOWN_MS)) return;
    const tail = log.trim().split("\n").slice(-15).join("\n");
    const hint = detail === "Login failed" ? "\n*fix:* upload fresh cookies from a home machine (USAGE.md, \"When syncs fail with Login failed\")" : "";
    const text = `:rotating_light: garmin-sync failed on Cloudflare\n*mode:* ${mode}\n*detail:* ${detail}${hint}\n\`\`\`\n${tail || "(no log)"}\n\`\`\``;
    const res = await fetch(this.env.SLACKPIPES_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error) => console.error("alert failed", error));
    if (res?.ok) await this.ctx.storage.put(key, Date.now());
  }
}
