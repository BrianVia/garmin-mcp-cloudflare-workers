#!/usr/bin/env python3
"""
Push recent data from local garmin.db to Cloudflare D1.

Runs after each cron sync. Exports today + yesterday from every table
and upserts via wrangler d1 execute.
"""

import sqlite3
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

from d1_helpers import execute_sql_file

PROJECT_DIR = Path(__file__).parent
DB_PATH = PROJECT_DIR / "garmin.db"
D1_NAME = "garmin-health"

# Tables keyed by calendar_date
DATE_KEYED_TABLES = [
    "daily_summary", "sleep", "heart_rate", "stress", "spo2", "respiration",
    "body_battery", "steps", "floors", "intensity_minutes", "hydration",
    "fitness_age", "daily_movement", "wellness_activity", "training_status",
    "health_status", "daily_events", "training_readiness", "hrv",
    "weight", "blood_pressure", "calories", "sleep_stats", "health_snapshot",
    "endurance_score", "hill_score", "race_predictions",
    "vo2max", "activity_trends",
]

# Tables keyed by other IDs (full sync)
ID_KEYED_TABLES = [
    "activity", "activity_types", "activity_splits", "activity_hr_zones",
    "activity_weather", "activity_exercise_sets", "earned_badges",
    "personal_record", "device", "gear", "goals", "challenges",
    "training_plans", "hr_zones", "user_profile", "workouts",
    "workout_schedule", "sync_log",
]


def escape_sql_value(val):
    if val is None:
        return "NULL"
    if isinstance(val, (int, float)):
        return str(val)
    s = str(val).replace("'", "''")
    return f"'{s}'"


def generate_upserts(conn: sqlite3.Connection, table: str, where: str = "", params: list = None) -> list[str]:
    cursor = conn.execute(f"SELECT * FROM {table} {where}", params or [])
    all_cols = [desc[0] for desc in cursor.description]
    rows = cursor.fetchall()

    if not rows:
        return []

    # Skip raw_json column — dashboard doesn't need it and it causes SQLITE_TOOBIG
    skip_indices = {i for i, c in enumerate(all_cols) if c == "raw_json"}
    cols = [c for i, c in enumerate(all_cols) if i not in skip_indices]

    statements = []
    col_list = ", ".join(cols)

    for row in rows:
        filtered = [v for i, v in enumerate(row) if i not in skip_indices]
        values = ", ".join(escape_sql_value(v) for v in filtered)
        statements.append(
            f"INSERT OR REPLACE INTO {table} ({col_list}) VALUES ({values});"
        )

    return statements


def main():
    full = "--full" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    target = args[0] if args else None
    today = target or date.today().isoformat()
    yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    day_before = (date.fromisoformat(today) - timedelta(days=2)).isoformat()

    conn = sqlite3.connect(str(DB_PATH))

    all_sql = []

    if full:
        # Full sync: dump all tables
        for table in DATE_KEYED_TABLES + ID_KEYED_TABLES:
            try:
                stmts = generate_upserts(conn, table)
                all_sql.extend(stmts)
            except sqlite3.OperationalError:
                pass
    else:
        # Incremental: last 3 days to avoid timing gaps
        for table in DATE_KEYED_TABLES:
            try:
                stmts = generate_upserts(
                    conn, table,
                    "WHERE calendar_date BETWEEN ? AND ?",
                    [day_before, today],
                )
                all_sql.extend(stmts)
            except sqlite3.OperationalError:
                pass

        # Activity tables: sync activities from the last 3 days
        try:
            stmts = generate_upserts(
                conn, "activity",
                "WHERE DATE(start_time_local) BETWEEN ? AND ?",
                [day_before, today],
            )
            all_sql.extend(stmts)

            cursor = conn.execute(
                "SELECT activity_id FROM activity WHERE DATE(start_time_local) BETWEEN ? AND ?",
                [day_before, today],
            )
            activity_ids = [r[0] for r in cursor.fetchall()]

            for aid in activity_ids:
                for table in ["activity_splits", "activity_hr_zones", "activity_weather", "activity_exercise_sets"]:
                    try:
                        stmts = generate_upserts(conn, table, "WHERE activity_id = ?", [aid])
                        all_sql.extend(stmts)
                    except sqlite3.OperationalError:
                        pass
        except sqlite3.OperationalError:
            pass

        # Profile tables: always sync (small, rarely change)
        for table in ["personal_record", "device", "gear", "goals", "user_profile",
                       "earned_badges", "activity_types", "hr_zones", "training_plans"]:
            try:
                stmts = generate_upserts(conn, table)
                all_sql.extend(stmts)
            except sqlite3.OperationalError:
                pass

        # Sync log: last entry
        try:
            stmts = generate_upserts(conn, "sync_log", "ORDER BY id DESC LIMIT 5")
            all_sql.extend(stmts)
        except sqlite3.OperationalError:
            pass

    conn.close()

    if not all_sql:
        print("No data to push.")
        return

    # Write to temp file and execute via wrangler
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False) as f:
        f.write("\n".join(all_sql))
        tmp_path = f.name

    print(f"Pushing {len(all_sql)} statements to D1...")

    try:
        execute_sql_file(Path(tmp_path), D1_NAME, PROJECT_DIR / "web", label="sync_to_d1")
    except RuntimeError as e:
        print(str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
