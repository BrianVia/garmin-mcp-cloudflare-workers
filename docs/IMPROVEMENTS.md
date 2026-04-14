# Improvements & Feature Ideas

A living wishlist for `garmin-givemydata`. Captured after a full-stack review of the Python scraper, Cloudflare Workers API, and Preact dashboard.

Three sections:

1. **Big swings** — features worth building, ordered by "creates something that doesn't exist elsewhere."
2. **Hardening** — unsexy but load-bearing fixes, grouped by risk (P0 → P3).
3. **If you only do three things** — the highest-leverage subset.

---

## 1. Big swings

### Correlation engine — "Why did I feel like that?"

The data you're hoarding is ideal for causal-ish analysis, and no one else (Garmin, Whoop, Oura) does this well. Build a page that answers *"what drove last night's bad sleep?"* by regressing a target metric against recent features: caffeine cutoff time, last workout intensity, alcohol, stress curve, bed-time drift, resting HR, training load.

- Implementation: ridge regression or gradient boost. Either Workers AI, or numpy on the Python side posting results back to a `correlations` table in D1.
- UI: ranked card list — *"Late caffeine had the strongest negative correlation with deep sleep over your last 90 days (β=−0.34, p=0.002)."*
- Why it matters: this is the killer feature. Every other page is table stakes.

### Natural-language query — "Ask my body"

You already have an MCP server with a `custom_select` tool. Wrap the dashboard in a chat input that routes to Claude via the MCP, so you can ask:

- *"How was my HRV the week I was sick in February?"*
- *"Find every run where my pace dropped more than 30s/mi from the first mile to the last."*

Garmin Connect can't do this and never will. All the plumbing exists — it's a thin Worker that proxies to the Messages API with MCP tools wired in, plus a small frontend.

### Training plan co-pilot

Given endurance score, VO2max trend, race predictions, and recent training load, suggest tomorrow's workout. Not a generic plan — one tuned to your freshness (readiness score), target race distance, and recent polarized/threshold balance.

- Start prescriptive: a daily recommendation card on the dashboard.
- Evolve into a full multi-week plan builder.
- This is where the data finally *does* something for you instead of being observed.

### Anomaly alerts before you ask

Nightly Worker cron: compare last night's metrics against your 30-day baseline + seasonal adjustment. If HRV crashes >2σ, resting HR jumps, body battery recovery flatlines → push to Slack (already wired via `SlackPipes`).

- Catches early illness, overtraining, poor recovery.
- Ring notifies you of elevated stress *after* the fact; this would page you that *morning*.

### Longitudinal narrative pages

A "2026 so far" page that narrates your year: mileage trajectory, sleep-debt months, longest streak, fittest week, PRs earned. Auto-generated paragraphs — *"You ran 480 miles in Q1 — 18% more than Q1 2025, with resting HR dropping from 52 to 47"* — plus a hero visualization per section.

This is what Strava Year-in-Review wishes it was.

### FIT file deep dive

The README mentions FIT downloads but the dashboard doesn't surface them. Per-activity:

- Power curve (best-5s, 1-min, 5-min, 20-min)
- Normalized Power / Intensity Factor / Variability Index
- Elevation profile with HR overlay
- GPS map (Mapbox / MapLibre on Workers)

Most of this data is *already in D1 tables* — just needs the viz.

### Progressive-disclosure dashboards

Right now every page shows everything. Add a "focus mode" toggle: one metric, full-screen, year of context, annotations for life events (vacation, illness, races), and a long-form "what I learned" field you can write into.

Turns the dashboard into a self-quantification journal instead of a Garmin Connect clone.

### Export / backup / portability

A "download everything" button: Parquet dump of all D1 tables + JSON of any `raw_json` you still have locally. The whole *point* of the name `givemydata` is data sovereignty — right now the data is locked in D1 with a risk of silent loss. Scheduled R2 snapshots, monthly, with one-click restore.

### Fresh-data indicator

