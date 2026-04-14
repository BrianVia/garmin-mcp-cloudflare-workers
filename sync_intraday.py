#!/usr/bin/env python3
"""
Extract intraday stress, body battery, and heart rate data from raw_json
in local garmin.db and push to D1.
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


def extract_intraday(conn, calendar_date=None):
    statements = []

    # Stress intraday from stress.raw_json
    where = f"WHERE calendar_date = '{calendar_date}'" if calendar_date else ""
    rows = conn.execute(f"SELECT calendar_date, raw_json FROM stress {where}").fetchall()
    for cal_date, raw in rows:
        if not raw:
            continue
        data = json.loads(raw)
        for entry in (data.get("stressValuesArray") or []):
            if isinstance(entry, list) and len(entry) >= 2 and entry[1] >= 0:
                statements.append(
                    f"INSERT OR REPLACE INTO intraday_stress (calendar_date, timestamp_gmt, value) "
                    f"VALUES ({escape(cal_date)}, {entry[0]}, {entry[1]});"
                )
        # Body battery from same raw_json
        for entry in (data.get("bodyBatteryValuesArray") or []):
            if isinstance(entry, list) and len(entry) >= 3 and entry[2] is not None:
                status_val = entry[1] if entry[1] is not None else "unknown"
                statements.append(
                    f"INSERT OR REPLACE INTO intraday_body_battery (calendar_date, timestamp_gmt, value, status) "
                    f"VALUES ({escape(cal_date)}, {entry[0]}, {entry[2]}, {escape(status_val)});"
                )

    # Heart rate intraday from heart_rate.raw_json
    rows = conn.execute(f"SELECT calendar_date, raw_json FROM heart_rate {where}").fetchall()
    for cal_date, raw in rows:
        if not raw:
            continue
        data = json.loads(raw)
        for entry in (data.get("heartRateValues") or []):
            if isinstance(entry, list) and len(entry) >= 2 and entry[1] is not None and entry[1] > 0:
                statements.append(
                    f"INSERT OR REPLACE INTO intraday_heart_rate (calendar_date, timestamp_gmt, value) "
                    f"VALUES ({escape(cal_date)}, {entry[0]}, {entry[1]});"
                )

    return statements


def main():
    full = "--full" in sys.argv
    conn = sqlite3.connect(str(DB_PATH))

    if full:
        stmts = extract_intraday(conn)
    else:
        from datetime import date, timedelta
        today = date.today().isoformat()
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        day_before = (date.today() - timedelta(days=2)).isoformat()
        stmts = extract_intraday(conn, today) + extract_intraday(conn, yesterday) + extract_intraday(conn, day_before)

    conn.close()

    if not stmts:
        print("No intraday data to push.")
        return

    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False) as f:
        f.write("\n".join(stmts))
        tmp_path = f.name

    print(f"Pushing {len(stmts)} intraday statements to D1...")

    try:
        execute_sql_file(Path(tmp_path), D1_NAME, PROJECT_DIR / "web", label="sync_intraday")
    except RuntimeError as e:
        print(str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
