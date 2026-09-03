# MCP Tools Reference

## Available Tools

| Tool | Description |
|---|---|
| `garmin_sync(wait_seconds=0)` | Kick the cron sync out-of-process; returns `started`/`busy`, or waits when requested |
| `garmin_brief()` | Last night's sleep and today's non-averaged health, activity, load, weight, and freshness |
| `garmin_schema()` | Show all tables, columns, and row counts |
| `garmin_query(sql)` | Run a custom SELECT query against the database |
| `garmin_health_summary(start_date, end_date, days)` | Health overview for a date range (defaults to last 7 days) |
| `garmin_activities(activity_type, start_date, end_date, limit)` | Query activities with optional filters |
| `garmin_trends(metric, period)` | Trend data aggregated by week or month |

## Syncing Data

Data syncs automatically every 30 minutes via cron. `garmin_sync()` starts that same
`sync_cron.sh` in a separate process and returns immediately with `started` or
`busy`. Pass `wait_seconds` to wait up to that many seconds for a final status.

Example response:

```json
{
  "status": "started",
  "pid": 12345,
  "in_progress": true,
  "last_ok": "2026-04-07T12:00:00+00:00"
}
```

## Example Queries

### Recent resting heart rate
```
garmin_query(sql="SELECT calendar_date, resting_hr FROM daily_summary ORDER BY calendar_date DESC LIMIT 7")
```

### Last night
```
garmin_brief()
```

### Sleep data for the past week, per night
```
garmin_query(sql="SELECT calendar_date, ROUND(sleep_time_seconds/3600.0,2) AS hours, nap_time_seconds, sleep_score_feedback FROM sleep ORDER BY calendar_date DESC LIMIT 7")
```

### Running activities this month
```
garmin_activities(activity_type="running", start_date="2026-04-01")
```

### Weekly step trends
```
garmin_trends(metric="steps", period="week")
```

## HTTP

All routes use `Authorization: Bearer $MCP_API_KEY`:

- `POST /sync` starts the cron sync.
- `GET /sync` returns sync status.
- `GET /brief` returns the morning brief.

## Gotchas

- A sleep `calendar_date` is the wake date.
- `sleep.pending` means Garmin has not scored the night yet, not that the watch was off.
- For HRV, use `last_night`; `weekly_avg` is Garmin's smoothed value.
- Nap minutes stay separate from last night's sleep.
