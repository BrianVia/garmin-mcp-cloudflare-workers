# MCP Tools Reference

## Available Tools

| Tool | Description |
|---|---|
| `garmin_sync(wait_seconds=0)` | Start the scheduled sync now; returns `started`/`busy`, or waits when requested |
| `garmin_brief()` | Last night's sleep and today's non-averaged health, activity, load, weight, and freshness |
| `garmin_schema()` | Show all tables, columns, and row counts |
| `garmin_query(sql)` | Run a custom SELECT query against the database |
| `garmin_health_summary(start_date, end_date, days)` | Health overview for a date range (defaults to last 7 days) |
| `garmin_activities(activity_type, start_date, end_date, limit)` | Query activities with optional filters |
| `garmin_trends(metric, period)` | Trend data aggregated by week or month |

## Syncing Data

Everything runs on Cloudflare at `https://garmin.brianvia.com` (the `garmin-health`
Worker in `web/`). A Worker cron syncs at :15 and :45. `garmin_sync()` starts that
same sync and returns immediately with `started` or `busy`. Pass `wait_seconds` to
wait up to that many seconds for a final status. A sync takes about 2 minutes.

Example response:

```json
{
  "status": "started",
  "in_progress": true,
  "last_ok": "2026-04-07T12:00:00+00:00"
}
```

### How a sync works

1. The `GarminCollector` Durable Object (`web/src/collector.ts`) starts a fresh
   Cloudflare Container running `collector.py`, and sends it the saved Garmin cookies.
2. `collector.py` runs the normal Python sync into a scratch SQLite file and records
   every write it makes.
3. The Durable Object replays those writes on D1 in one batch, then saves the
   refreshed cookies and shuts the container down.
4. Failures land in `sync_log`. Two failed syncs in a row post to Slack (SlackPipes),
   at most once an hour per failure type; a single failure usually fixes itself on the
   next run.

### When syncs fail with "Login failed"

Garmin blocks fresh logins from Cloudflare and from newer Camoufox builds (errors 427, 1015), but accepts an existing
session. Garmin still ends sessions every week or two, so the collector logs in through
via-server's home connection: it joins the tailnet with the `TS_AUTHKEY` secret and uses
via-server as a Tailscale exit node (`entrypoint.sh`). If Tailscale or via-server is down,
it connects directly, which works only while the saved cookies last.

Tailscale setup (once):
1. Access controls: add `"tag:garmin-collector": ["autogroup:admin"]` to `tagOwners`.
2. Machines → via-server → Edit route settings → enable "Use as exit node".
3. Settings → OAuth clients → new client with **Auth Keys: write** and tag `tag:garmin-collector`.
4. `cd web && npx wrangler secret put TS_AUTHKEY`, value
   `tskey-client-...?ephemeral=true&preauthorized=true`. OAuth client secrets don't expire.

If via-server is out for a while and the cookies expire, log in on any home machine and
upload the cookies (`SYNC_TOKEN` works in place of `MCP_BEARER`):

```bash
garmin-givemydata --profile health --days 1   # writes garmin_session.json after login
curl -X PUT https://garmin.brianvia.com/sync/session \
  -H "Authorization: Bearer $MCP_BEARER" -H "Content-Type: application/json" \
  --data @garmin_session.json
curl -X POST https://garmin.brianvia.com/sync -H "Authorization: Bearer $MCP_BEARER"
```

### Deploying

```bash
cd web && bun install && bun run deploy   # needs Docker for the collector image
```

Secrets (`wrangler secret put`): `GARMIN_EMAIL`, `GARMIN_PASSWORD`, `MCP_BEARER`,
`SYNC_TOKEN`, `SLACKPIPES_WEBHOOK`, `TS_AUTHKEY`.

Deploy with `sg docker -c "bun run deploy"` if your shell predates joining the docker group.

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

All routes use `Authorization: Bearer $MCP_BEARER`:

- `POST /mcp` is the MCP endpoint.
- `POST /sync` starts a sync (`?date=YYYY-MM-DD` to sync another day).
- `GET /sync` returns sync status.
- `PUT /sync/session` replaces the Garmin cookies.
- `GET /brief` returns the morning brief.

The public dashboard API (`/api/*`) is documented at `/docs`.

## Gotchas

- A sleep `calendar_date` is the wake date.
- `sleep.pending` means Garmin has not scored the night yet, not that the watch was off.
- For HRV, use `last_night`; `weekly_avg` is Garmin's smoothed value.
- Nap minutes stay separate from last night's sleep.
