// Turns Garmin responses into D1 rows. Port of save_to_db and the upserts in garmin_mcp/db.py, plus the
// per-minute tables from sync_sleep_detail.py and sync_intraday.py.
import { localNowIso } from "../brief";

type Json = Record<string, any>;
type Value = string | number | boolean | null | undefined;
type Row = Record<string, Value>;
export type Statement = [sql: string, params: unknown[]];

// D1 caps a bound value at 2 MB.
const MAX_ROWS_JSON = 900_000;

/** Columns that identify a row. A NULL here would add a junk row on every sync, so such rows are dropped. */
const KEYS: Record<string, string[]> = {
  activity: ["activity_id"], activity_splits: ["activity_id", "split_number"], activity_hr_zones: ["activity_id"],
  activity_weather: ["activity_id"], activity_exercise_sets: ["activity_id", "set_number"], activity_types: ["type_id"],
  workouts: ["workout_id"], personal_record: ["id"], device: ["device_id"], gear: ["gear_id"], goals: ["goal_id"],
  earned_badges: ["badge_id"], user_profile: ["key"], challenges: ["challenge_type"], training_plans: ["raw_json"],
  hr_zones: ["raw_json"], activity_trends: ["calendar_date", "activity_type"], vo2max: ["calendar_date", "sport"],
};
const hasKey = (table: string, row: Row) =>
  (KEYS[table] ?? ["calendar_date"]).every((key) => row[key] !== undefined && row[key] !== null && row[key] !== "");

/** Never let an unscored night replace a scored one, and keep the first time we saw a score. */
const SLEEP_CONFLICT = (columns: string[]) =>
  `ON CONFLICT(calendar_date) DO UPDATE SET ${columns
    .map((c) => `${c} = ${c === "scored_at" ? "COALESCE(sleep.scored_at, excluded.scored_at)" : `excluded.${c}`}`)
    .join(", ")} WHERE excluded.sleep_time_seconds IS NOT NULL OR sleep.sleep_time_seconds IS NULL`;

const DEVICE_CONFLICT = () =>
  `ON CONFLICT(device_id) DO UPDATE SET
     display_name = COALESCE(excluded.display_name, device.display_name),
     device_type = COALESCE(excluded.device_type, device.device_type),
     application_key = COALESCE(excluded.application_key, device.application_key),
     last_sync = COALESCE(excluded.last_sync, device.last_sync),
     raw_json = CASE WHEN length(excluded.raw_json) > length(device.raw_json) THEN excluded.raw_json ELSE device.raw_json END`;

const CONFLICTS: Record<string, (columns: string[]) => string> = { sleep: SLEEP_CONFLICT, device: DEVICE_CONFLICT };

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const records = (data: unknown): Json[] => (Array.isArray(data) ? data.filter(isObject) : isObject(data) ? [data] : []);
const raw = (value: unknown) => JSON.stringify(value);

/** {data: {scalarName: X}} -> X */
function unwrapGraphql(data: unknown): unknown {
  if (isObject(data) && "data" in data && Object.keys(data).length === 1) data = data.data;
  if (isObject(data)) {
    const values = Object.values(data);
    if (values.length === 1 && typeof values[0] === "object" && values[0] !== null) return values[0];
  }
  return data;
}

/** Daily results are unwrapped one extra time, and a lone `data` value is taken whatever its type. */
function flattenSingle(data: unknown): unknown {
  if (!isObject(data) || !("data" in data) || Object.keys(data).length !== 1) return data;
  const inner = data.data;
  return isObject(inner) && Object.keys(inner).length === 1 ? Object.values(inner)[0] : inner;
}

export class Writes {
  count = 0;
  private rows = new Map<string, Row[]>();
  private cleared = new Map<string, Statement>();
  private updates: Statement[] = [];

  private add(table: string, row: Row) {
    if (!hasKey(table, row)) return;
    const rows = this.rows.get(table);
    if (rows) rows.push(row);
    else this.rows.set(table, [row]);
    this.count++;
  }

  /** Replace the table (or one `kind` of row in it) with what this sync returns. */
  private clear(table: string, column?: string, kind?: string) {
    this.cleared.set(`${table}:${kind ?? ""}`, column ? [`DELETE FROM ${table} WHERE ${column} = ?1`, [kind]] : [`DELETE FROM ${table}`, []]);
    this.rows.set(table, (this.rows.get(table) ?? []).filter((row) => column !== undefined && row[column] !== kind));
  }

