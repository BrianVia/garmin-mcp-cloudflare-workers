#!/usr/bin/env bash
set -euo pipefail

# Garmin data sync (every 30 min via cron)
# 1. Fetch from Garmin Connect → local SQLite
# 2. Push recent data → Cloudflare D1
# 3. Push granular sleep detail → D1

PROJECT_DIR="/home/via/Development/Personal/garmin-givemydata"
LOG_FILE="/tmp/garmin-sync.log"
ENV_FILE="$PROJECT_DIR/.env"
SYNC_TARGET_DATE="${1:-${SYNC_TARGET_DATE:-}}"
LOCK_FILE="/tmp/garmin-sync.lock"
GARMIN_SYNC_TIMEOUT_SEC="${GARMIN_SYNC_TIMEOUT_SEC:-1800}"

SLACKPIPES_WEBHOOK="REDACTED_SLACKPIPES_WEBHOOK"
ALERT_RATE_LIMIT_DIR="/tmp/garmin-sync-alerts"
ALERT_COOLDOWN_SEC=3600

mkdir -p "$(dirname "$LOG_FILE")"
exec >> "$LOG_FILE" 2>&1

log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [garmin-cron] $*"
}

run_step() {
  local step="$1"
  shift

  log "START $step"
  if "$@"; then
    log "OK $step"
    return 0
  else
    local rc=$?
    log "FAIL $step (exit=$rc)"
    return "$rc"
  fi
}

notify_failure() {
  local mode="$1"
  local detail="$2"
  mkdir -p "$ALERT_RATE_LIMIT_DIR"
  local sentinel="$ALERT_RATE_LIMIT_DIR/$mode"
  if [[ -f "$sentinel" ]]; then
    local age=$(( $(date +%s) - $(stat -c %Y "$sentinel") ))
    if (( age < ALERT_COOLDOWN_SEC )); then
      log "Suppressing alert for '$mode' (last sent ${age}s ago, cooldown ${ALERT_COOLDOWN_SEC}s)"
      return 0
    fi
  fi

  local host
  host=$(hostname)
  local tail_log
  tail_log=$(tail -n 15 "$LOG_FILE" 2>/dev/null || echo "(log unavailable)")
  local text
  text=":rotating_light: garmin-sync failed on ${host}
*mode:* ${mode}
*detail:* ${detail}
\`\`\`
${tail_log}
\`\`\`"

  local payload
  if ! payload=$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$text"); then
    log "WARN: failed to build alert payload for '$mode'"
    return 1
  fi

  if curl -fsS --max-time 10 -X POST "$SLACKPIPES_WEBHOOK" \
       -H "Content-Type: application/json" \
       -d "$payload" >/dev/null 2>&1; then
    touch "$sentinel"
    log "Sent Slack alert for '$mode'"
  else
    log "WARN: failed to send Slack alert for '$mode'"
    return 1
  fi
}

fail() {
  local mode="$1"
  local detail="$2"
  log "Aborting: $detail"
  notify_failure "$mode" "$detail" || true
  exit 1
}

cd "$PROJECT_DIR"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "Another Garmin sync is already running; skipping this cycle"
  exit 0
fi

if [[ -f "$ENV_FILE" ]]; then
  log "Loading env vars from $ENV_FILE"
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  log "ERROR: CLOUDFLARE_API_TOKEN not set. D1 sync steps will fail if attempted."
else
  log "CLOUDFLARE_API_TOKEN loaded."
fi

if ! command -v npx >/dev/null 2>&1; then
  fail "missing_npx" "npx not found on PATH"
fi

log "Starting Garmin sync cycle"
if [[ -n "$SYNC_TARGET_DATE" ]]; then
  log "Using target date override: $SYNC_TARGET_DATE"
fi

# 1) Garmin sync (local DB)
if [[ -n "$SYNC_TARGET_DATE" ]]; then
  if ! run_step "garmin_mcp.sync($SYNC_TARGET_DATE)" timeout "$GARMIN_SYNC_TIMEOUT_SEC" .venv/bin/python -m garmin_mcp.sync "$SYNC_TARGET_DATE"; then
    fail "garmin_sync" "local Garmin sync failed for target date $SYNC_TARGET_DATE"
  fi
else
  if ! run_step "garmin_mcp.sync" timeout "$GARMIN_SYNC_TIMEOUT_SEC" .venv/bin/python -m garmin_mcp.sync; then
    fail "garmin_sync" "local Garmin sync failed"
  fi
fi

# 2) D1 sync steps (requires token in cron environment)
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  fail "missing_cf_token" "CLOUDFLARE_API_TOKEN not set; D1 sync cannot proceed"
fi

if ! run_step "sync_to_d1" .venv/bin/python sync_to_d1.py; then
  fail "sync_to_d1" "sync_to_d1.py failed"
fi

if ! run_step "sync_sleep_detail" .venv/bin/python sync_sleep_detail.py; then
  fail "sync_sleep_detail" "sync_sleep_detail.py failed"
fi

if ! run_step "sync_intraday" .venv/bin/python sync_intraday.py; then
  fail "sync_intraday" "sync_intraday.py failed"
fi

log "Completed Garmin sync cycle"
