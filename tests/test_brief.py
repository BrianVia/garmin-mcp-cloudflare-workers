import fcntl
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from garmin_mcp import db, server, sync


class BriefTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.NamedTemporaryFile(suffix=".db")
        self.conn = db.get_connection(self.temp.name)
        db.init_db(self.conn)

    def tearDown(self):
        self.conn.close()
        self.temp.close()

    def test_init_db_adds_scored_at_idempotently(self):
        db.init_db(self.conn)
        columns = {row[1] for row in self.conn.execute("PRAGMA table_info(sleep)")}
        self.assertIn("scored_at", columns)

    def test_pending_sleep_becomes_scored_and_is_not_overwritten_by_stub(self):
        wake_date = db.today().isoformat()
        pending = {"dailySleepDTO": {"calendarDate": wake_date, "sleepTimeSeconds": None}}
        scored = {
            "dailySleepDTO": {
                "calendarDate": wake_date,
                "sleepTimeSeconds": 27000,
                "deepSleepSeconds": 3600,
                "napTimeSeconds": 1200,
                "sleepScoreFeedback": "GOOD",
            }
        }

        db.upsert_sleep(self.conn, pending)
        brief = db.build_brief(self.conn)
        self.assertTrue(brief["sleep"]["pending"])
        self.assertIsNone(brief["sleep"]["hours"])

        with patch.object(db, "now_local", return_value=datetime.fromisoformat("2026-01-01T08:00:00-05:00")):
            db.upsert_sleep(self.conn, scored)
        first_scored_at = self.conn.execute(
            "SELECT scored_at FROM sleep WHERE calendar_date = ?", (wake_date,)
        ).fetchone()[0]
        with patch.object(db, "now_local", return_value=datetime.fromisoformat("2026-01-01T09:00:00-05:00")):
            db.upsert_sleep(self.conn, scored)
        db.upsert_sleep(self.conn, pending)

        row = self.conn.execute(
            "SELECT sleep_time_seconds, scored_at FROM sleep WHERE calendar_date = ?", (wake_date,)
        ).fetchone()
        self.assertEqual((row[0], row[1]), (27000, first_scored_at))
        brief = db.build_brief(self.conn)
        self.assertFalse(brief["sleep"]["pending"])
        self.assertEqual(brief["sleep"]["hours"], 7.5)
        self.assertEqual(brief["sleep"]["nap_minutes"], 20)

    def test_device_stub_preserves_metadata_and_adds_last_sync(self):
        db.upsert_device(
            self.conn,
            {
                "deviceId": 1,
                "displayName": "Forerunner 965",
                "deviceTypeSimpleName": "WATCH",
                "applicationKey": "abc",
                "extra": 1,
                "another": 2,
                "field": 3,
            },
        )
        db.upsert_device(self.conn, {"deviceId": 1, "lastUsedDeviceUploadTime": 1768858818000})
        row = self.conn.execute("SELECT display_name, last_sync FROM device").fetchone()
        self.assertEqual(row[0], "Forerunner 965")
        self.assertIsNotNone(row[1])

    def test_empty_brief_has_every_top_level_key(self):
        brief = db.build_brief(self.conn)
        self.assertEqual(
            set(brief),
            {
                "date",
                "generated_at",
                "timezone",
                "freshness",
                "sleep",
                "hrv",
                "readiness",
                "today",
                "last_activity",
                "load",
                "weight",
            },
        )
        self.assertTrue(brief["sleep"]["pending"])
        self.assertIsNone(brief["hrv"])
        self.assertIsNone(brief["readiness"])
        self.assertIsNone(brief["today"])
        self.assertIsNone(brief["last_activity"])

    def test_sync_lock_detection(self):
        lock_path = Path(self.temp.name + ".lock")
        with patch.object(sync, "LOCK_FILE", lock_path):
            self.assertFalse(sync.sync_in_progress())
            with lock_path.open("a+") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertTrue(sync.sync_in_progress())
                fcntl.flock(lock, fcntl.LOCK_UN)

    def test_activity_type_is_a_substring(self):
        for activity_id, activity_type in enumerate(("running", "treadmill_running", "walking"), 1):
            db.upsert_activity(
                self.conn,
                {
                    "activityId": activity_id,
                    "activityName": activity_type,
                    "activityType": {"typeKey": activity_type},
                    "startTimeLocal": f"2026-01-0{activity_id} 08:00:00",
                },
            )
        self.conn.commit()

        with patch.object(server, "get_connection", side_effect=lambda: db.get_connection(self.temp.name)):
            rows = json.loads(server.garmin_activities(activity_type="run"))
        self.assertEqual(len(rows), 2)


if __name__ == "__main__":
    unittest.main()
