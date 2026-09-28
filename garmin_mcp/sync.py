"""
Incremental sync module for Garmin MCP server.

Fetches today's and yesterday's data from Garmin Connect and saves it
directly to SQLite via save_to_db().
"""

import fcntl
import logging
import os
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from garmin_mcp.db import get_connection, init_db, save_to_db, today

logger = logging.getLogger(__name__)
PROJECT_DIR = Path(__file__).parent.parent
PROFILE_DIR = PROJECT_DIR / "browser_profile"
SESSION_FILE = PROJECT_DIR / "garmin_session.json"
LOCK_FILE = Path("/tmp/garmin-sync.lock")

env_file = PROJECT_DIR / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def sync_in_progress() -> bool:
    with LOCK_FILE.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(lock, fcntl.LOCK_UN)
        return False


def sync_status(conn=None) -> dict:
    owns_connection = conn is None
    if owns_connection:
        conn = get_connection()
        init_db(conn)
    try:
        last_ok = conn.execute(
            "SELECT sync_date FROM sync_log WHERE status = 'ok' ORDER BY sync_date DESC, id DESC LIMIT 1"
        ).fetchone()
        last_attempt = conn.execute(
            """SELECT sync_date AS at, status, records_upserted, error
               FROM sync_log ORDER BY sync_date DESC, id DESC LIMIT 1"""
        ).fetchone()
        return {
            "in_progress": sync_in_progress(),
            "last_ok": last_ok[0] if last_ok else None,
            "last_attempt": {
                "at": last_attempt[0],
                "status": last_attempt[1],
                "records_upserted": last_attempt[2],
                "error": last_attempt[3],
            }
            if last_attempt
            else None,
        }
    finally:
        if owns_connection:
            conn.close()


def start_sync() -> dict:
    if sync_in_progress():
        return {"status": "busy", **sync_status()}
    process = subprocess.Popen(
        [sys.executable, "-m", "garmin_mcp.sync"],
        cwd=PROJECT_DIR,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"status": "started", "pid": process.pid, **sync_status()}


def _known_activity_detail_ids(conn) -> set[int]:
    """Return activity IDs that already have per-activity detail rows."""
    rows = conn.execute(
        """
        SELECT activity_id FROM activity_splits
        UNION
        SELECT activity_id FROM activity_hr_zones
        UNION
        SELECT activity_id FROM activity_weather
        UNION
        SELECT activity_id FROM activity_exercise_sets
        """
    ).fetchall()
    return {int(row["activity_id"]) for row in rows if row["activity_id"] is not None}


def incremental_sync(target_date: str = None, known_activity_ids: set[int] = None, conn=None) -> dict:
    """Fetch today's data from Garmin and save directly to the database.

    Parameters
    ----------
    target_date:
        ISO date string (``YYYY-MM-DD``) to treat as "today".  Defaults to
        the actual current date.
    known_activity_ids, conn:
        Overrides for the cloud collector, which syncs into a scratch database.

    Returns
    -------
    dict
        Summary with keys: ``status``, ``target_date``, ``yesterday``,
        ``records`` (per-endpoint counts), ``total_upserted``.
    """
    from garmin_client import GarminClient

    sync_day = target_date or today().isoformat()
    yesterday = (date.fromisoformat(sync_day) - timedelta(days=1)).isoformat()

    email = os.environ.get("GARMIN_EMAIL", "")
    password = os.environ.get("GARMIN_PASSWORD", "")
    if not email or not password:
        return {
            "status": "error",
            "message": "Credentials not found. Run ./setup.sh or set GARMIN_EMAIL and GARMIN_PASSWORD.",
        }

    # Open DB connection for direct writes
    conn = conn or get_connection()
    init_db(conn)
    if known_activity_ids is None:
        known_activity_ids = _known_activity_detail_ids(conn)
    logger.info("Found %d activities with existing detail data", len(known_activity_ids))

    counts = {}

    def on_batch(endpoint_name, data, cal_date=None):
        n = save_to_db(conn, endpoint_name, data, cal_date=cal_date)
        if n > 0:
            counts[endpoint_name] = counts.get(endpoint_name, 0) + n

    client = GarminClient(
        email=email,
        password=password,
        profile_dir=PROFILE_DIR,
        headless=True,
        engine="auto",
        session_file=SESSION_FILE,
    )

    logger.info("Starting incremental sync for %s (+ %s)", sync_day, yesterday)

    try:
        if not client.login():
            raise RuntimeError("Login failed")

        client.fetch_all(
            target_date=sync_day,
            start_date=yesterday,
            end_date=sync_day,
            on_batch=on_batch,
            known_activity_ids=known_activity_ids,
        )
    except Exception as exc:
        conn.execute(
            """INSERT INTO sync_log
               (sync_date, sync_type, records_upserted, status, error)
               VALUES (?, ?, ?, 'error', ?)""",
            (datetime.now(timezone.utc).isoformat(), "incremental_sync", sum(counts.values()), str(exc)[:500]),
        )
        conn.commit()
        conn.close()
        raise
    finally:
        client.close()

    # Log the sync
    sync_ts = datetime.now(timezone.utc).isoformat()
    total = sum(counts.values())
    conn.execute(
        "INSERT INTO sync_log (sync_date, sync_type, records_upserted, status) VALUES (?, ?, ?, ?)",
        (sync_ts, "incremental_sync", total, "ok"),
    )
    conn.commit()
    conn.close()

    logger.info("Incremental sync complete. Total records upserted: %d", total)

    return {
        "status": "ok",
        "target_date": sync_day,
        "yesterday": yesterday,
        "records": counts,
        "total_upserted": total,
    }


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    arg_date = sys.argv[1] if len(sys.argv) > 1 else None
    with LOCK_FILE.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit("Another Garmin sync is already running")
        result = incremental_sync(target_date=arg_date)
    print(result)
