-- First time we saw Garmin score a night (sleep_time_seconds became non-null).
-- NULL on a row = Garmin has not scored the night yet (sleep pending).
ALTER TABLE sleep ADD COLUMN scored_at TEXT;
