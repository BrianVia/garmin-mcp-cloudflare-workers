// Garmin Connect endpoints, ported from garmin_client/endpoints.py.
// Dropped: endpoints whose data is never stored, and goals / stats_daily, which always return 400.

/** `body` is a GraphQL query (POST); without it, `path` is a REST GET. */
export type Endpoint = { name: string; path: string; body?: string; date?: string };

const rest = (entries: Record<string, string>, date?: string): Endpoint[] =>
  Object.entries(entries).map(([name, path]) => ({ name, path: `/gc-api${path}`, date }));

const gql = (entries: Record<string, string>, date?: string): Endpoint[] =>
  Object.entries(entries).map(([name, query]) => ({
    name: `gql_${name}`,
    path: "/gc-api/graphql-gateway/graphql",
    body: JSON.stringify({ query }),
    date,
  }));

const PROFILE: Endpoint[] = [
  ...rest({
    personal_info: "/userprofile-service/userprofile/personal-information",
    user_settings: "/userprofile-service/userprofile/user-settings/",
    social_profile: "/userprofile-service/socialProfile",
    user_profile_base: "/userprofile-service/userprofile/userProfileBase",
    devices: "/device-service/deviceregistration/devices",
    devices_historical: "/device-service/deviceregistration/devices/historical",
    last_used_device: "/device-service/deviceservice/mylastused",
    sensors: "/device-service/sensors",
    hr_zones: "/biometric-service/heartRateZones/",
    training_plans: "/trainingplan-service/trainingplan/plans?limit=50",
    sync_timestamp: "/wellness-service/wellness/syncTimestamp",
    activity_types: "/activity-service/activity/activityTypes",
    gear_list: "/gear-service/gear/v2/list",
    gear_types: "/gear-service/gear/v2/user-gear-types",
    weight_first: "/weight-service/weight/first",
    earned_badges: "/badge-service/badge/earned",
    workouts: "/workout-service/workouts?start=0&limit=100",
  }),
  ...gql({
    user_goals: "query { userGoalsScalar }",
    challenges_adhoc: "query { adhocChallengesScalar }",
    challenges_badge: "query { badgeChallengesScalar }",
    challenges_expeditions: "query { expeditionsChallengesScalar }",
  }),
];

const range = (dn: string, start: string, end: string): Endpoint[] => [
  ...rest({
    weight_range: `/weight-service/weight/dateRange?startDate=${start}&endDate=${end}`,
    weight_latest: `/weight-service/weight/latest?date=${end}`,
    vo2max_trend: `/metrics-service/metrics/maxmet/daily/${start}/${end}`,
    personal_records: `/personalrecord-service/personalrecord/prs/${dn}`,
  }),
  ...gql({
    daily_summaries: `query{userDailySummaryV2Scalar(startDate:"${start}", endDate:"${end}")}`,
    hrv: `query{heartRateVariabilityScalar(startDate:"${start}", endDate:"${end}")}`,
    training_readiness: `query{trainingReadinessRangeScalar(startDate:"${start}", endDate:"${end}")}`,
    training_status_weekly: `query{trainingStatusWeeklyScalar(startDate:"${start}", endDate:"${end}", displayName:"${dn}")}`,
    vo2max_running: `query{vo2MaxScalar(startDate:"${start}", endDate:"${end}", sport:"RUNNING")}`,
    vo2max_cycling: `query{vo2MaxScalar(startDate:"${start}", endDate:"${end}", sport:"CYCLING")}`,
    weight: `query{weightScalar(startDate:"${start}", endDate:"${end}")}`,
    blood_pressure: `query{bloodPressureScalar(startDate:"${start}", endDate:"${end}")}`,
    activity_stats_all: `query{activityStatsScalar(aggregation:"daily", startDate:"${start}", endDate:"${end}", activityType:"all")}`,
    activity_stats_running: `query{activityStatsScalar(aggregation:"daily", startDate:"${start}", endDate:"${end}", activityType:"running")}`,
    activity_stats_cycling: `query{activityStatsScalar(aggregation:"daily", startDate:"${start}", endDate:"${end}", activityType:"cycling")}`,
  }),
  ...rest({
    sleep_stats: `/sleep-service/stats/sleep/daily/${start}/${end}`,
    hrv_daily: `/hrv-service/hrv/daily/${start}/${end}`,
    blood_pressure_rest: `/bloodpressure-service/bloodpressure/daily/last/${start}/${end}`,
    weight_range_rest: `/weight-service/weight/range/${start}/${end}`,
    goal_weight: `/goal-service/goal/user/effective/weightgoal/${start}/${end}`,
    intensity_minutes_weekly: `/usersummary-service/stats/im/weekly/${start}/${end}`,
  }),
  ...gql({
    sleep_summaries: `query{sleepSummariesScalar(startDate:"${start}", endDate:"${end}")}`,
    calories: `query { calorieSummaryDailyStats(startDate: "${start}", endDate: "${end}") {
      calendarDate totalKilocalories activeKilocalories bmrKilocalories consumedKilocalories remainingKilocalories } }`,
    health_snapshot: `query{healthSnapshotScalar(startDate:"${start}", endDate:"${end}")}`,
    workout_schedule: `query{workoutScheduleSummariesScalar(startDate:"${start}", endDate:"${end}")}`,
  }),
];

