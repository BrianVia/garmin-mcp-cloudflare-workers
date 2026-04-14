"""Shared helpers for pushing SQL to Cloudflare D1 via wrangler."""

import subprocess
import time
from pathlib import Path

MAX_ATTEMPTS = 3
BACKOFF_SECONDS = [5, 20]  # Waits between attempt 1→2 and 2→3


def execute_sql_file(
    sql_file: Path,
    d1_name: str,
    cwd: Path,
    label: str = "D1",
) -> None:
    """Run `wrangler d1 execute --file=... --remote` with retry on transient errors.

    Raises RuntimeError if all attempts fail. Deletes the SQL file on completion.
    """
    last_stderr = ""
    success = False
    attempt = 0

    for attempt in range(1, MAX_ATTEMPTS + 1):
        result = subprocess.run(
            ["npx", "wrangler", "d1", "execute", d1_name, "--remote", f"--file={sql_file}"],
            cwd=str(cwd),
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            success = True
            break

        last_stderr = result.stderr
        print(f"[{label}] attempt {attempt}/{MAX_ATTEMPTS} failed:\n{result.stderr.strip()}")
        if attempt < MAX_ATTEMPTS:
            wait = BACKOFF_SECONDS[attempt - 1]
            print(f"[{label}] retrying in {wait}s...")
            time.sleep(wait)

    Path(sql_file).unlink(missing_ok=True)

    if not success:
        raise RuntimeError(
            f"{label} push failed after {MAX_ATTEMPTS} attempts.\nLast error:\n{last_stderr}"
        )

    print(f"[{label}] succeeded on attempt {attempt}.")