  private latest(table: string, date: string): Json | null {
    const rows = (this.rows.get(table) ?? []).filter((row) => row.calendar_date === date);
    const row = rows.findLast((r) => table !== "sleep" || r.sleep_time_seconds != null) ?? rows.at(-1);
    return row ? JSON.parse(row.raw_json as string) : null;
  }

  statements(): Statement[] {
    const inserts = [...this.rows].flatMap(([table, rows]): Statement[] => {
      if (rows.length === 0) return [];
      const columns = Object.keys(rows[0]!);
      const select = columns.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ");
      const conflict = CONFLICTS[table];
      const sql = `INSERT ${conflict ? "" : "OR REPLACE "}INTO ${table} (${columns.join(", ")}) SELECT ${select} FROM json_each(?1) WHERE true ${conflict?.(columns) ?? ""}`;
      return chunk(rows.map((row) => JSON.stringify(columns.map((c) => row[c] ?? null)))).map((param) => [sql, [param]]);
    });
    return [...this.cleared.values(), ...inserts, ...this.updates];
  }

  /** Store one endpoint's response. `key` is its date, or the activity id for per-activity endpoints. */
  save(endpoint: string, data: unknown, key?: string) {
    let name = endpoint;
    if (key && key.includes("-")) data = flattenSingle(data);
    if (name.startsWith("gql_")) {
      name = name.slice(4);
      data = unwrapGraphql(data);
    }
    if (name === "activities" || name.startsWith("activity_")) {
      if (this.saveActivity(name, data, key)) return;
    }
    if (name.startsWith("challenges_")) {
      const kind = name.slice("challenges_".length);
      const list = records(data);
      if (list.length > 0) this.clear("challenges", "challenge_type", kind);
      for (const r of list) this.add("challenges", { challenge_type: kind, raw_json: raw(r) });
      return;
    }
    if (name === "sync_timestamp" || ["personal_info", "user_settings", "social_profile", "user_profile_base"].includes(name)) {
      return this.add("user_profile", { key: name, raw_json: raw(data) });
    }
    if (name === "health_snapshot" || name === "sleep_stats") {
      for (const r of records(data)) this.add(name, { calendar_date: r.calendarDate || r.date, raw_json: raw(r) });
      return;
    }
    if (name === "hrv" || name === "hrv_daily") {
      // {hrvSummaries: [...]}
      const nested = isObject(data) ? Object.values(data).find(Array.isArray) : undefined;
      for (const r of records(nested ?? data)) this.add("hrv", hrv(r));
      return;
    }
    const handler = HANDLERS[name];
    if (!handler) return console.warn(`no handler for ${endpoint}`);
    const rows = records(data).map((r) => handler.row(r, key ?? (r.calendarDate || r.date), name));
    // An unusable response must not empty the table.
    if (handler.replace && rows.some((row) => hasKey(handler.table, row))) this.clear(handler.table);
    for (const row of rows) this.add(handler.table, row);
  }

