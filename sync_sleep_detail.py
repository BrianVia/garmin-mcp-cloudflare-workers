#!/usr/bin/env python3
"""
Extract granular sleep data from raw_json in local garmin.db
and push to D1 sleep detail tables.
"""

import json
import sqlite3
import sys
import tempfile
from pathlib import Path

from d1_helpers import execute_sql_file

PROJECT_DIR = Path(__file__).parent
DB_PATH = PROJECT_DIR / "garmin.db"
D1_NAME = "garmin-health"


def escape(val):
    if val is None:
        return "NULL"
    if isinstance(val, (int, float)):
        return str(val)
    s = str(val).replace("'", "''")
    return f"'{s}'"


def extract_sleep_detail(conn, calendar_date=None):
    if calendar_date:
        rows = conn.execute(
            "SELECT calendar_date, raw_json FROM sleep WHERE calendar_date = ?",
            [calendar_date],
        ).fetchall()
    else:
        rows = conn.execute("SELECT calendar_date, raw_json FROM sleep").fetchall()

    statements = []

    for cal_date, raw in rows:
        if not raw:
            continue
        data = json.loads(raw)
        dto = data.get("dailySleepDTO", {})

        # sleep_times
        statements.append(
            f"INSERT OR REPLACE INTO sleep_times (calendar_date, sleep_start_local, sleep_end_local, "
            f"sleep_start_gmt, sleep_end_gmt, sleep_score_feedback, sleep_score_insight, personalized_insight) "
            f"VALUES ({escape(cal_date)}, {escape(dto.get('sleepStartTimestampLocal'))}, "
            f"{escape(dto.get('sleepEndTimestampLocal'))}, {escape(dto.get('sleepStartTimestampGMT'))}, "
            f"{escape(dto.get('sleepEndTimestampGMT'))}, {escape(dto.get('sleepScoreFeedback'))}, "
            f"{escape(dto.get('sleepScoreInsight'))}, {escape(dto.get('sleepScorePersonalizedInsight'))});"
        )

        # sleep_levels
        for lvl in (data.get("sleepLevels") or []):
            statements.append(
                f"INSERT OR REPLACE INTO sleep_levels (calendar_date, start_gmt, end_gmt, activity_level) "
                f"VALUES ({escape(cal_date)}, {escape(lvl['startGMT'])}, {escape(lvl['endGMT'])}, {escape(lvl['activityLevel'])});"
            )

        # sleep_heart_rate
        for hr in (data.get("sleepHeartRate") or []):
            statements.append(
                f"INSERT OR REPLACE INTO sleep_heart_rate (calendar_date, timestamp_gmt, value) "
                f"VALUES ({escape(cal_date)}, {escape(hr['startGMT'])}, {escape(hr['value'])});"
            )

        # sleep_hrv
        for hrv in (data.get("hrvData") or []):
            statements.append(
                f"INSERT OR REPLACE INTO sleep_hrv (calendar_date, timestamp_gmt, value) "
                f"VALUES ({escape(cal_date)}, {escape(hrv['startGMT'])}, {escape(hrv['value'])});"
            )

        # sleep_stress
        for s in (data.get("sleepStress") or []):
            statements.append(
                f"INSERT OR REPLACE INTO sleep_stress (calendar_date, timestamp_gmt, value) "
                f"VALUES ({escape(cal_date)}, {escape(s['startGMT'])}, {escape(s['value'])});"
            )

        # sleep_body_battery
        for bb in (data.get("sleepBodyBattery") or []):
            statements.append(
                f"INSERT OR REPLACE INTO sleep_body_battery (calendar_date, timestamp_gmt, value) "
                f"VALUES ({escape(cal_date)}, {escape(bb['startGMT'])}, {escape(bb['value'])});"
            )

        # sleep_respiration
        for r in (data.get("wellnessEpochRespirationDataDTOList") or []):
            statements.append(
                f"INSERT OR REPLACE INTO sleep_respiration (calendar_date, timestamp_gmt, value) "
                f"VALUES ({escape(cal_date)}, {escape(r['startTimeGMT'])}, {escape(r['respirationValue'])});"
            )

    return statements


def main():
    full = "--full" in sys.argv
    conn = sqlite3.connect(str(DB_PATH))

    if full:
        stmts = extract_sleep_detail(conn)
    else:
        from datetime import date, timedelta
        today = date.today().isoformat()
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        day_before = (date.today() - timedelta(days=2)).isoformat()
        stmts = extract_sleep_detail(conn, today) + extract_sleep_detail(conn, yesterday) + extract_sleep_detail(conn, day_before)

    conn.close()

    if not stmts:
        print("No sleep detail data to push.")
        return

    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False) as f:
        f.write("\n".join(stmts))
        tmp_path = f.name

    print(f"Pushing {len(stmts)} sleep detail statements to D1...")

    try:
        execute_sql_file(Path(tmp_path), D1_NAME, PROJECT_DIR / "web", label="sync_sleep_detail")
    except RuntimeError as e:
        print(str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
