// The seven Garmin MCP tools, ported from garmin_mcp/server.py to read D1.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addDays, buildBrief, localToday } from "./brief";
import { collector } from "./collector";
import type { Bindings } from "./server";

type Row = Record<string, unknown>;

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const errorText = (error: unknown) => text({ error: error instanceof Error ? error.message : String(error) });

const TREND_METRICS: Record<string, { table: string; expr: string; notNull: string }> = {
  resting_hr: { table: "daily_summary", expr: "ROUND(AVG(resting_heart_rate), 1)", notNull: "resting_heart_rate IS NOT NULL" },
  stress: { table: "daily_summary", expr: "ROUND(AVG(average_stress_level), 1)", notNull: "average_stress_level IS NOT NULL" },
  steps: { table: "daily_summary", expr: "ROUND(AVG(total_steps), 0)", notNull: "total_steps IS NOT NULL" },
  sleep_hours: { table: "sleep", expr: "ROUND(AVG(sleep_time_seconds) / 3600.0, 2)", notNull: "sleep_time_seconds IS NOT NULL" },
  body_battery: { table: "daily_summary", expr: "ROUND(AVG(body_battery_highest), 1)", notNull: "body_battery_highest IS NOT NULL" },
  spo2: { table: "daily_summary", expr: "ROUND(AVG(average_spo2), 1)", notNull: "average_spo2 IS NOT NULL" },
  training_readiness: { table: "training_readiness", expr: "ROUND(AVG(score), 1)", notNull: "score IS NOT NULL" },
  floors: { table: "daily_summary", expr: "ROUND(AVG(floors_ascended), 1)", notNull: "floors_ascended IS NOT NULL" },
  calories: { table: "daily_summary", expr: "ROUND(AVG(total_kilocalories), 0)", notNull: "total_kilocalories IS NOT NULL" },
  active_minutes: { table: "daily_summary", expr: "ROUND(AVG(moderate_intensity_minutes + vigorous_intensity_minutes), 0)", notNull: "moderate_intensity_minutes IS NOT NULL" },
  respiration: { table: "daily_summary", expr: "ROUND(AVG(avg_waking_respiration), 1)", notNull: "avg_waking_respiration IS NOT NULL" },
  weight: { table: "weight", expr: "ROUND(AVG(weight), 2)", notNull: "weight IS NOT NULL" },
  hrv: { table: "hrv", expr: "ROUND(AVG(COALESCE(last_night, last_night_avg)), 1)", notNull: "COALESCE(last_night, last_night_avg) IS NOT NULL" },
  hrv_weekly: { table: "hrv", expr: "ROUND(AVG(weekly_avg), 1)", notNull: "weekly_avg IS NOT NULL" },
  endurance_score: { table: "endurance_score", expr: "ROUND(AVG(overall_score), 1)", notNull: "overall_score IS NOT NULL" },
  hill_score: { table: "hill_score", expr: "ROUND(AVG(overall_score), 1)", notNull: "overall_score IS NOT NULL" },
  race_5k: { table: "race_predictions", expr: "ROUND(AVG(time_5k), 0)", notNull: "time_5k IS NOT NULL" },
  race_10k: { table: "race_predictions", expr: "ROUND(AVG(time_10k), 0)", notNull: "time_10k IS NOT NULL" },
};