  private saveActivity(name: string, data: unknown, key?: string): boolean {
    const id = Number(key);
    switch (name) {
      case "activities":
        for (const r of records(data)) this.add("activity", activity(r));
        return true;
      case "activity_splits": {
        const list = isObject(data) ? data.lapDTOs || data.splitDTOs || [data] : data;
        records(list).forEach((s, i) =>
          this.add("activity_splits", {
            activity_id: id, split_number: i + 1, distance_meters: s.distance, duration_seconds: s.duration,
            average_speed: s.averageSpeed, average_hr: s.averageHR, max_hr: s.maxHR, elevation_gain: s.elevationGain,
            elevation_loss: s.elevationLoss, avg_cadence: s.averageRunCadence || s.averageBikeCadence, raw_json: raw(s),
          }),
        );
        return true;
      }
      case "activity_hr_zones": {
        const zones = records(isObject(data) ? data.heartRateZones || [data] : data);
        const seconds = (n: number) => zones.findLast((z) => z.zoneNumber === n)?.secsInZone;
        this.add("activity_hr_zones", {
          activity_id: id, zone1_seconds: seconds(1), zone2_seconds: seconds(2), zone3_seconds: seconds(3),
          zone4_seconds: seconds(4), zone5_seconds: seconds(5), raw_json: raw(data),
        });
        return true;
      }
      case "activity_weather": {
        const r = isObject(data) ? data : {};
        this.add("activity_weather", {
          activity_id: id, temperature: r.temp || r.temperature, apparent_temperature: r.apparentTemp || r.apparentTemperature,
          humidity: r.relativeHumidity || r.humidity, wind_speed: r.windSpeed, wind_direction: r.windDirection,
          weather_type: isObject(r.weatherTypeDTO) ? r.weatherTypeDTO.desc : r.weatherType, raw_json: raw(data),
        });
        return true;
      }
      case "activity_exercise_sets": {
        const list = isObject(data) ? data.exerciseSets || [data] : data;
        records(list).forEach((s, i) =>
          this.add("activity_exercise_sets", {
            activity_id: id, set_number: i + 1, exercise_name: s.exerciseName, exercise_category: s.exerciseCategory,
            reps: s.repetitionCount || s.reps, weight: s.weight, duration_seconds: s.duration, raw_json: raw(s),
          }),
        );
        return true;
      }
      case "activity_details":
        // Shaped differently from the list, so it only refreshes raw_json.
        for (const r of records(data)) {
          if (r.activityId) this.updates.push(["UPDATE activity SET raw_json = ?1 WHERE activity_id = ?2", [raw(r), r.activityId]]);
        }
        return true;
    }
    return false;
  }

  /** Per-minute rows taken from the day's sleep, stress and heart-rate responses. */
  addDetail(date: string) {
    const sleepData = this.latest("sleep", date);
    if (sleepData) {
      const dto = sleepData.dailySleepDTO ?? {};
      this.add("sleep_times", {
        calendar_date: date, sleep_start_local: dto.sleepStartTimestampLocal, sleep_end_local: dto.sleepEndTimestampLocal,
        sleep_start_gmt: dto.sleepStartTimestampGMT, sleep_end_gmt: dto.sleepEndTimestampGMT,
        sleep_score_feedback: dto.sleepScoreFeedback, sleep_score_insight: dto.sleepScoreInsight,
        personalized_insight: dto.sleepScorePersonalizedInsight,
      });
      for (const l of records(sleepData.sleepLevels)) {
        this.add("sleep_levels", { calendar_date: date, start_gmt: l.startGMT, end_gmt: l.endGMT, activity_level: l.activityLevel });
      }
      const series: [string, unknown, string, string][] = [
        ["sleep_heart_rate", sleepData.sleepHeartRate, "startGMT", "value"],
        ["sleep_hrv", sleepData.hrvData, "startGMT", "value"],
        ["sleep_stress", sleepData.sleepStress, "startGMT", "value"],
        ["sleep_body_battery", sleepData.sleepBodyBattery, "startGMT", "value"],
        ["sleep_respiration", sleepData.wellnessEpochRespirationDataDTOList, "startTimeGMT", "respirationValue"],
      ];
      for (const [table, points, time, value] of series) {
        for (const p of records(points)) this.add(table, { calendar_date: date, timestamp_gmt: p[time], value: p[value] });
      }
    }
    const pairs = (value: unknown) => (Array.isArray(value) ? value.filter(Array.isArray) : []);
    const stress = this.latest("stress", date);
    for (const [time, value] of pairs(stress?.stressValuesArray)) {
      if (value >= 0) this.add("intraday_stress", { calendar_date: date, timestamp_gmt: time, value });
    }
    for (const [time, status, value] of pairs(stress?.bodyBatteryValuesArray)) {
      if (value != null) this.add("intraday_body_battery", { calendar_date: date, timestamp_gmt: time, value, status: status ?? "unknown" });
    }
    for (const [time, value] of pairs(this.latest("heart_rate", date)?.heartRateValues)) {
      if (value > 0) this.add("intraday_heart_rate", { calendar_date: date, timestamp_gmt: time, value });
    }
  }
}

function chunk(rows: string[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const row of rows) {
    const bytes = new TextEncoder().encode(row).length + 1;
    if (size + bytes > MAX_ROWS_JSON && current.length > 0) {
      chunks.push(`[${current.join(",")}]`);
      current = [];
      size = 0;
    }
    current.push(row);
    size += bytes;
  }
  return [...chunks, `[${current.join(",")}]`];
}

