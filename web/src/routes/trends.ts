import { Hono } from "hono";
import type { Env } from "../server";

export const trendRoutes = new Hono<Env>();

const METRICS: Record<string, { table: string; expr: string; notNull: string; dateCol: string }> = {
  resting_hr: {
    table: "daily_summary",
    expr: "ROUND(AVG(resting_heart_rate), 1)",
    notNull: "resting_heart_rate IS NOT NULL",
    dateCol: "calendar_date",
  },
  stress: {
    table: "daily_summary",
    expr: "ROUND(AVG(average_stress_level), 1)",
    notNull: "average_stress_level IS NOT NULL",
    dateCol: "calendar_date",
  },
  steps: {
    table: "daily_summary",
    expr: "ROUND(AVG(total_steps), 0)",
    notNull: "total_steps IS NOT NULL",
    dateCol: "calendar_date",
  },
  sleep_hours: {
    table: "sleep",
    expr: "ROUND(AVG(sleep_time_seconds) / 3600.0, 2)",
    notNull: "sleep_time_seconds IS NOT NULL",
    dateCol: "calendar_date",
  },
  body_battery: {
    table: "daily_summary",
    expr: "ROUND(AVG(body_battery_highest), 1)",
    notNull: "body_battery_highest IS NOT NULL",
    dateCol: "calendar_date",
  },
  spo2: {
    table: "daily_summary",
    expr: "ROUND(AVG(average_spo2), 1)",
    notNull: "average_spo2 IS NOT NULL",
    dateCol: "calendar_date",
  },
  training_readiness: {
    table: "training_readiness",
    expr: "ROUND(AVG(score), 1)",
    notNull: "score IS NOT NULL",
    dateCol: "calendar_date",
  },
  floors: {
    table: "daily_summary",
    expr: "ROUND(AVG(floors_ascended), 1)",
    notNull: "floors_ascended IS NOT NULL",
    dateCol: "calendar_date",
  },
  calories: {
    table: "daily_summary",
    expr: "ROUND(AVG(total_kilocalories), 0)",
    notNull: "total_kilocalories IS NOT NULL",
    dateCol: "calendar_date",
  },
  active_minutes: {
    table: "daily_summary",
    expr: "ROUND(AVG(moderate_intensity_minutes + vigorous_intensity_minutes), 0)",
    notNull: "moderate_intensity_minutes IS NOT NULL",
    dateCol: "calendar_date",
  },
  respiration: {
    table: "daily_summary",
    expr: "ROUND(AVG(avg_waking_respiration), 1)",
    notNull: "avg_waking_respiration IS NOT NULL",
    dateCol: "calendar_date",
  },
  weight: {
    table: "weight",
    expr: "ROUND(AVG(weight), 2)",
    notNull: "weight IS NOT NULL",
    dateCol: "calendar_date",
  },
  hrv: {
    table: "hrv",
    // Chart per-night HRV — this is what reacts to sleep, training, and stress.
    // last_night_avg is the overnight mean; last_night falls through to it when
    // Garmin's API omits the single-value field.
    expr: "ROUND(AVG(COALESCE(last_night, last_night_avg)), 1)",
    notNull: "COALESCE(last_night, last_night_avg) IS NOT NULL",
    dateCol: "calendar_date",
  },
  hrv_weekly: {
    table: "hrv",
    // Garmin's own 7-day rolling average — heavily smoothed; useful only for
    // long-horizon (month+) views, not daily/weekly trend reading.
    expr: "ROUND(AVG(weekly_avg), 1)",
    notNull: "weekly_avg IS NOT NULL",
    dateCol: "calendar_date",
  },
  endurance_score: {
    table: "endurance_score",
    expr: "ROUND(AVG(overall_score), 1)",
    notNull: "overall_score IS NOT NULL",
    dateCol: "calendar_date",
  },
  hill_score: {
    table: "hill_score",
    expr: "ROUND(AVG(overall_score), 1)",
    notNull: "overall_score IS NOT NULL",
    dateCol: "calendar_date",
  },
  race_5k: {
    table: "race_predictions",
    expr: "ROUND(AVG(time_5k), 0)",
    notNull: "time_5k IS NOT NULL",
    dateCol: "calendar_date",
  },
  race_10k: {
    table: "race_predictions",
    expr: "ROUND(AVG(time_10k), 0)",
    notNull: "time_10k IS NOT NULL",
    dateCol: "calendar_date",
  },
};

// GET /api/trends/metrics
trendRoutes.get("/metrics", (c) => {
  return c.json(Object.keys(METRICS));
});

// GET /api/trends/:metric
trendRoutes.get("/:metric", async (c) => {
  const metric = c.req.param("metric");
  const period = c.req.query("period") || "week";

  const cfg = METRICS[metric];
  if (!cfg) {
    return c.json({ error: `Unknown metric '${metric}'. Options: ${Object.keys(METRICS).join(", ")}` }, 400);
  }
  if (period !== "week" && period !== "month" && period !== "daily") {
    return c.json({ error: "period must be 'daily', 'week', or 'month'" }, 400);
  }

  if (period === "daily") {
    // Return raw daily values, not aggregated
    // Extract the base column from the expr (e.g., "ROUND(AVG(resting_heart_rate), 1)" → use direct column)
    const rows = await c.env.DB.prepare(
      `SELECT ${cfg.dateCol} AS period, ${cfg.expr} AS value, 1 AS data_points
      FROM ${cfg.table}
      WHERE ${cfg.notNull}
      GROUP BY ${cfg.dateCol}
      ORDER BY ${cfg.dateCol}`
    ).all();
    return c.json({ metric, period, data: rows.results });
  }

  const groupExpr =
    period === "week"
      ? `strftime('%Y-W%W', ${cfg.dateCol})`
      : `strftime('%Y-%m', ${cfg.dateCol})`;

  const rows = await c.env.DB.prepare(
    `SELECT ${groupExpr} AS period, ${cfg.expr} AS value, COUNT(*) AS data_points
    FROM ${cfg.table}
    WHERE ${cfg.notNull}
    GROUP BY ${groupExpr}
    ORDER BY period`
  ).all();

  return c.json({ metric, period, data: rows.results });
});
