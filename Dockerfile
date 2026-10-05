# Cloud collector (see collector.py). Built and deployed by web/wrangler.toml.
FROM python:3.12-slim

WORKDIR /app
# Pinned to the versions via-server logs in with: newer Camoufox builds get Garmin's 427 block.
# Separate layers: one multi-GB layer times out pushing to Cloudflare's registry.
RUN pip install --no-cache-dir "camoufox[geoip]==0.4.11" "playwright==1.58.0" "httpx>=0.25" tzdata
RUN playwright install-deps firefox && rm -rf /var/lib/apt/lists/*
# camoufox 0.4.11 always fetches the newest browser, so swap in the release via-server runs.
RUN python -m camoufox fetch && cd /root/.cache/camoufox \
    && find . -mindepth 1 -maxdepth 1 ! -name addons -exec rm -rf {} + \
    && python -c "import urllib.request; urllib.request.urlretrieve('https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.x86_64.zip', '/tmp/c.zip')" \
    && python -m zipfile -e /tmp/c.zip . && rm /tmp/c.zip && chmod +x camoufox camoufox-bin \
    && echo '{"version":"135.0.1","release":"beta.24"}' > version.json

COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/
COPY garmin_client/ garmin_client/
COPY garmin_mcp/ garmin_mcp/
COPY entrypoint.sh collector.py sync_intraday.py sync_sleep_detail.py d1_helpers.py ./

# Match the timezone of via-server's IP, which the browser exits through.
ENV PYTHONUNBUFFERED=1 PORT=8080 TZ=America/New_York LANG=en_US.UTF-8
EXPOSE 8080
CMD ["./entrypoint.sh"]
