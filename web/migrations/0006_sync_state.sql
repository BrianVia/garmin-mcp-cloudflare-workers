-- Garmin session (encrypted), login status, the sync lock, and alert cooldowns. One row per key; see src/state.ts.
CREATE TABLE IF NOT EXISTS sync_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
