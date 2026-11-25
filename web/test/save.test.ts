import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Writes } from "../src/garmin/save";
import { openDb } from "./helpers";

function apply(db: Database, fill: (w: Writes) => void) {
  const writes = new Writes();
  fill(writes);
  for (const [sql, params] of writes.statements()) db.query(sql).run(...(params as any[]));
  return writes;
}
const night = (seconds: number | null) => ({ dailySleepDTO: { calendarDate: "2026-11-25", sleepTimeSeconds: seconds } });

test("rows without a key are dropped, and syncing twice adds nothing", () => {
  const db = openDb();
  const fill = (w: Writes) => {
    w.save("activities", [{ activityList: [] }, { activityId: 25199199706, activityName: "it's a run", activityType: { typeKey: "running" } }]);
    w.save("gql_daily_summaries", { data: { userDailySummaryV2Scalar: { data: [] } } });
    w.save("gql_challenges_adhoc", { data: { adhocChallengesScalar: [{ id: 1 }] } });
  };
  apply(db, fill);
  apply(db, fill);
  expect(db.query("SELECT activity_id, activity_name, activity_type FROM activity").all()).toEqual([
    { activity_id: 25199199706, activity_name: "it's a run", activity_type: "running" },
  ]);
  expect(db.query("SELECT count(*) AS n FROM daily_summary").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM challenges").get()).toEqual({ n: 1 });
});

test("an unscored night never replaces a scored one, and scored_at keeps its first value", () => {
  const db = openDb();
  apply(db, (w) => w.save("sleep", night(null), "2026-11-25"));
  expect(db.query("SELECT scored_at FROM sleep").get()).toEqual({ scored_at: null });
  apply(db, (w) => w.save("sleep", night(27000), "2026-11-25"));
  db.exec("UPDATE sleep SET scored_at = 'first'");
  apply(db, (w) => {
    w.save("sleep", night(28000), "2026-11-25");
    w.save("gql_sleep_detail", { data: { sleepScalar: night(null) } }, "2026-11-25");
  });
  expect(db.query("SELECT sleep_time_seconds, scored_at FROM sleep").all()).toEqual([{ sleep_time_seconds: 28000, scored_at: "first" }]);
});

test("an unusable response does not empty a table that is replaced each sync", () => {
  const db = openDb();
  apply(db, (w) => w.save("personal_records", [{ id: 1, typeId: 3, value: 9.5 }, { id: 2, typeId: 4 }]));
  apply(db, (w) => w.save("personal_records", [{ error: "nope" }]));
  expect(db.query("SELECT count(*) AS n FROM personal_record").get()).toEqual({ n: 2 });
  apply(db, (w) => w.save("personal_records", [{ id: 2, typeId: 4 }]));
  expect(db.query("SELECT id, pr_type FROM personal_record").all()).toEqual([{ id: 2, pr_type: "4" }]);
});

test("per-minute rows come from the day's responses, without Garmin's negative placeholders", () => {
  const db = openDb();
  apply(db, (w) => {
    w.save("stress", { stressValuesArray: [[1, 20], [2, -1]], bodyBatteryValuesArray: [[1, "MEASURED", 80, 3], [2, null, null, 3]] }, "2026-11-25");
    w.save("heart_rate", { restingHeartRate: 50, heartRateValues: [[1, 60], [2, null]] }, "2026-11-25");
    w.save("sleep", { ...night(100), sleepHeartRate: [{ startGMT: 5, value: 51 }], sleepLevels: [{ startGMT: "a", endGMT: "b", activityLevel: 1 }] }, "2026-11-25");
    w.addDetail("2026-11-25");
  });
  const all = (table: string) => db.query(`SELECT * FROM ${table}`).all().map((r: any) => Object.values(r).slice(1));
  expect(all("intraday_stress")).toEqual([[1, 20]]);
  expect(all("intraday_body_battery")).toEqual([[1, 80, "MEASURED"]]);
  expect(all("intraday_heart_rate")).toEqual([[1, 60]]);
  expect(all("sleep_heart_rate")).toEqual([[5, 51]]);
  expect(db.query("SELECT count(*) AS n FROM sleep_levels").get()).toEqual({ n: 1 });
});

test("large responses are split under D1's 2 MB parameter limit", () => {
  const writes = new Writes();
  writes.save("activities", Array.from({ length: 60 }, (_, i) => ({ activityId: i + 1, note: "x".repeat(50_000) })));
  const sizes = writes.statements().map(([, [param]]) => (param as string).length);
  expect(sizes.length).toBeGreaterThan(2);
  expect(Math.max(...sizes)).toBeLessThan(2_000_000);
});
