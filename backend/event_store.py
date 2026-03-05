"""
GeoIntel Backend — Event Store
Thread-safe SQLite wrapper for event persistence and deduplication.
"""
import sqlite3
import threading
import time
from typing import List, Dict, Optional

from config import DB_PATH, MAX_EVENTS_DB
from keyword_detector import dedupe_key


class EventStore:
    def __init__(self, db_path: str = DB_PATH):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self):
        with self._lock:
            self._conn.execute("""
                CREATE TABLE IF NOT EXISTS events (
                    dedup_key   TEXT PRIMARY KEY,
                    title       TEXT NOT NULL,
                    desc        TEXT,
                    source      TEXT,
                    ts          INTEGER NOT NULL,
                    time        TEXT,
                    region      TEXT,
                    keywords    TEXT,
                    assets      TEXT,
                    signal      INTEGER,
                    src_count   INTEGER DEFAULT 1,
                    social_v    REAL    DEFAULT 0.0
                )
            """)
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_ts ON events (ts DESC)"
            )
            self._conn.commit()

    def insert(self, evt: Dict) -> bool:
        """
        Insert event. Returns True if inserted, False if duplicate.
        Uses INSERT OR IGNORE so dedup_key collisions are silently dropped.
        """
        key = dedupe_key(evt.get('title', ''))
        import json
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT OR IGNORE INTO events
                    (dedup_key, title, desc, source, ts, time,
                     region, keywords, assets, signal, src_count, social_v)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    key,
                    evt.get('title', '')[:90],
                    evt.get('desc', '')[:200],
                    evt.get('source', ''),
                    evt.get('ts', int(time.time() * 1000)),
                    evt.get('time', ''),
                    evt.get('region', 'GLOBAL'),
                    json.dumps(evt.get('keywords', [])),
                    json.dumps(evt.get('assets', [])),
                    evt.get('signal', 0),
                    evt.get('srcCount', 1),
                    evt.get('socialV', 0.0),
                ),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def get_recent(self, limit: int = 100) -> List[Dict]:
        """Return the most recent events as dicts, newest first."""
        import json
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM events ORDER BY ts DESC LIMIT ?", (limit,)
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d['keywords'] = json.loads(d.get('keywords') or '[]')
            d['assets']   = json.loads(d.get('assets')   or '[]')
            d['srcCount'] = d.pop('src_count', 1)
            d['socialV']  = d.pop('social_v', 0.0)
            d.pop('dedup_key', None)
            result.append(d)
        return result

    def prune(self, max_rows: int = MAX_EVENTS_DB):
        """Delete oldest rows beyond max_rows to keep the DB lean."""
        with self._lock:
            self._conn.execute("""
                DELETE FROM events
                WHERE dedup_key IN (
                    SELECT dedup_key FROM events
                    ORDER BY ts DESC
                    LIMIT -1 OFFSET ?
                )
            """, (max_rows,))
            self._conn.commit()

    def count(self) -> int:
        with self._lock:
            return self._conn.execute(
                "SELECT COUNT(*) FROM events"
            ).fetchone()[0]


# Module-level singleton
_store: Optional[EventStore] = None


def get_store() -> EventStore:
    global _store
    if _store is None:
        _store = EventStore()
    return _store