type Handler = { table: string; replace?: boolean; row: (r: Json, date: string | undefined, name: string) => Row };
const daily = (table: string, columns: (r: Json) => Row = () => ({})): Handler => ({
  table,
  row: (r, date) => ({ calendar_date: date, ...columns(r), raw_json: raw(r) }),
});

const bodyBattery = daily("body_battery", (r) => ({
  charged: r.bodyBatteryChargedValue || r.charged, drained: r.bodyBatteryDrainedValue || r.drained,
  highest: r.bodyBatteryHighestValue || r.highest, lowest: r.bodyBatteryLowestValue || r.lowest,
  most_recent: r.bodyBatteryMostRecentValue || r.mostRecent || r.most_recent,
  at_wake: r.bodyBatteryAtWakeTime || r.atWake || r.at_wake, during_sleep: r.bodyBatteryDuringSleep || r.duringSleep || r.during_sleep,
}));
const intensity = daily("intensity_minutes", (r) => ({
  moderate: r.moderateIntensityMinutes || r.weeklyModerate, vigorous: r.vigorousIntensityMinutes || r.weeklyVigorous,
  goal: r.intensityMinutesGoal || r.weeklyGoal,
}));
const heartRate = daily("heart_rate", (r) => ({
  resting_hr: r.restingHeartRate || r.restingHR, min_hr: r.minHeartRate || r.minHR, max_hr: r.maxHeartRate || r.maxHR,
  avg_hr: r.averageHeartRate || r.avgHR,
}));
const trainingStatus = daily("training_status", (r) => ({ status: r.trainingStatus || r.status }));
// Weigh-ins carry a ms epoch `date`; the table has always stored its first ten digits, and readers convert it.
const weight: Handler = {
  table: "weight",
  row: (r, date) => ({
    calendar_date: date === undefined ? undefined : String(date).slice(0, 10), weight: r.weight, bmi: r.bmi, body_fat: r.bodyFat,
    body_water: r.bodyWater, bone_mass: r.boneMass, muscle_mass: r.muscleMass, raw_json: raw(r),
  }),
};
const vo2max: Handler = {
  table: "vo2max",
  row: (r, date, name) => ({
    calendar_date: date, sport: name === "vo2max_cycling" ? "CYCLING" : "RUNNING",
    value: r.vo2MaxPreciseValue || r.value || r.generic, raw_json: raw(r),
  }),
};
const bloodPressure: Handler = {
  table: "blood_pressure",
  row: (r, date) => ({
    calendar_date: date || (r.measurementTimestampLocal ?? "").slice(0, 10), systolic: r.systolic, diastolic: r.diastolic,
    pulse: r.pulse, raw_json: raw(r),
  }),
};
const device: Handler = {
  table: "device",
  row: (r) => {
    const last = r.lastSyncTimestampGMT ?? r.lastSyncTime ?? r.lastSync ?? r.lastUsedDeviceUploadTime;
    return {
      device_id: r.deviceId || r.unitId, display_name: r.displayName, device_type: r.deviceTypeSimpleName,
      application_key: r.applicationKey,
      last_sync: typeof last === "number" ? new Date(last).toISOString().replace(/\.\d+Z$/, "+00:00") : last, raw_json: raw(r),
    };
  },
};
const gear: Handler = {
  table: "gear",
  row: (r) => ({
    gear_id: r.uuid || r.gearPk ? String(r.uuid || r.gearPk) : null, gear_type: r.gearTypeName, display_name: r.displayName,
    brand: r.customMakeModel || r.brandName, model: r.modelName, date_begin: r.dateBegin, raw_json: raw(r),
  }),
};
const trends: Handler = {
  table: "activity_trends",
  row: (r, date, name) => ({ calendar_date: date, activity_type: name.split("_").slice(2).join("_") || "all", raw_json: raw(r) }),
};
const sleep: Handler = { table: "sleep", row: sleepRow };

