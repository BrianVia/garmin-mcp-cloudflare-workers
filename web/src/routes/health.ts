import { Hono } from "hono";
import type { Env } from "../server";

export const healthRoutes = new Hono<Env>();

function defaultRange(c: { req: { query: (k: string) => string | undefined } }) {
  const end = c.req.query("end") || new Date().toISOString().slice(0, 10);
  const days = parseInt(c.req.query("days") || "7", 10);
  const start =
    c.req.query("start") ||
    new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

// GET /api/health/summary
healthRoutes.get("/summary", async (c) => {
  const { start, end } = defaultRange(c);
  const db = c.env.DB;

  const [daily, sleep, training, endurance, hill, race] = await Promise.all([
    db
      .prepare(
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
        FROM daily_summary WHERE calendar_date BETWEEN ?1 AND ?2`
      )
      .bind(start, end)
      .first(),
    db
      .prepare(
        `SELECT
          ROUND(AVG(sleep_time_seconds) / 3600.0, 2)  AS avg_sleep_hours,
          ROUND(AVG(deep_sleep_seconds) / 60.0, 0)    AS avg_deep_min,
          ROUND(AVG(light_sleep_seconds) / 60.0, 0)   AS avg_light_min,
          ROUND(AVG(rem_sleep_seconds) / 60.0, 0)     AS avg_rem_min,
          ROUND(AVG(awake_sleep_seconds) / 60.0, 0)   AS avg_awake_min,
          ROUND(AVG(average_hr_sleep), 1)              AS avg_sleeping_hr
        FROM sleep WHERE calendar_date BETWEEN ?1 AND ?2`
      )
      .bind(start, end)
      .first(),
    db
      .prepare(
        `SELECT ROUND(AVG(score), 1) AS avg_training_readiness
        FROM training_readiness WHERE calendar_date BETWEEN ?1 AND ?2`
      )
      .bind(start, end)
      .first(),
    db
      .prepare(
        `SELECT ROUND(AVG(overall_score), 1) AS avg_endurance_score, ROUND(AVG(vo2_max_precise), 1) AS avg_vo2_max
        FROM endurance_score WHERE calendar_date BETWEEN ?1 AND ?2 AND overall_score IS NOT NULL`
      )
      .bind(start, end)
      .first(),
    db
      .prepare(
        `SELECT ROUND(AVG(overall_score), 1) AS avg_hill_score, ROUND(AVG(endurance_score), 1) AS avg_hill_endurance, ROUND(AVG(strength_score), 1) AS avg_hill_strength
        FROM hill_score WHERE calendar_date BETWEEN ?1 AND ?2 AND overall_score IS NOT NULL`
      )
      .bind(start, end)
      .first(),
    db
      .prepare(
        `SELECT ROUND(AVG(time_5k), 0) AS avg_time_5k_sec, ROUND(AVG(time_10k), 0) AS avg_time_10k_sec, ROUND(AVG(time_half_marathon), 0) AS avg_time_half_sec, ROUND(AVG(time_marathon), 0) AS avg_time_marathon_sec
        FROM race_predictions WHERE calendar_date BETWEEN ?1 AND ?2 AND time_5k IS NOT NULL`
      )
      .bind(start, end)
      .first(),
  ]);

  return c.json({
    period: { start, end },
    daily: daily ?? {},
    sleep: sleep ?? {},
    training_readiness: training ?? {},
    endurance: endurance ?? {},
    hill_score: hill ?? {},
    race_predictions: race ?? {},
  });
});

// GET /api/health/daily
healthRoutes.get("/daily", async (c) => {
  const { start, end } = defaultRange(c);
  const rows = await c.env.DB.prepare(
    `SELECT calendar_date, total_steps, resting_heart_rate, average_stress_level,
      body_battery_highest, body_battery_lowest, body_battery_most_recent,
      average_spo2, avg_waking_respiration, total_kilocalories, active_kilocalories,
      floors_ascended, moderate_intensity_minutes, vigorous_intensity_minutes
    FROM daily_summary WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
  )
    .bind(start, end)
    .all();
  return c.json(rows.results);
});

// GET /api/health/dashboard
healthRoutes.get("/dashboard", async (c) => {
  const db = c.env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const days14ago = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);

  const [daily14, sleep14, training14, hrv14, fitnessAge, battery14] = await Promise.all([
    db.prepare(
      `SELECT calendar_date, total_steps, daily_step_goal, resting_heart_rate,
        average_stress_level, body_battery_highest, body_battery_lowest,
        body_battery_charged, body_battery_drained, body_battery_at_wake,
        average_spo2, floors_ascended, total_kilocalories, active_kilocalories,
        moderate_intensity_minutes, vigorous_intensity_minutes, intensity_minutes_goal,
        low_stress_seconds, medium_stress_seconds, high_stress_seconds
      FROM daily_summary WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
    ).bind(days14ago, today).all(),
    db.prepare(
      `SELECT calendar_date,
        ROUND(sleep_time_seconds / 3600.0, 2) AS sleep_hours,
        ROUND(deep_sleep_seconds / 60.0, 0) AS deep_min,
        ROUND(light_sleep_seconds / 60.0, 0) AS light_min,
        ROUND(rem_sleep_seconds / 60.0, 0) AS rem_min,
        ROUND(awake_sleep_seconds / 60.0, 0) AS awake_min,
        average_hr_sleep, avg_sleep_stress
      FROM sleep WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
    ).bind(days14ago, today).all(),
    db.prepare(
      `SELECT calendar_date, score, level, feedback_short, recovery_time
      FROM training_readiness WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
    ).bind(days14ago, today).all(),
    db.prepare(
      `SELECT calendar_date, weekly_avg, last_night, status, baseline_low, baseline_upper
      FROM hrv WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
    ).bind(days14ago, today).all(),
    db.prepare(
      `SELECT calendar_date, chronological_age, fitness_age
      FROM fitness_age ORDER BY calendar_date DESC LIMIT 1`
    ).first(),
    db.prepare(
      `SELECT calendar_date, charged, drained, highest, lowest, most_recent, at_wake
      FROM body_battery WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
    ).bind(days14ago, today).all(),
  ]);

  return c.json({
    daily: daily14.results,
    sleep: sleep14.results,
    training: training14.results,
    hrv: hrv14.results,
    fitness_age: fitnessAge,
    body_battery: battery14.results,
  });
});

// GET /api/health/today
healthRoutes.get("/today", async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const db = c.env.DB;

  const [daily, sleep, hrv, training, battery] = await Promise.all([
    db.prepare(`SELECT * FROM daily_summary WHERE calendar_date = ?1`).bind(today).first(),
    db.prepare(`SELECT * FROM sleep WHERE calendar_date = ?1`).bind(today).first(),
    db.prepare(`SELECT * FROM hrv WHERE calendar_date = ?1`).bind(today).first(),
    db.prepare(`SELECT * FROM training_readiness WHERE calendar_date = ?1`).bind(today).first(),
    db.prepare(`SELECT * FROM body_battery WHERE calendar_date = ?1`).bind(today).first(),
  ]);

  return c.json({ date: today, daily, sleep, hrv, training_readiness: training, body_battery: battery });
});

// GET /api/health/sleep
healthRoutes.get("/sleep", async (c) => {
  const { start, end } = defaultRange(c);
  const rows = await c.env.DB.prepare(
    `SELECT calendar_date,
      ROUND(sleep_time_seconds / 3600.0, 2) AS sleep_hours,
      ROUND(deep_sleep_seconds / 60.0, 0) AS deep_min,
      ROUND(light_sleep_seconds / 60.0, 0) AS light_min,
      ROUND(rem_sleep_seconds / 60.0, 0) AS rem_min,
      ROUND(awake_sleep_seconds / 60.0, 0) AS awake_min,
      average_hr_sleep, average_spo2, avg_sleep_stress,
      sleep_score_feedback, sleep_score_insight
    FROM sleep WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
  )
    .bind(start, end)
    .all();
  return c.json(rows.results);
});

// GET /api/health/sleep/consistency
healthRoutes.get("/sleep/consistency", async (c) => {
  const { start, end } = defaultRange(c);
  const rows = await c.env.DB.prepare(
    `SELECT calendar_date, sleep_start_local, sleep_end_local,
      sleep_score_feedback, sleep_score_insight, personalized_insight
    FROM sleep_times WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
  )
    .bind(start, end)
    .all();
  return c.json(rows.results);
});

// GET /api/health/sleep/:date
healthRoutes.get("/sleep/:date", async (c) => {
  const date = c.req.param("date");
  const db = c.env.DB;

  const [summary, times, levels, heartRate, hrv, stress, bodyBattery, respiration] =
    await Promise.all([
      db
        .prepare(
          `SELECT calendar_date,
          ROUND(sleep_time_seconds / 3600.0, 2) AS sleep_hours,
          ROUND(deep_sleep_seconds / 60.0, 0) AS deep_min,
          ROUND(light_sleep_seconds / 60.0, 0) AS light_min,
          ROUND(rem_sleep_seconds / 60.0, 0) AS rem_min,
          ROUND(awake_sleep_seconds / 60.0, 0) AS awake_min,
          average_hr_sleep, average_spo2, avg_sleep_stress,
          sleep_score_feedback, sleep_score_insight
        FROM sleep WHERE calendar_date = ?1`
        )
        .bind(date)
        .first(),
      db
        .prepare(`SELECT * FROM sleep_times WHERE calendar_date = ?1`)
        .bind(date)
        .first(),
      db
        .prepare(
          `SELECT start_gmt, end_gmt, activity_level FROM sleep_levels WHERE calendar_date = ?1 ORDER BY start_gmt`
        )
        .bind(date)
        .all(),
      db
        .prepare(
          `SELECT timestamp_gmt, value FROM sleep_heart_rate WHERE calendar_date = ?1 ORDER BY timestamp_gmt`
        )
        .bind(date)
        .all(),
      db
        .prepare(
          `SELECT timestamp_gmt, value FROM sleep_hrv WHERE calendar_date = ?1 ORDER BY timestamp_gmt`
        )
        .bind(date)
        .all(),
      db
        .prepare(
          `SELECT timestamp_gmt, value FROM sleep_stress WHERE calendar_date = ?1 ORDER BY timestamp_gmt`
        )
        .bind(date)
        .all(),
      db
        .prepare(
          `SELECT timestamp_gmt, value FROM sleep_body_battery WHERE calendar_date = ?1 ORDER BY timestamp_gmt`
        )
        .bind(date)
        .all(),
      db
        .prepare(
          `SELECT timestamp_gmt, value FROM sleep_respiration WHERE calendar_date = ?1 ORDER BY timestamp_gmt`
        )
        .bind(date)
        .all(),
    ]);

  if (!summary) return c.json({ error: "No sleep data for this date" }, 404);

  return c.json({
    summary,
    times,
    levels: levels.results,
    heart_rate: heartRate.results,
    hrv: hrv.results,
    stress: stress.results,
    body_battery: bodyBattery.results,
    respiration: respiration.results,
  });
});

// GET /api/health/stress/:date (intraday)
healthRoutes.get("/stress/:date", async (c) => {
  const date = c.req.param("date");
  const db = c.env.DB;

  const [summary, stressData, batteryData] = await Promise.all([
    db.prepare(`SELECT * FROM stress WHERE calendar_date = ?1`).bind(date).first(),
    db.prepare(
      `SELECT timestamp_gmt, value FROM intraday_stress WHERE calendar_date = ?1 ORDER BY timestamp_gmt`
    ).bind(date).all(),
    db.prepare(
      `SELECT timestamp_gmt, value, status FROM intraday_body_battery WHERE calendar_date = ?1 ORDER BY timestamp_gmt`
    ).bind(date).all(),
  ]);

  const dailySummary = await db.prepare(
    `SELECT low_stress_seconds, medium_stress_seconds, high_stress_seconds,
      body_battery_charged, body_battery_drained, body_battery_highest, body_battery_lowest,
      body_battery_at_wake, body_battery_most_recent
    FROM daily_summary WHERE calendar_date = ?1`
  ).bind(date).first();

  return c.json({
    summary,
    daily: dailySummary,
    stress: stressData.results,
    body_battery: batteryData.results,
  });
});

// GET /api/health/heart-rate/:date (intraday)
healthRoutes.get("/heart-rate/:date", async (c) => {
  const date = c.req.param("date");
  const db = c.env.DB;

  const [summary, hrData] = await Promise.all([
    db.prepare(`SELECT * FROM heart_rate WHERE calendar_date = ?1`).bind(date).first(),
    db.prepare(
      `SELECT timestamp_gmt, value FROM intraday_heart_rate WHERE calendar_date = ?1 ORDER BY timestamp_gmt`
    ).bind(date).all(),
  ]);

  return c.json({
    summary,
    heart_rate: hrData.results,
  });
});

// GET /api/health/heart-rate
healthRoutes.get("/heart-rate", async (c) => {
  const { start, end } = defaultRange(c);
  const rows = await c.env.DB.prepare(
    `SELECT calendar_date, resting_hr, min_hr, max_hr, avg_hr
    FROM heart_rate WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
  )
    .bind(start, end)
    .all();
  return c.json(rows.results);
});

// GET /api/health/stress
healthRoutes.get("/stress", async (c) => {
  const { start, end } = defaultRange(c);
  const rows = await c.env.DB.prepare(
    `SELECT calendar_date, avg_stress, max_stress, stress_qualifier
    FROM stress WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
  )
    .bind(start, end)
    .all();
  return c.json(rows.results);
});

// GET /api/health/body-battery
healthRoutes.get("/body-battery", async (c) => {
  const { start, end } = defaultRange(c);
  const rows = await c.env.DB.prepare(
    `SELECT calendar_date, charged, drained, highest, lowest, most_recent, at_wake, during_sleep
    FROM body_battery WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
  )
    .bind(start, end)
    .all();
  return c.json(rows.results);
});

// GET /api/health/hrv
healthRoutes.get("/hrv", async (c) => {
  const { start, end } = defaultRange(c);
  const rows = await c.env.DB.prepare(
    `SELECT calendar_date, weekly_avg, last_night, last_night_avg, last_night_5min_high,
      status, baseline_low, baseline_upper
    FROM hrv WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
  )
    .bind(start, end)
    .all();
  return c.json(rows.results);
});

// GET /api/health/personal-records
healthRoutes.get("/personal-records", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT display_name, activity_type, pr_type, value, pr_date, activity_id
    FROM personal_record WHERE display_name IS NOT NULL AND display_name != '' ORDER BY pr_date DESC`
  ).all();
  return c.json(rows.results);
});

// GET /api/health/weight
// The weight table stores calendar_date as a Unix-epoch-seconds string; coerce
// to YYYY-MM-DD on the way out so clients get consistent ISO dates and the
// BETWEEN predicate works against the ISO range from defaultRange().
healthRoutes.get("/weight", async (c) => {
  const { start, end } = defaultRange(c);
  const dateExpr =
    "CASE WHEN typeof(calendar_date) IN ('integer','real') OR calendar_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' " +
    "THEN DATE(calendar_date, 'unixepoch') ELSE calendar_date END";
  const rows = await c.env.DB.prepare(
    `SELECT ${dateExpr} AS calendar_date, weight, bmi, body_fat, body_water, bone_mass, muscle_mass
    FROM weight
    WHERE ${dateExpr} BETWEEN ?1 AND ?2
    ORDER BY ${dateExpr}`
  )
    .bind(start, end)
    .all();
  return c.json(rows.results);
});

// GET /api/health/training
healthRoutes.get("/training", async (c) => {
  const { start, end } = defaultRange(c);
  const db = c.env.DB;

  const [readiness, endurance, hill, races] = await Promise.all([
    db
      .prepare(
        `SELECT calendar_date, score, level, feedback_short,
          recovery_time, recovery_time_factor_percent, hrv_factor_percent,
          hrv_weekly_average, sleep_history_factor_percent,
          stress_history_factor_percent, acwr_factor_percent
        FROM training_readiness WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
      )
      .bind(start, end)
      .all(),
    db
      .prepare(
        `SELECT calendar_date, overall_score, classification, vo2_max_precise
        FROM endurance_score WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
      )
      .bind(start, end)
      .all(),
    db
      .prepare(
        `SELECT calendar_date, overall_score, endurance_score, strength_score
        FROM hill_score WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
      )
      .bind(start, end)
      .all(),
    db
      .prepare(
        `SELECT calendar_date, time_5k, time_10k, time_half_marathon, time_marathon
        FROM race_predictions WHERE calendar_date BETWEEN ?1 AND ?2 ORDER BY calendar_date`
      )
      .bind(start, end)
      .all(),
  ]);

  return c.json({
    readiness: readiness.results,
    endurance: endurance.results,
    hill: hill.results,
    race_predictions: races.results,
  });
});
