#!/usr/bin/env python3
"""Garmin login for via-server: if the Worker needs a new session, log in with the browser and upload it.

Run by garmin-login.timer, and by home/proxy.py when the Worker's session dies. When no login is
needed this is one HTTP request. Pass --force to log in anyway.

Env: GARMIN_EMAIL, GARMIN_PASSWORD, SYNC_TOKEN, GARMIN_WORKER_URL (https://garmin.brianvia.com),
     GARMIN_STATE_DIR (~/.local/state/garmin-login)
"""

import fcntl
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

WORKER = os.environ.get("GARMIN_WORKER_URL", "https://garmin.brianvia.com")
STATE = Path(os.environ.get("GARMIN_STATE_DIR", Path.home() / ".local" / "state" / "garmin-login"))
SESSION_FILE = STATE / "garmin_session.json"
FAILURES_FILE = STATE / "failures.json"
BACKOFF_MINUTES = (25, 60, 120, 240, 480)


def for_connect(cookie: dict) -> bool:
    """True for cookies connect.garmin.com receives. SSO cookies can mint logins, so they never leave this machine."""
    domain = cookie["domain"].lstrip(".")
    return domain == "connect.garmin.com" or "connect.garmin.com".endswith("." + domain)


def connect_only(cookie: dict) -> bool:
    return cookie["domain"].lstrip(".") == "connect.garmin.com"


def wait_left(failures: dict, now: float) -> float:
    """Seconds until another attempt is allowed. Repeated failed logins are what get an account or IP blocked."""
    if not failures.get("count"):
        return 0
    minutes = BACKOFF_MINUTES[min(failures["count"], len(BACKOFF_MINUTES)) - 1]
    return max(0.0, failures["at"] + minutes * 60 - now)


def write_private(path: Path, value: dict):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(value, f)


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def worker(method: str, path: str, body: dict = None) -> dict:
    request = urllib.request.Request(
        WORKER + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {os.environ['SYNC_TOKEN']}",
            "Content-Type": "application/json",
            "User-Agent": "garmin-login/1",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def browser_login() -> dict:
    """Log in with Camoufox and return the new session. Garmin's SSO cookies usually make this passwordless."""
    from garmin_client import GarminClient

    saved = read_json(SESSION_FILE)
    if saved.get("cookies"):
        # With its app cookies the browser would just reuse the old session, so make it go through SSO.
        write_private(SESSION_FILE, {**saved, "cookies": [c for c in saved["cookies"] if not connect_only(c)]})
    client = GarminClient(
        email=os.environ["GARMIN_EMAIL"],
        password=os.environ["GARMIN_PASSWORD"],
        profile_dir=STATE / "browser_profile",
        headless=True,
        engine="camoufox",
        session_file=SESSION_FILE,
    )
    try:
        if not client.login(timeout_ms=120_000):
            raise RuntimeError("Garmin login failed")
    finally:
        client.close()
    session = read_json(SESSION_FILE)
    cookies = [c for c in session.get("cookies", []) if for_connect(c)]
    if not any(c["name"] == "session" for c in cookies):
        raise RuntimeError("logged in, but Garmin set no session cookie")
    return {"cookies": cookies, "saved_at": session["saved_at"]}


def main():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / "lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit("another login is running")

        login = worker("GET", "/sync")["login"]
        if not login["needed"] and "--force" not in sys.argv:
            print(f"no login needed; session expires {login['session_expires_at']}")
            return
        failures = read_json(FAILURES_FILE)
        if left := wait_left(failures, time.time()):
            sys.exit(f"login needed, but {failures['count']} attempts failed; next try in {left / 60:.0f} min")

        print(f"logging in: {login['reason'] or 'forced'}", flush=True)
        try:
            worker("PUT", "/sync/session", browser_login())
        except Exception:
            write_private(FAILURES_FILE, {"count": failures.get("count", 0) + 1, "at": time.time()})
            raise
        FAILURES_FILE.unlink(missing_ok=True)
        print("session uploaded", flush=True)
        try:
            print("sync:", worker("POST", "/sync")["status"])
        except urllib.error.HTTPError as exc:  # 409: one is already running
            print("sync: HTTP", exc.code)


if __name__ == "__main__":
    main()
