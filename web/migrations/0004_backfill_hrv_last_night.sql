-- Backfill hrv.last_night from last_night_avg for rows synced before the
-- fallback was added to garmin_mcp/db.py upsert_hrv. Garmin's GraphQL scalar
-- endpoint returns lastNightAvg (overnight mean) but no lastNight field, so
-- every row written prior to this fix has last_night = NULL even though
-- last_night_avg holds the correct overnight value.

UPDATE hrv
SET last_night = last_night_avg
WHERE last_night IS NULL
  AND last_night_avg IS NOT NULL;
