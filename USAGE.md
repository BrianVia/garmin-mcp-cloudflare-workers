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

The `garmin-health` Worker in `web/` serves `https://garmin.brianvia.com` and does all the
syncing. A cron syncs at :15 and :45. `garmin_sync()` starts that same sync and returns
immediately with `started` or `busy`. Pass `wait_seconds` to wait up to that many seconds
for a final status. A sync takes about 10 seconds.

Example response:

```json
{
  "status": "started",
  "in_progress": true,
  "last_ok": "2026-11-25T21:13:03.997Z",
  "stale": false,
  "warning": null,
  "login": {
    "needed": false,
    "reason": null,
    "last_login": "2026-11-25T21:12:57.447Z",
    "session_expires_at": "2026-11-25T23:12:49.000Z"
  }
}
```

When the last good sync is over two hours old, `stale` is true and `warning` says so. The
same `warning` is at the top of `garmin_brief()`.

### How a sync works

```
cron / garmin_sync ─► Worker ─► Workers VPC ─► cloudflared ─► home/proxy.py ─► connect.garmin.com
                        │                      └────────── via-server ──────┘   (from the home IP)
                        ├─► D1 garmin-data
                        ◄── PUT /sync/session ── home/login.py (browser login, via-server)
```

1. The Worker (`web/src/sync.ts`) takes the lock in D1's `sync_state`, decrypts the saved Garmin
   cookies, loads Garmin's app page for a CSRF token, and reads yesterday and today over REST.
2. Every request goes through `home/proxy.py` on via-server, so Garmin sees the home IP. The proxy
   needs a token and only reaches `connect.garmin.com`, and only the sync's paths.
3. All rows and the `sync_log` entry are written in one D1 transaction. If a few endpoints fail, the
   rest is still saved. The sync only counts as failed if daily summary, sleep, heart rate or stress did.
4. Two failed syncs in a row post to Slack (SlackPipes), at most once an hour per failure type.

### How login works

Garmin blocks plain HTTP clients from its login pages (errors 427, 1015) and wants a real browser from
a home IP. `home/login.py` runs on via-server, where Camoufox 0.4.11 with Firefox 135.0.1-beta.24 works.

- `garmin-login.timer` runs it every 30 minutes. It asks the Worker whether a login is needed, which is
  one HTTP request, and stops there if not.
- A login is needed when the Worker flagged the session as dead, or it expires within 45 minutes.
  Garmin gives a session two hours.
- When a sync finds the session dead, the Worker also calls the proxy's `POST /login`, which starts
  `garmin-login.service` at once.
- The browser usually signs in without a password, using Garmin's SSO cookies. Those stay on via-server
  in `~/.local/state/garmin-login`. Only cookies for `connect.garmin.com` are uploaded, and the Worker
  stores them encrypted with `SESSION_KEY`.
- Failed logins back off: 25 minutes, then 1, 2, 4 and 8 hours.

### When syncs fail

`GET /sync` shows `last_attempt.error`, which starts with the failure type:

| Type | Meaning | What to do |
|---|---|---|
| `session_expired` | Garmin wants a login | Wait for via-server. If it repeats: `journalctl --user -u garmin-login -n 50` |
| `home_down` | The tunnel, proxy or via-server is unreachable | `systemctl --user status garmin-proxy`; `docker logs --tail 50 cloudflared-garmin` |
| `blocked` | Garmin rate limit or challenge (427, 429, 1015) | Leave it alone. The Worker does not ask for logins in this state |
| `garmin` / `partial` | Garmin itself failed | Wait for the next run |
| `d1_write` | D1 refused the write | Wait for the next run |

Force a login: `systemctl --user stop garmin-login.timer`, then run `home/login.py --force` with
`~/.config/garmin-home.env` loaded. If via-server can't log in, log in on another home machine with
`garmin-givemydata --profile health --days 1` and upload its `garmin_session.json`:

```bash
curl -X PUT https://garmin.brianvia.com/sync/session \
  -H "Authorization: Bearer $SYNC_TOKEN" -H "Content-Type: application/json" \
  --data @garmin_session.json
```

### Setting up via-server

Once. Nothing here needs root. The checkout is `~/Development/Personal/garmin-givemydata`, whose `.venv`
has the pinned Camoufox. Never upgrade it without testing a login: newer builds get the 427 block.

1. Settings file, mode 600, at `~/.config/garmin-home.env`:

   ```
   GARMIN_EMAIL=...
   GARMIN_PASSWORD=...
   SYNC_TOKEN=...            # same value as the Worker secret
   GARMIN_PROXY_TOKEN=...    # openssl rand -hex 32; same value as the Worker secret
   ```

2. Proxy and login timer:

   ```bash
   cd ~/Development/Personal/garmin-givemydata && git pull
   cp home/systemd/garmin-* ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now garmin-proxy.service
   ```

3. Tunnel. Create one in the Cloudflare dashboard (Workers VPC → Tunnels → Create, name `via-server-garmin`),
   copy its token into `~/.config/garmin-tunnel.env` (mode 600) as `TUNNEL_TOKEN=...`, then:

   ```bash
   docker run -d --name cloudflared-garmin --restart unless-stopped --network host \
     --env-file ~/.config/garmin-tunnel.env cloudflare/cloudflared:latest \
     tunnel --no-autoupdate --protocol quic run
   ```

4. VPC service, from any machine with wrangler. Put the id it prints in `web/wrangler.toml`:

   ```bash
   cd web && npx wrangler vpc service create garmin-home --type http --http-port 8791 \
     --tunnel-id <TUNNEL_ID> --hostname localhost
   ```

5. After the Worker is deployed: `systemctl --user enable --now garmin-login.timer`.

If Workers VPC (a beta) is ever the problem, add a public hostname to the same tunnel pointing at
`http://localhost:8791`, remove `[[vpc_services]]` from `wrangler.toml`, and set `GARMIN_PROXY_URL` to that
hostname. No code changes: the proxy checks its own token.

### Deploying

```bash
cd web && bun install && bun test && bun run deploy
```

Secrets (`wrangler secret put`): `MCP_BEARER`, `SYNC_TOKEN`, `SLACKPIPES_WEBHOOK`, `GARMIN_PROXY_TOKEN`,
and `SESSION_KEY` (`openssl rand -hex 32`; changing it just forces a new login).

Schema: `bun run db:migrate:0006` before the first deploy of this version.

### Teardown of the old container

`GarminCollector`, the Durable Object that ran the container, is still exported but unbound and does nothing.
Deleting it needs a migration that can't be rolled back. Once the new path has run cleanly for a week, remove
the class from `web/src/server.ts`, add this to `wrangler.toml`, and deploy:

```toml
[[migrations]]
tag = "v2"
deleted_classes = ["GarminCollector"]
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

All routes use `Authorization: Bearer $MCP_BEARER`:

- `POST /mcp` is the MCP endpoint.
- `POST /sync` starts a sync (`?date=YYYY-MM-DD` to sync another day).
- `GET /sync` returns sync status.
- `PUT /sync/session` replaces the Garmin cookies.
- `SYNC_TOKEN` also works for the `/sync` routes. via-server uses it.
- `GET /brief` returns the morning brief.

The public dashboard API (`/api/*`) is documented at `/docs`.

## Gotchas

- A sleep `calendar_date` is the wake date.
- `sleep.pending` means Garmin has not scored the night yet, not that the watch was off.
- For HRV, use `last_night`; `weekly_avg` is Garmin's smoothed value.
- Nap minutes stay separate from last night's sleep.