Small but high-value. Surface `lastSyncTimestampGMT` (present on Garmin's own payload) in the dashboard header: *"Garmin last reported: 4m ago"* — so when numbers look stale, you immediately know whether it's a code problem or a phone-sync problem.

Inspired by the 737-vs-3873 step-count moment: the dashboard was correct, Garmin's cloud was stale, but there was no way to tell from the UI alone.

---

## 2. Hardening

Grouped by risk, highest first.

### Security (P0)

- **Dashboard is public.** Anyone with the URL sees HR, weight, sleep — health data most people treat as private. Put **Cloudflare Access** in front of the Worker (5-min setup, free tier, email-gated). Or at minimum, a bearer token on `/api/*` with a cookie set from `/login?token=...`.
- **Secrets in plaintext `.env`.** Move `GARMIN_PASSWORD` + `CLOUDFLARE_API_TOKEN` to `pass`, 1Password CLI, or `secret-tool`. `sync_cron.sh` sources via `op run --env-file=...` or `pass show`. The current file is world-readable (mode 664).
- **`sync_to_d1.py` builds SQL via string concatenation** (`escape_sql_value`). Prepared statements only, always — if `wrangler d1 execute --file` doesn't support them directly, switch to the HTTP D1 API.

### Correctness (P1)

- **Zero tests.** At least one integration test per sync tier: a fixture with canned Garmin JSON → assert rows land in SQLite → assert they propagate to a local D1 → assert `/api/meta` reflects them. That single test would have caught both the 5-day CF-token outage *and* the null-array crash.
- **Partial-write vulnerability.** Python → D1 has no transaction boundary. If wrangler dies after inserting into `daily_summary` but before `sleep`, the dashboard shows an inconsistent day forever. Wrap each day's upserts in `BEGIN/COMMIT`, or check row counts post-write and log drift.
- **No input validation on API routes.** A bad date string (`start=yesterday`) silently matches zero rows and returns empty — indistinguishable from "no data that day." Add Zod schemas on all `/api/*` query params with a 400 on failure.

### Resilience (P1)

- **Sync drift detection.** Nightly cron: compare `SELECT calendar_date FROM daily_summary WHERE calendar_date > date('now','-14 days')` on local SQLite vs D1; any missing rows → backfill + Slack alert. Catches the "local has it, D1 doesn't" case that already bit you.
- **Retry with backoff on Garmin login.** `client.py` currently returns `False` and gives up. One exponential-backoff retry (30s → 2m → 8m) would eliminate a class of cron failures from transient Cloudflare challenges.
- **`/api/*` caching.** Every page load re-runs 6+ D1 queries. Cache the health summary for 5 min with `Cache-Control: private, max-age=300` + Workers Cache API. Dashboard feels instant, D1 reads drop ~95%.

### Observability (P2)

- **Structured logging on the Worker.** Ship request logs to Logpush → R2 (cheap) or a Cloudflare Analytics Engine dataset. Right now if `/api/health/sleep/2026-04-14` 500s, you have zero visibility.
- **Sync metrics surface.** `sync_log` table exists but no dashboard surfaces it. A tiny "ops" page: last sync per script, records-upserted histogram, 7-day success rate. Canary for the whole pipeline.

### DX / code quality (P3)

- **Generate TypeScript types from D1 schema.** `drizzle-kit introspect` or a small script that reads `sqlite_master` → emits `.d.ts`. The hand-rolled interfaces in `Activities.tsx` and `Dashboard.tsx` drift from the real schema over time.
- **Extract repeated SQL patterns.** `defaultRange()` lives in `health.ts` only; the same date-range binding pattern repeats across every route.

---

## 3. If you only do three things

1. **Cloudflare Access on the dashboard.** Ten minutes. Immediately closes the "my weight is public" hole.
2. **Sync drift detection + Slack alert.** Two hours. Means you never again discover D1 is N days stale by eyeballing the chart. (Partial mitigation already shipped: failure alerts fire on any sync step abort; this would catch *silent* drift too.)
3. **"Ask my body" chat page wired to the MCP.** Half a day. Transforms the product from "Garmin Connect with nicer charts" into something with a reason to exist.

Everything else is gravy.

---

## Already shipped

Context for what's been done since this doc was started — so future-you doesn't re-propose them:

- Slack alerts on any `sync_cron.sh` failure mode, rate-limited to 1/hour per mode.
- Retry-with-backoff inside `d1_helpers.execute_sql_file()` — 3 attempts, 5s + 20s waits — shared across all three D1 push scripts.
- Null-safe iteration over Garmin `raw_json` array fields (`data.get(k) or []` pattern).
- Distance/speed unit conversion centralized in `web/client/src/lib/format.ts` (miles + mph + `/mi` pace).
