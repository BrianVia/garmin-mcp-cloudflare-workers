# Cloud collector (see collector.py). Built and deployed by web/wrangler.toml.
FROM python:3.12-slim

WORKDIR /app
# Pinned to versions known to log in to Garmin. Separate layers: one multi-GB layer times out
# pushing to Cloudflare's registry.
RUN pip install --no-cache-dir "camoufox[geoip]==0.5.6" "playwright==1.62.0" "httpx>=0.25" tzdata
RUN playwright install-deps firefox && rm -rf /var/lib/apt/lists/*
RUN python -m camoufox sync && python -m camoufox fetch official/152.0.4-beta.30

COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/
COPY garmin_client/ garmin_client/
COPY garmin_mcp/ garmin_mcp/
COPY entrypoint.sh collector.py sync_intraday.py sync_sleep_detail.py d1_helpers.py ./

ENV PYTHONUNBUFFERED=1 PORT=8080
EXPOSE 8080
CMD ["./entrypoint.sh"]