const HANDLERS: Record<string, Handler> = {
  daily_summary: { table: "daily_summary", row: dailySummary },
  daily_summaries: { table: "daily_summary", row: dailySummary },
  sleep, sleep_detail: sleep, sleep_summaries: sleep,
  heart_rate: heartRate, heart_rate_detail: heartRate,
  stress: daily("stress", (r) => ({
    avg_stress: r.averageStressLevel || r.overallStressLevel, max_stress: r.maxStressLevel || r.highStressDuration,
    stress_qualifier: r.stressQualifier,
  })),
  spo2: daily("spo2", (r) => ({
    avg_spo2: r.averageSpo2 || r.averageSpO2, min_spo2: r.lowestSpo2 || r.lowestSpO2, max_spo2: r.latestSpo2 || r.latestSpO2,
  })),
  respiration: daily("respiration", (r) => ({
    avg_waking: r.avgWakingRespirationValue, min_value: r.lowestRespirationValue, max_value: r.highestRespirationValue,
  })),
  body_battery_events: bodyBattery, body_battery_stress: bodyBattery,
  steps: daily("steps", (r) => ({
    total_steps: r.totalSteps || r.steps, goal: r.dailyStepGoal || r.stepGoal, distance_meters: r.totalDistanceMeters || r.totalDistance,
  })),
  floors: daily("floors", (r) => ({
    ascended: r.floorsAscended, descended: r.floorsDescended, goal: r.floorsAscendedGoal || r.floorGoal,
  })),
  intensity_minutes: intensity, intensity_minutes_weekly: intensity,
  hydration: daily("hydration", (r) => ({ goal_ml: r.goalInML || r.baseGoalInML, intake_ml: r.intakeInML || r.valueInML })),
  fitness_age: daily("fitness_age", (r) => ({ chronological_age: r.chronologicalAge, fitness_age: r.fitnessAge })),
  daily_movement: daily("daily_movement"),
  wellness_activity: daily("wellness_activity"),
  daily_events: daily("daily_events"),
  training_status_daily: trainingStatus, training_status_weekly: trainingStatus,
  health_status: daily("health_status", (r) => ({ overall_status: r.overallStatus })),
  activity_trends_all: trends, activity_trends_running: trends, activity_trends_cycling: trends,
  activity_stats_all: trends, activity_stats_running: trends, activity_stats_cycling: trends,
  weight_first: weight, weight_range: weight, weight_latest: weight, weight, weight_range_rest: weight, goal_weight: weight,
  vo2max_trend: vo2max, vo2max_running: vo2max, vo2max_cycling: vo2max,
  blood_pressure: bloodPressure, blood_pressure_rest: bloodPressure,
  calories: daily("calories", (r) => ({
    total: r.totalKilocalories, active: r.activeKilocalories, bmr: r.bmrKilocalories, consumed: r.consumedKilocalories,
    remaining: r.remainingKilocalories,
  })),
  endurance_score: daily("endurance_score", (r) => ({
    overall_score: r.overallScore, classification: r.classification, vo2_max: r.vo2Max, vo2_max_precise: r.vo2MaxPreciseValue,
  })),
  hill_score: daily("hill_score", (r) => ({
    overall_score: r.overallScore, endurance_score: r.enduranceScore, strength_score: r.strengthScore,
  })),
  race_predictions: daily("race_predictions", (r) => ({
    time_5k: r.time5K || r.time5k, time_10k: r.time10K || r.time10k, time_half_marathon: r.timeHalfMarathon || r.timeHalf,
    time_marathon: r.timeMarathon,
  })),
  workout_schedule: {
    table: "workout_schedule",
    row: (r) => ({ calendar_date: r.calendarDate || r.scheduleDate || r.date, raw_json: raw(r) }),
  },
  workouts: {
    table: "workouts",
    row: (r) => ({
      workout_id: r.workoutId, workout_name: r.workoutName, sport_type: r.sportType?.sportTypeKey, created_date: r.createdDate,
      updated_date: r.updateDate, raw_json: raw(r),
    }),
  },
  training_readiness: {
    table: "training_readiness",
    row: (r) => ({
      calendar_date: r.calendarDate, score: r.score, level: r.level, feedback_short: r.feedbackShort, feedback_long: r.feedbackLong,
      recovery_time: r.recoveryTime, recovery_time_factor_percent: r.recoveryTimeFactorPercent,
      recovery_time_factor_feedback: r.recoveryTimeFactorFeedback, hrv_factor_percent: r.hrvFactorPercent,
      hrv_factor_feedback: r.hrvFactorFeedback, hrv_weekly_average: r.hrvWeeklyAverage,
      sleep_history_factor_percent: r.sleepHistoryFactorPercent, sleep_history_factor_feedback: r.sleepHistoryFactorFeedback,
      stress_history_factor_percent: r.stressHistoryFactorPercent, stress_history_factor_feedback: r.stressHistoryFactorFeedback,
      acwr_factor_percent: r.acwrFactorPercent, acwr_factor_feedback: r.acwrFactorFeedback, raw_json: raw(r),
    }),
  },
  personal_records: {
    table: "personal_record",
    replace: true,
    row: (r) => ({
      id: r.id, display_name: r.activityName, activity_type: r.activityType, pr_type: r.typeId == null ? null : String(r.typeId),
      value: r.value, pr_date: (r.actStartDateTimeInGMTFormatted || "").slice(0, 10) || null, activity_id: r.activityId, raw_json: raw(r),
    }),
  },
  devices: device, devices_historical: device, last_used_device: device, sensors: device,
  gear_list: gear, gear_types: gear,
  user_goals: {
    table: "goals",
    row: (r) => ({ goal_id: r.id || r.goalId, goal_type: r.goalType, goal_value: r.goalValue, raw_json: raw(r) }),
  },
  activity_types: {
    table: "activity_types",
    row: (r) => ({ type_id: r.typeId, type_key: r.typeKey, parent_type_id: r.parentTypeId, raw_json: raw(r) }),
  },
  hr_zones: { table: "hr_zones", replace: true, row: (r) => ({ raw_json: raw(r) }) },
  training_plans: { table: "training_plans", replace: true, row: (r) => ({ raw_json: raw(r) }) },
  earned_badges: {
    table: "earned_badges",
    replace: true,
    row: (r) => ({
      badge_id: r.badgeId || r.id, badge_key: r.badgeKey, badge_name: r.badgeName || r.displayName,
      badge_category: r.badgeCategoryName || r.badgeCategory, earned_date: r.badgeEarnedDate || r.earnedDate,
      earned_number: r.badgeEarnedNumber || r.earnedNumber, raw_json: raw(r),
    }),
  },
};

