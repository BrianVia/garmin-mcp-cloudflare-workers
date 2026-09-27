#!/usr/bin/env python3
"""
Cloud collector: runs one Garmin sync into a scratch SQLite database and
returns every write it made, so the Worker can replay them on D1.

POST /sync  {"session": {...}|null, "known_activity_ids": [...], "target_date": "YYYY-MM-DD"|null}
         -> {"status", "error", "session", "result", "statements": [[sql, params], ...], "log"}
GET /result -> the last /sync response (409 while a sync is running, 404 before the first)
GET /session -> the Garmin cookies saved after login, readable mid-sync (404 if none)

The container keeps no state: the Worker owns the login session and the database.
"""

import contextlib
import io
import json
import logging
import os
import re
import sqlite3
import tempfile
import threading
import traceback
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from garmin_mcp import sync
from garmin_mcp.db import today
from sync_intraday import extract_intraday
from sync_sleep_detail import extract_sleep_detail

WRITE = re.compile(r"^\s*(INSERT|UPDATE|DELETE|REPLACE)\b", re.IGNORECASE)
NAMED = re.compile(r"(?<![:\w]):(\w+)")
BARE = re.compile(r"\?(?!\d)")
NUMBERED = re.compile(r"\?(\d+)")
PLAIN_INSERT = re.compile(r"^\s*(INSERT (?:OR REPLACE )?INTO \w+\s*\([^)]*\))\s*VALUES\s*(\(.*\))\s*;?\s*$", re.DOTALL | re.IGNORECASE)
MAX_STATEMENT_BYTES = 80_000  # D1 rejects statements over 100 KB
busy = threading.Lock()
# Kept so a caller that lost its /sync connection can still collect the result, including the
# refreshed Garmin cookies: losing those forces a fresh login, which Garmin blocks from Cloudflare.
last_response = None


class RecordingConnection(sqlite3.Connection):
    """Executes locally and records each write as D1-compatible (sql, positional params)."""

    statements: list

    def execute(self, sql, params=()):
        if WRITE.match(sql):
            self.statements.append(to_positional(sql, params))
        return super().execute(sql, params)


def to_positional(sql: str, params) -> list:
    """D1 only binds ?NNN / ? parameters, so rewrite :name to ?N."""
    if not isinstance(params, dict):
        count = iter(range(1, len(params) + 1))
        return [BARE.sub(lambda _: f"?{next(count)}", sql), list(params)]
    names: list[str] = []

    def number(match):
        if match.group(1) not in names:
            names.append(match.group(1))
        return f"?{names.index(match.group(1)) + 1}"

    return [NAMED.sub(number, sql), [params[name] for name in names]]


def literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (bool, int, float)):
        return str(int(value) if isinstance(value, bool) else value)
    return "'" + str(value).replace("'", "''") + "'"


def compact(statements: list[list]) -> list[list]:
    """Merge consecutive plain INSERTs into multi-row literal ones: D1 allows 1000 queries per invocation."""
    merged: list[list] = []
    head, rows, size = None, [], 0

    def flush():
        if rows:
            merged.append([f"{head} VALUES {', '.join(rows)}", []])
            rows.clear()

    for sql, params in statements:
        match = "ON CONFLICT" not in sql.upper() and PLAIN_INSERT.match(sql)
        if match:
            values = NUMBERED.sub(lambda m: literal(params[int(m.group(1)) - 1]), match.group(2))
        if not match or len(values.encode()) > MAX_STATEMENT_BYTES:
            flush()
            merged.append([sql, params])
            continue
        statement_head = " ".join(match.group(1).split())
        if statement_head != head or size + len(values.encode()) > MAX_STATEMENT_BYTES:
            flush()
            head, size = statement_head, 0
        rows.append(values)
        size += len(values.encode()) + 2
    flush()
    return merged


def run_sync(body: dict) -> dict:
    output = io.StringIO()
    handler = logging.StreamHandler(output)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.getLogger().addHandler(handler)

    session = body.get("session")
    sync.SESSION_FILE.unlink(missing_ok=True)
    if session:
        fd = os.open(sync.SESSION_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(session, f)

    sync_day = body.get("target_date") or today().isoformat()
    yesterday = (date.fromisoformat(sync_day) - timedelta(days=1)).isoformat()
    workdir = tempfile.TemporaryDirectory()
    conn = sqlite3.connect(Path(workdir.name) / "garmin.db", factory=RecordingConnection)
    conn.row_factory = sqlite3.Row
    conn.statements = []
    response = {"status": "ok", "error": None, "result": None}
    try:
        with contextlib.redirect_stdout(output):
            response["result"] = sync.incremental_sync(
                target_date=sync_day,
                known_activity_ids={int(i) for i in body.get("known_activity_ids") or []},
                conn=conn,
            )
        if response["result"].get("status") != "ok":
            response.update(status="error", error=response["result"].get("message"))
    except Exception as exc:
        output.write(traceback.format_exc())
        response.update(status="error", error=str(exc)[:500])
    finally:
        logging.getLogger().removeHandler(handler)

    # incremental_sync closed conn; reopen the scratch file to derive the detail tables.
    derived: list[str] = []
    with sqlite3.connect(Path(workdir.name) / "garmin.db") as scratch:
        for day in (yesterday, sync_day):
            with contextlib.suppress(sqlite3.OperationalError):
                derived += extract_sleep_detail(scratch, day) + extract_intraday(scratch, day)
    workdir.cleanup()

    response["statements"] = compact(conn.statements + [[sql, []] for sql in derived])
    response["session"] = json.loads(sync.SESSION_FILE.read_text()) if sync.SESSION_FILE.exists() else session
    response["log"] = output.getvalue()[-8000:]
    return response


class Handler(BaseHTTPRequestHandler):
    def _reply(self, status: int, payload: dict):
        data = json.dumps(payload, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/session":
            if not sync.SESSION_FILE.exists():
                return self._reply(404, {"error": "no session saved yet"})
            return self._reply(200, json.loads(sync.SESSION_FILE.read_text()))
        if self.path != "/result":
            return self._reply(200, {"ok": True, "busy": busy.locked()})
        if busy.locked():
            return self._reply(409, {"status": "busy"})
        if last_response is None:
            return self._reply(404, {"error": "no sync has run in this container"})
        self._reply(200, last_response)

    def do_POST(self):
        if self.path != "/sync":
            return self._reply(404, {"error": "not found"})
        if not busy.acquire(blocking=False):
            return self._reply(409, {"status": "busy"})
        global last_response
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            last_response = result = run_sync(body)
        finally:
            busy.release()
        self._reply(200, result)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", 8080))), Handler).serve_forever()