const BLOCKED = ["DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "CREATE", "ATTACH", "DETACH", "PRAGMA"];

export function createMcpServer(env: Bindings): McpServer {
  const db = env.DB;
  const server = new McpServer({ name: "garmin", version: "1.0.0" });

  server.tool("garmin_schema", "Show all tables, their columns, and row counts.", {}, async () => {
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' ORDER BY name")
      .all<{ name: string }>();
    const results = await db.batch<Row>(
      tables.results.flatMap(({ name }) => [
        db.prepare(`PRAGMA table_info(${name})`),
        db.prepare(`SELECT COUNT(*) AS cnt FROM ${name}`),
      ]),
    );
    const schema = Object.fromEntries(
      tables.results.map(({ name }, i) => [
        name,
        { columns: results[2 * i]!.results.map((c) => c.name), row_count: results[2 * i + 1]!.results[0]?.cnt },
      ]),
    );
    return text(schema);
  });

  server.tool(
    "garmin_query",
    "Run a custom SELECT query against the Garmin database. Only SELECT statements are allowed.",
    { sql: z.string() },
    async ({ sql }) => {
      const normalized = sql.trim().replace(/^;+/, "").trim().toUpperCase();
      if (!normalized.startsWith("SELECT")) return text({ error: "Only SELECT statements are permitted." });
      // Block dangerous keywords anywhere in the query (ignoring keywords inside string literals)
      const keyword = BLOCKED.find((word) => normalized.split("'")[0]!.includes(word));
      if (keyword) return text({ error: `'${keyword}' is not permitted in queries.` });
      try {
        return text((await db.prepare(sql).all()).results);
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.tool(
    "garmin_health_summary",
    `Health overview for a date range.

If start_date/end_date are omitted the most recent *days* days are used.
For LAST NIGHT / today use garmin_brief; this tool returns period averages.
Returns averages for steps, HR, stress, body battery, SpO2, respiration,
calories (daily_summary), sleep metrics (sleep table), and training
readiness score.`,
    { start_date: z.string().default(""), end_date: z.string().default(""), days: z.number().int().default(7) },
    async ({ start_date, end_date, days }) => {
      const end = end_date || localToday();
      const start = start_date || addDays(localToday(), -(days - 1));
      const [daily, sleep, readiness, endurance, hill, race] = await db.batch<Row>(
        [
          `SELECT
              ROUND(AVG(total_steps), 0)              AS avg_steps,
              ROUND(AVG(resting_heart_rate), 1)       AS avg_resting_hr,
              ROUND(AVG(average_stress_level), 1)     AS avg_stress,
              ROUND(AVG(body_battery_highest), 1)     AS avg_body_battery_high,
              ROUND(AVG(body_battery_lowest), 1)      AS avg_body_battery_low,
              ROUND(AVG(average_spo2), 1)             AS avg_spo2,
              ROUND(AVG(avg_waking_respiration), 1)   AS avg_respiration,
              ROUND(AVG(total_kilocalories), 0)       AS avg_calories,
              ROUND(AVG(active_kilocalories), 0)      AS avg_active_calories,
              ROUND(AVG(floors_ascended), 1)          AS avg_floors,
              ROUND(AVG(moderate_intensity_minutes + vigorous_intensity_minutes), 0) AS avg_intensity_minutes
           FROM daily_summary WHERE calendar_date BETWEEN ? AND ?`,
          `SELECT
              ROUND(AVG(sleep_time_seconds) / 3600.0, 2)  AS avg_sleep_hours,
              ROUND(AVG(deep_sleep_seconds) / 60.0, 0)    AS avg_deep_min,
              ROUND(AVG(light_sleep_seconds) / 60.0, 0)   AS avg_light_min,
              ROUND(AVG(rem_sleep_seconds) / 60.0, 0)     AS avg_rem_min,
              ROUND(AVG(awake_sleep_seconds) / 60.0, 0)   AS avg_awake_min,
              ROUND(AVG(average_hr_sleep), 1)             AS avg_sleeping_hr
           FROM sleep WHERE calendar_date BETWEEN ? AND ?`,
          `SELECT ROUND(AVG(score), 1) AS avg_training_readiness
           FROM training_readiness WHERE calendar_date BETWEEN ? AND ?`,
          `SELECT ROUND(AVG(overall_score), 1) AS avg_endurance_score, ROUND(AVG(vo2_max_precise), 1) AS avg_vo2_max
           FROM endurance_score WHERE calendar_date BETWEEN ? AND ? AND overall_score IS NOT NULL`,
          `SELECT ROUND(AVG(overall_score), 1) AS avg_hill_score, ROUND(AVG(endurance_score), 1) AS avg_hill_endurance,
                  ROUND(AVG(strength_score), 1) AS avg_hill_strength
           FROM hill_score WHERE calendar_date BETWEEN ? AND ? AND overall_score IS NOT NULL`,
          `SELECT ROUND(AVG(time_5k), 0) AS avg_time_5k_sec, ROUND(AVG(time_10k), 0) AS avg_time_10k_sec,
                  ROUND(AVG(time_half_marathon), 0) AS avg_time_half_sec, ROUND(AVG(time_marathon), 0) AS avg_time_marathon_sec
           FROM race_predictions WHERE calendar_date BETWEEN ? AND ? AND time_5k IS NOT NULL`,
        ].map((sql) => db.prepare(sql).bind(start, end)),
      );
      const row = (res: D1Result<Row> | undefined) => res?.results[0] ?? {};
      return text({
        period: { start_date: start, end_date: end },
        daily: row(daily),
        sleep: row(sleep),
        training_readiness: row(readiness),
        endurance: row(endurance),
        hill_score: row(hill),
        race_predictions: row(race),
      });
    },
  );

  server.tool(
    "garmin_activities",
    `List activities with optional filters by type and date range.

activity_type is a substring match: 'run' matches running and
treadmill_running; 'cycl' matches cycling and indoor_cycling; 'swim'
matches lap_swimming; 'strength' matches strength_training.
Returns key fields: name, type, date, duration_min, distance_km,
calories, avg_hr, elevation, power, training_load, location.`,
    {
      activity_type: z.string().default(""),
      start_date: z.string().default(""),
      end_date: z.string().default(""),
      limit: z.number().int().default(20),
    },
    async ({ activity_type, start_date, end_date, limit }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (activity_type) {
        conditions.push("LOWER(activity_type) LIKE '%' || LOWER(?) || '%'");
        params.push(activity_type);
      }
      if (start_date) {
        conditions.push("DATE(start_time_local) >= ?");
        params.push(start_date);
      }
      if (end_date) {
        conditions.push("DATE(start_time_local) <= ?");
        params.push(end_date);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      try {
        const rows = await db
          .prepare(
            `SELECT
                activity_name                      AS name,
                activity_type                      AS type,
                start_time_local                   AS date,
                ROUND(duration_seconds / 60.0, 1)  AS duration_min,
                ROUND(distance_meters / 1000.0, 2) AS distance_km,
                calories,
                ROUND(average_hr, 0)               AS avg_hr,
                ROUND(elevation_gain, 0)           AS elevation_gain_m,
                ROUND(avg_power, 0)                AS avg_power_w,
                ROUND(training_load, 1)            AS training_load,
                location_name                      AS location
             FROM activity ${where}
             ORDER BY start_time_local DESC
             LIMIT ?`,
          )
          .bind(...params, limit)
          .all();
        return text(rows.results);
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.tool(
    "garmin_trends",
    `Return trend data for a metric aggregated by week or month.

Supported metrics: ${Object.keys(TREND_METRICS).join(", ")}.
period: 'week' or 'month'.`,
    { metric: z.string(), period: z.string().default("month") },
    async ({ metric, period }) => {
      const cfg = TREND_METRICS[metric];
      if (!cfg) return text({ error: `Unknown metric '${metric}'. Choose from: ${Object.keys(TREND_METRICS).join(", ")}` });
      if (period !== "week" && period !== "month") return text({ error: "period must be 'week' or 'month'." });
      const group = period === "week" ? "strftime('%Y-W%W', calendar_date)" : "strftime('%Y-%m', calendar_date)";
      try {
        const rows = await db
          .prepare(
            `SELECT ${group} AS period, ${cfg.expr} AS value, COUNT(*) AS data_points
             FROM ${cfg.table} WHERE ${cfg.notNull} GROUP BY ${group} ORDER BY period`,
          )
          .all();
        return text({ metric, period, data: rows.results });
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.tool(
    "garmin_sync",
    `Starts the same Garmin sync the 30-minute schedule runs, in a Cloudflare container.

Returns immediately (status started/busy) unless wait_seconds > 0.
Refuses to start a second sync while one is running.`,
    { wait_seconds: z.number().int().default(0) },
    async ({ wait_seconds }) => {
      try {
        const stub = collector(env);
        let result: object = await stub.startSync();
        const deadline = Date.now() + wait_seconds * 1000;
        while (wait_seconds > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(5000, deadline - Date.now())));
          const status = await stub.status();
          result = status;
          if (!status.in_progress) break;
        }
        return text(result);
      } catch (error) {
        return text({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  server.tool(
    "garmin_brief",
    `Use this for 'how did I sleep / how am I today'.

Last night's sleep (wake date = today), sleep_pending flag, naps kept
separate, HRV last night vs baseline, readiness factors, today's steps,
last activity with weather, 14-day load, strength sets this week, weight
staleness, and data freshness. Never averaged.`,
    {},
    async () => text(await buildBrief(db, await collector(env).inProgress())),
  );

  return server;
}