function hrv(r: Json): Row {
  const baseline = isObject(r.baseline) ? r.baseline : {};
  return {
    calendar_date: r.calendarDate || (r.startTimestampLocal ?? "").slice(0, 10), weekly_avg: r.weeklyAvg,
    // Garmin's GraphQL scalar omits lastNight; lastNightAvg is the same number the app shows.
    last_night: r.lastNight || r.lastNightAvg, last_night_avg: r.lastNightAvg || r.lastNight5MinHigh,
    last_night_5min_high: r.lastNight5MinHigh, status: r.status,
    baseline_low: r.baselineLowUpper ?? baseline.lowUpper, baseline_upper: r.baselineBalancedUpper ?? baseline.balancedUpper,
    start_timestamp: r.startTimestampLocal || r.startTimestampGMT, end_timestamp: r.endTimestampLocal || r.endTimestampGMT, raw_json: raw(r),
  };
}

/** calendar_date is the wake date; a NULL sleep_time_seconds means Garmin has not scored the night yet. */
function sleepRow(record: Json): Row {
  const dto: Json = isObject(record.dailySleepDTO) ? record.dailySleepDTO : record;
  const seconds = dto.sleepTimeSeconds ?? null;
  return {
    calendar_date: dto.calendarDate || record.date, sleep_time_seconds: seconds, nap_time_seconds: dto.napTimeSeconds,
    deep_sleep_seconds: dto.deepSleepSeconds, light_sleep_seconds: dto.lightSleepSeconds, rem_sleep_seconds: dto.remSleepSeconds,
    awake_sleep_seconds: dto.awakeSleepSeconds, unmeasurable_sleep_seconds: dto.unmeasurableSleepSeconds,
    awake_count: dto.awakeSleepCount || dto.awakeCount, average_spo2: dto.averageSpO2Value, lowest_spo2: dto.lowestSpO2Value,
    average_hr_sleep: dto.avgHeartRate || dto.averageHrSleep || dto.avgSleepHR, average_respiration: dto.averageRespirationValue,
    lowest_respiration: dto.lowestRespirationValue, highest_respiration: dto.highestRespirationValue,
    avg_sleep_stress: dto.avgSleepStress, sleep_score_feedback: dto.sleepScoreFeedback, sleep_score_insight: dto.sleepScoreInsight,
    scored_at: seconds === null ? null : localNowIso(), raw_json: raw(record),
  };
}

