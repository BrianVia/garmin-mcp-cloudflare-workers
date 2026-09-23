# Cloud collector (see collector.py). Built and deployed by web/wrangler.toml.
FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir "camoufox[geoip]>=0.4" "playwright>=1.40" "httpx>=0.25" tzdata \
    && playwright install-deps firefox \
    && python -m camoufox fetch \
    && rm -rf /var/lib/apt/lists/*

COPY garmin_client/ garmin_client/
COPY garmin_mcp/ garmin_mcp/
COPY collector.py sync_intraday.py sync_sleep_detail.py d1_helpers.py ./

ENV PYTHONUNBUFFERED=1 PORT=8080
EXPOSE 8080
# Cloudflare Containers have no /dev/shm; Python's multiprocessing locks (used by Camoufox) and Firefox need it.
CMD ["sh", "-c", "mkdir -p /dev/shm && chmod 1777 /dev/shm && exec python collector.py"]
