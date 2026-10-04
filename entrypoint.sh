#!/bin/sh
# Cloudflare Containers have no /dev/shm; Python's multiprocessing locks (used by Camoufox) and Firefox need it.
mkdir -p /dev/shm && chmod 1777 /dev/shm

# Join the tailnet in the background and send traffic out through via-server, since Garmin blocks
# logins from Cloudflare. The collector must open its port within 20s, so it doesn't wait for this;
# the browser checks for the exit node at launch (garmin_client/client.py _home_proxy).
if [ -n "$TS_AUTHKEY" ]; then
  tailscaled --tun=userspace-networking --socks5-server=localhost:1055 --state=mem: &
  (
    for _ in 1 2 3 4 5; do
      tailscale up --authkey="$TS_AUTHKEY" --hostname=garmin-collector \
        --advertise-tags=tag:garmin-collector --exit-node=100.125.200.106 && break  # via-server
      sleep 2
    done
  ) &
fi

exec python collector.py