function dailySummary(r: Json): Row {
  return {
    calendar_date: r.calendarDate, total_steps: r.totalSteps, daily_step_goal: r.dailyStepGoal, total_distance_meters: r.totalDistanceMeters,
    total_kilocalories: r.totalKilocalories, active_kilocalories: r.activeKilocalories, bmr_kilocalories: r.bmrKilocalories,
    remaining_kilocalories: r.remainingKilocalories, highly_active_seconds: r.highlyActiveSeconds, active_seconds: r.activeSeconds,
    sedentary_seconds: r.sedentarySeconds, sleeping_seconds: r.sleepingSeconds, moderate_intensity_minutes: r.moderateIntensityMinutes,
    vigorous_intensity_minutes: r.vigorousIntensityMinutes, intensity_minutes_goal: r.intensityMinutesGoal,
    floors_ascended: r.floorsAscended, floors_descended: r.floorsDescended, floors_ascended_goal: r.floorsAscendedGoal,
    min_heart_rate: r.minHeartRate, max_heart_rate: r.maxHeartRate, resting_heart_rate: r.restingHeartRate,
    avg_resting_heart_rate_7day: r.averageRestingHeartRate, average_stress_level: r.averageStressLevel, max_stress_level: r.maxStressLevel,
    low_stress_seconds: r.lowStressSeconds, medium_stress_seconds: r.mediumStressSeconds, high_stress_seconds: r.highStressSeconds,
    stress_qualifier: r.stressQualifier, body_battery_charged: r.bodyBatteryChargedValue, body_battery_drained: r.bodyBatteryDrainedValue,
    body_battery_highest: r.bodyBatteryHighestValue, body_battery_lowest: r.bodyBatteryLowestValue,
    body_battery_most_recent: r.bodyBatteryMostRecentValue, body_battery_at_wake: r.bodyBatteryAtWakeTime,
    body_battery_during_sleep: r.bodyBatteryDuringSleep, average_spo2: r.averageSpo2, lowest_spo2: r.lowestSpo2, latest_spo2: r.latestSpo2,
    avg_waking_respiration: r.avgWakingRespirationValue, highest_respiration: r.highestRespirationValue,
    lowest_respiration: r.lowestRespirationValue, source: r.source, raw_json: raw(r),
  };
}

function activity(r: Json): Row {
  const type = isObject(r.activityType) ? r.activityType : {};
  return {
    activity_id: r.activityId, activity_name: r.activityName, activity_type: type.typeKey, activity_type_id: type.typeId,
    parent_type_id: type.parentTypeId, start_time_local: r.startTimeLocal, start_time_gmt: r.startTimeGMT, duration_seconds: r.duration,
    elapsed_duration_seconds: r.elapsedDuration, moving_duration_seconds: r.movingDuration, distance_meters: r.distance,
    calories: r.calories, bmr_calories: r.bmrCalories, average_hr: r.averageHR, max_hr: r.maxHR, average_speed: r.averageSpeed,
    max_speed: r.maxSpeed, elevation_gain: r.elevationGain, elevation_loss: r.elevationLoss, min_elevation: r.minElevation,
    max_elevation: r.maxElevation, avg_power: r.avgPower, max_power: r.maxPower, norm_power: r.normPower,
    training_stress_score: r.trainingStressScore, intensity_factor: r.intensityFactor, aerobic_training_effect: r.aerobicTrainingEffect,
    anaerobic_training_effect: r.anaerobicTrainingEffect, vo2max_value: r.vO2MaxValue,
    avg_cadence: r.averageRunningCadenceInStepsPerMinute || r.averageBikingCadenceInRevPerMinute || r.averageCadence,
    max_cadence: r.maxRunningCadenceInStepsPerMinute || r.maxBikingCadenceInRevPerMinute || r.maxCadence,
    avg_respiration: r.avgRespirationRate, training_load: r.activityTrainingLoad, moderate_intensity_minutes: r.moderateIntensityMinutes,
    vigorous_intensity_minutes: r.vigorousIntensityMinutes, start_latitude: r.startLatitude, start_longitude: r.startLongitude,
    end_latitude: r.endLatitude, end_longitude: r.endLongitude, location_name: r.locationName, lap_count: r.lapCount,
    water_estimated: r.waterEstimated, min_temperature: r.minTemperature, max_temperature: r.maxTemperature, manufacturer: r.manufacturer,
    device_id: r.deviceId, raw_json: raw(r),
  };
}
