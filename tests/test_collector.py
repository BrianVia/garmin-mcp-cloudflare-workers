import sqlite3

from collector import compact, to_positional


def test_replayed_writes_match_local_sqlite():
    statements = [
        to_positional("INSERT OR REPLACE INTO t (id, v) VALUES (:id, :v)", {"id": 1, "v": "it's 10:30"}),
        to_positional("INSERT OR REPLACE INTO t (id, v) VALUES (?, ?)", (2, None)),
        to_positional("INSERT INTO t (id, v) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET v = COALESCE(t.v, excluded.v)", (2, "x")),
        ["DELETE FROM t WHERE id = ?1", [1]],
        to_positional("INSERT OR REPLACE INTO t (id, v) VALUES (?, ?)", (3, 1.5)),
        ["INSERT OR REPLACE INTO t (id, v) VALUES (4, 'y');", []],
    ]
    merged = compact(statements)
    assert len(merged) == 4  # two merged INSERTs, the upsert and the DELETE stay, then one merged tail

    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v)")
    for sql, params in merged:
        db.execute(sql, params)
    assert db.execute("SELECT * FROM t ORDER BY id").fetchall() == [(2, "x"), (3, 1.5), (4, "y")]