const daily = (dn: string, date: string): Endpoint[] => [
  ...rest(
    {
      daily_summary: `/usersummary-service/usersummary/daily/${dn}?calendarDate=${date}`,
      heart_rate: `/wellness-service/wellness/dailyHeartRate/${dn}?date=${date}`,
      sleep: `/wellness-service/wellness/dailySleepData/${dn}?date=${date}`,
      stress: `/wellness-service/wellness/dailyStress/${date}`,
      spo2: `/wellness-service/wellness/dailySpo2/${date}`,
      steps: `/usersummary-service/stats/steps/daily/${date}/${date}`,
      respiration: `/wellness-service/wellness/daily/respiration/${date}`,
      floors: `/wellness-service/wellness/floorsChartData/daily/${date}`,
      intensity_minutes: `/wellness-service/wellness/daily/im/${date}`,
      hydration: `/usersummary-service/usersummary/hydration/allData/${date}`,
      body_battery_events: `/wellness-service/wellness/bodyBattery/events/${date}`,
      fitness_age: `/fitnessage-service/fitnessage/${date}`,
      wellness_activity: `/wellnessactivity-service/activity/summary/${date}`,
      daily_movement: `/wellness-service/wellness/dailyMovement?calendarDate=${date}`,
      endurance_score: `/metrics-service/metrics/endurancescore?calendarDate=${date}`,
      hill_score: `/metrics-service/metrics/hillscore?calendarDate=${date}`,
      race_predictions: `/metrics-service/metrics/racepredictions/daily/${dn}?fromCalendarDate=${date}&toCalendarDate=${date}`,
    },
    date,
  ),
  ...gql(
    {
      body_battery_stress: `query{epochChartScalar(date:"${date}", include:["bodyBattery","stress"])}`,
      heart_rate_detail: `query{heartRateScalar(date:"${date}")}`,
      sleep_detail: `query{sleepScalar(date:"${date}", sleepOnly: false)}`,
      training_status_daily: `query{trainingStatusDailyScalar(calendarDate:"${date}")}`,
      daily_events: `query{dailyEventsScalar(date:"${date}")}`,
      health_status: `query { healthStatusSummary(calendarDate:"${date}") { calendarDate overallStatus metricsMap } }`,
      activity_trends_all: `query{activityTrendsScalar(activityType:"all",date:"${date}")}`,
      activity_trends_running: `query{activityTrendsScalar(activityType:"running",date:"${date}")}`,
      activity_trends_cycling: `query{activityTrendsScalar(activityType:"cycling",date:"${date}")}`,
    },
    date,
  ),
];

/** Everything one sync reads except activities. Results are stored in this order; later ones win. */
export const syncEndpoints = (displayName: string, yesterday: string, today: string): Endpoint[] => [
  ...PROFILE,
  ...range(displayName, yesterday, today),
  ...daily(displayName, yesterday),
  ...daily(displayName, today),
];

// ponytail: one page of 1000; paginate when the account passes 1000 activities (526 in Nov 2026).
export const ACTIVITY_LIST = "/gc-api/activitylist-service/activities/search/activities?limit=1000&start=0";

export const activityDetails = (activityId: number): Endpoint[] =>
  rest(
    {
      activity_splits: `/activity-service/activity/${activityId}/splits`,
      activity_hr_zones: `/activity-service/activity/${activityId}/hrTimeInZones`,
      activity_weather: `/activity-service/activity/${activityId}/weather`,
      activity_details: `/activity-service/activity/${activityId}`,
      activity_exercise_sets: `/activity-service/activity/${activityId}/exerciseSets`,
    },
    String(activityId),
  );
