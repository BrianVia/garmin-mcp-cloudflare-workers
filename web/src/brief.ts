// Port of garmin_mcp/db.py build_brief: the local-day morning brief from stored data only.
type Row = Record<string, any>;

export const TIMEZONE = "America/New_York";

/** Today's date (YYYY-MM-DD) in the owner's timezone. */
export const localToday = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(now);

export const addDays = (isoDate: string, days: number) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Local time as ISO 8601 with offset, e.g. 2026-09-23T09:30:00-04:00. */
export function localNowIso(now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE, hourCycle: "h23", timeZoneName: "longOffset",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName!.slice(3);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

const pick = (row: Row, keys: string[]) => Object.fromEntries(keys.map((key) => [key, row[key]]));
const omit = (row: Row, keys: string[]) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));

export async function buildBrief(db: D1Database, syncInProgress: boolean) {
  const dateText = localToday();
  const windowStart = addDays(dateText, -13);
  const weekStart = addDays(dateText, -((new Date(`${dateText}T00:00:00Z`).getUTCDay() + 6) % 7));

  const [freshnessRes, sleepRes, hrvRes, readinessRes, dailyRes, activityRes, loadRes, weightRes] = await db.batch<Row>([
    db.prepare(
      `SELECT
         (SELECT sync_date FROM sync_log WHERE status = 'ok'
          ORDER BY sync_date DESC, id DESC LIMIT 1) AS last_sync_ok,
         (SELECT sync_date FROM sync_log ORDER BY sync_date DESC, id DESC LIMIT 1) AS attempt_at,
         (SELECT status FROM sync_log ORDER BY sync_date DESC, id DESC LIMIT 1) AS attempt_status,
         (SELECT error FROM sync_log ORDER BY sync_date DESC, id DESC LIMIT 1) AS attempt_error,
         COALESCE(
           (SELECT last_sync FROM device WHERE last_sync IS NOT NULL ORDER BY last_sync DESC LIMIT 1),
           (SELECT json_extract(raw_json, '$') FROM user_profile WHERE key = 'sync_timestamp')
         ) AS garmin_last_reported`,
    ),
    db.prepare(
      `WITH current AS (
           SELECT * FROM sleep WHERE calendar_date = ?
         ), last AS (
           SELECT calendar_date, ROUND(sleep_time_seconds / 3600.0, 2) AS hours,
                  sleep_score_feedback AS feedback
           FROM sleep WHERE sleep_time_seconds IS NOT NULL
           ORDER BY calendar_date DESC LIMIT 1
         )
         SELECT current.sleep_time_seconds,
                CAST(ROUND(current.deep_sleep_seconds / 60.0) AS INTEGER) AS deep_min,
                CAST(ROUND(current.light_sleep_seconds / 60.0) AS INTEGER) AS light_min,
                CAST(ROUND(current.rem_sleep_seconds / 60.0) AS INTEGER) AS rem_min,
                CAST(ROUND(current.awake_sleep_seconds / 60.0) AS INTEGER) AS awake_min,
                current.awake_count, current.average_hr_sleep AS avg_hr,
                current.average_spo2 AS avg_spo2, current.avg_sleep_stress AS avg_stress,
                current.sleep_score_feedback AS feedback, current.sleep_score_insight AS insight,
                CAST(ROUND(current.nap_time_seconds / 60.0) AS INTEGER) AS nap_minutes,
                current.scored_at, last.calendar_date AS last_calendar_date,
                last.hours AS last_hours, last.feedback AS last_feedback
         FROM (SELECT 1) LEFT JOIN current ON 1 LEFT JOIN last ON 1`,
    ).bind(dateText),
    db.prepare(
      `SELECT calendar_date, COALESCE(last_night, last_night_avg) AS last_night,
              baseline_low, baseline_upper, status, weekly_avg
       FROM hrv ORDER BY calendar_date DESC LIMIT 1`,
    ),
    db.prepare(
      `SELECT calendar_date, score, level, feedback_short,
              sleep_history_factor_percent AS sleep,
              hrv_factor_percent AS hrv,
              recovery_time_factor_percent AS recovery_time,
              stress_history_factor_percent AS stress,
              acwr_factor_percent AS acwr
       FROM training_readiness ORDER BY calendar_date DESC LIMIT 1`,
    ),
    db.prepare(
      `SELECT total_steps AS steps, resting_heart_rate AS resting_hr,
              average_stress_level AS stress_avg, body_battery_at_wake,
              body_battery_most_recent,
              moderate_intensity_minutes + vigorous_intensity_minutes AS intensity_minutes
       FROM daily_summary WHERE calendar_date = ?`,
    ).bind(dateText),
    db.prepare(
      `SELECT a.activity_id, a.activity_name AS name, a.activity_type AS type,
              a.start_time_local AS start, ROUND(a.duration_seconds / 60.0, 1) AS duration_min,
              ROUND(a.distance_meters / 1000.0, 2) AS distance_km,
              a.average_hr AS avg_hr, a.training_load,
              w.temperature, w.apparent_temperature, w.humidity, w.weather_type
       FROM activity a LEFT JOIN activity_weather w USING (activity_id)
       ORDER BY a.start_time_local DESC LIMIT 1`,
    ),
    db.prepare(
      `SELECT
         (SELECT SUM(training_load) FROM activity WHERE DATE(start_time_local) >= ?) AS training_load_sum,
         (SELECT COUNT(*) FROM activity WHERE DATE(start_time_local) >= ?) AS activity_count,
         COUNT(DISTINCT s.activity_id) AS strength_sessions_this_week,
         COUNT(*) AS sets_this_week
       FROM activity_exercise_sets s JOIN activity a USING (activity_id)
       WHERE DATE(a.start_time_local) >= ?`,
    ).bind(windowStart, windowStart, weekStart),
    db.prepare(
      `WITH normalized AS (
           SELECT CASE
             WHEN calendar_date GLOB '[0-9]*' AND length(calendar_date) = 10
                  AND calendar_date NOT LIKE '%-%' THEN date(calendar_date, 'unixepoch')
             ELSE calendar_date END AS calendar_date
           FROM weight
         )
         SELECT calendar_date AS last_date,
                CAST(julianday(?) - julianday(calendar_date) AS INTEGER) AS days_ago
         FROM normalized WHERE calendar_date IS NOT NULL
         ORDER BY calendar_date DESC LIMIT 1`,
    ).bind(dateText),
  ]);
  const first = (res: D1Result<Row> | undefined): Row | null => res?.results[0] ?? null;

  const freshness = first(freshnessRes)!;
  const lastAttempt =
    freshness.attempt_at !== null || freshness.attempt_status !== null
      ? { at: freshness.attempt_at, status: freshness.attempt_status, error: freshness.attempt_error }
      : null;

  const sleepRow = first(sleepRes);
  const sleep = {
    calendar_date: dateText,
    pending: sleepRow === null || sleepRow.sleep_time_seconds === null,
    hours: sleepRow?.sleep_time_seconds != null ? Math.round(sleepRow.sleep_time_seconds / 36) / 100 : null,
    ...Object.fromEntries(
      ["deep_min", "light_min", "rem_min", "awake_min", "awake_count", "avg_hr", "avg_spo2", "avg_stress", "feedback", "insight", "nap_minutes"]
        .map((key) => [key, sleepRow?.[key] ?? null]),
    ),
    last_scored:
      sleepRow?.last_calendar_date != null
        ? { calendar_date: sleepRow.last_calendar_date, hours: sleepRow.last_hours, feedback: sleepRow.last_feedback }
        : null,
  };

  const factorKeys = ["sleep", "hrv", "recovery_time", "stress", "acwr"];
  const readinessRow = first(readinessRes);
  const readiness = readinessRow && { ...omit(readinessRow, factorKeys), factors: pick(readinessRow, factorKeys) };

  const weatherKeys = ["temperature", "apparent_temperature", "humidity", "weather_type"];
  const activityRow = first(activityRes);
  const weather = activityRow && pick(activityRow, weatherKeys);
  const activity = activityRow && {
    ...omit(activityRow, weatherKeys),
    weather: weather && Object.values(weather).some((value) => value !== null) ? weather : null,
  };

  const weight = first(weightRes) ?? { last_date: null, days_ago: null };

  return {
    date: dateText,
    generated_at: localNowIso(),
    timezone: TIMEZONE,
    freshness: {
      last_sync_ok: freshness.last_sync_ok,
      last_sync_attempt: lastAttempt,
      sync_in_progress: syncInProgress,
      garmin_last_reported: freshness.garmin_last_reported,
      sleep_scored_at: sleepRow?.scored_at ?? null,
    },
    sleep,
    hrv: first(hrvRes),
    readiness,
    today: first(dailyRes),
    last_activity: activity,
    load: { days: 14, ...first(loadRes) },
    weight: { ...weight, scale_dead: weight.days_ago === null || weight.days_ago > 30 },
  };
}
