"""
GeoIntel Backend — Unusual Whales Store
========================================
Dedicated SQLite persistence layer for UW-specific data that lives
alongside (but separate from) the main event store.

Tables:
  uw_flow_alerts  — deduped options flow alerts (7-day rolling)
  uw_darkpool     — dark pool prints (3-day rolling)
  uw_congress     — congressional trades (90-day rolling, rarely changes)
  uw_market_tide  — time-series of market tide snapshots (24h rolling)
  uw_iv_ranks     — most recent IV rank per ticker

The UW store also generates EE-ready signals (uw_signals table) that the
frontend agent polls to inject into the execution engine.
"""
import json
import sqlite3
import threading
import time
from typing import List, Dict, Optional

UW_DB_PATH = 'uw_data.db'  # relative to backend/ working directory


class UWStore:
    def __init__(self, db_path: str = UW_DB_PATH):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self):
        with self._lock:
            self._conn.executescript("""
                CREATE TABLE IF NOT EXISTS uw_flow_alerts (
                    id          TEXT PRIMARY KEY,
                    ticker      TEXT NOT NULL,
                    opt_type    TEXT,
                    direction   TEXT,
                    premium     REAL,
                    strike      TEXT,
                    expiry      TEXT,
                    sweep       INTEGER DEFAULT 0,
                    block       INTEGER DEFAULT 0,
                    vol_oi      REAL,
                    signal      INTEGER,
                    title       TEXT,
                    desc        TEXT,
                    assets      TEXT,
                    ts          INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_fa_ts ON uw_flow_alerts (ts DESC);
                CREATE INDEX IF NOT EXISTS idx_fa_ticker ON uw_flow_alerts (ticker);

                CREATE TABLE IF NOT EXISTS uw_darkpool (
                    id          TEXT PRIMARY KEY,
                    ticker      TEXT NOT NULL,
                    price       REAL,
                    size        INTEGER,
                    value       REAL,
                    signal      INTEGER,
                    title       TEXT,
                    ts          INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_dp_ts ON uw_darkpool (ts DESC);

                CREATE TABLE IF NOT EXISTS uw_congress (
                    id          TEXT PRIMARY KEY,
                    ticker      TEXT NOT NULL,
                    politician  TEXT,
                    party       TEXT,
                    tx_type     TEXT,
                    direction   TEXT,
                    amount      REAL,
                    committee   TEXT,
                    signal      INTEGER,
                    title       TEXT,
                    desc        TEXT,
                    assets      TEXT,
                    ts          INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_cong_ts ON uw_congress (ts DESC);

                CREATE TABLE IF NOT EXISTS uw_market_tide (
                    ts          INTEGER PRIMARY KEY,
                    call_premium REAL,
                    put_premium  REAL,
                    net_premium  REAL,
                    bull_pct     REAL,
                    tide_pct     REAL,
                    label        TEXT
                );

                CREATE TABLE IF NOT EXISTS uw_iv_ranks (
                    ticker      TEXT PRIMARY KEY,
                    iv_rank     REAL,
                    ts          INTEGER
                );
            """)
            self._conn.commit()

    # ── Flow Alerts ───────────────────────────────────────────────────────────

    def upsert_flow_alert(self, evt: Dict) -> bool:
        """Insert flow alert, skip exact duplicates. Returns True if new."""
        # Dedupe key: ticker + type + strike + expiry (same contract = same alert)
        alert_id = f"{evt['uw_ticker']}_{evt['uw_opt_type']}_{evt['uw_strike']}_{evt['uw_expiry']}_{evt['ts'] // 60000}"
        with self._lock:
            existing = self._conn.execute(
                "SELECT id FROM uw_flow_alerts WHERE id = ?", (alert_id,)
            ).fetchone()
            if existing:
                return False
            self._conn.execute("""
                INSERT OR IGNORE INTO uw_flow_alerts
                    (id, ticker, opt_type, direction, premium, strike, expiry,
                     sweep, block, vol_oi, signal, title, desc, assets, ts)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                alert_id,
                evt.get('uw_ticker', ''),
                evt.get('uw_opt_type', ''),
                evt.get('uw_direction', ''),
                evt.get('uw_premium', 0),
                evt.get('uw_strike', ''),
                evt.get('uw_expiry', ''),
                1 if evt.get('uw_sweep') else 0,
                1 if evt.get('uw_block') else 0,
                evt.get('uw_vol_oi', 0),
                evt.get('signal', 0),
                evt.get('title', ''),
                evt.get('desc', ''),
                json.dumps(evt.get('assets', [])),
                evt.get('ts', int(time.time() * 1000)),
            ))
            self._conn.commit()
            return True

    def get_flow_alerts(self, limit: int = 50, hours: int = 24) -> List[Dict]:
        cutoff = int(time.time() * 1000) - hours * 3_600_000
        with self._lock:
            rows = self._conn.execute("""
                SELECT * FROM uw_flow_alerts
                WHERE ts >= ?
                ORDER BY ts DESC LIMIT ?
            """, (cutoff, limit)).fetchall()
        return [self._row_to_dict(r) for r in rows]

    # ── Dark Pool ─────────────────────────────────────────────────────────────

    def upsert_darkpool(self, evt: Dict) -> bool:
        dp_id = f"{evt['uw_ticker']}_{evt['ts'] // 60000}_{int(evt.get('uw_value', 0))}"
        with self._lock:
            existing = self._conn.execute(
                "SELECT id FROM uw_darkpool WHERE id = ?", (dp_id,)
            ).fetchone()
            if existing:
                return False
            self._conn.execute("""
                INSERT OR IGNORE INTO uw_darkpool
                    (id, ticker, price, size, value, signal, title, ts)
                VALUES (?,?,?,?,?,?,?,?)
            """, (
                dp_id,
                evt.get('uw_ticker', ''),
                evt.get('uw_price', 0),
                evt.get('uw_size', 0),
                evt.get('uw_value', 0),
                evt.get('signal', 0),
                evt.get('title', ''),
                evt.get('ts', int(time.time() * 1000)),
            ))
            self._conn.commit()
            return True

    def get_darkpool(self, limit: int = 30, hours: int = 24) -> List[Dict]:
        cutoff = int(time.time() * 1000) - hours * 3_600_000
        with self._lock:
            rows = self._conn.execute("""
                SELECT * FROM uw_darkpool
                WHERE ts >= ?
                ORDER BY ts DESC LIMIT ?
            """, (cutoff, limit)).fetchall()
        return [self._row_to_dict(r) for r in rows]

    # ── Congress ──────────────────────────────────────────────────────────────

    def upsert_congress(self, evt: Dict) -> bool:
        cong_id = f"{evt['uw_ticker']}_{evt.get('uw_politician','?')}_{evt.get('uw_tx_type','?')}_{evt['ts'] // 86400000}"
        with self._lock:
            existing = self._conn.execute(
                "SELECT id FROM uw_congress WHERE id = ?", (cong_id,)
            ).fetchone()
            if existing:
                return False
            self._conn.execute("""
                INSERT OR IGNORE INTO uw_congress
                    (id, ticker, politician, party, tx_type, direction,
                     amount, committee, signal, title, desc, assets, ts)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                cong_id,
                evt.get('uw_ticker', ''),
                evt.get('uw_politician', ''),
                evt.get('uw_party', ''),
                evt.get('uw_tx_type', ''),
                evt.get('uw_direction', ''),
                evt.get('uw_amount', 0),
                evt.get('uw_committee', ''),
                evt.get('signal', 0),
                evt.get('title', ''),
                evt.get('desc', ''),
                json.dumps(evt.get('assets', [])),
                evt.get('ts', int(time.time() * 1000)),
            ))
            self._conn.commit()
            return True

    def get_congress(self, limit: int = 20, days: int = 90) -> List[Dict]:
        cutoff = int(time.time() * 1000) - days * 86_400_000
        with self._lock:
            rows = self._conn.execute("""
                SELECT * FROM uw_congress
                WHERE ts >= ?
                ORDER BY ts DESC LIMIT ?
            """, (cutoff, limit)).fetchall()
        return [self._row_to_dict(r) for r in rows]

    # ── Market Tide ───────────────────────────────────────────────────────────

    def upsert_tide(self, tide: Dict) -> None:
        ts = tide.get('ts', int(time.time() * 1000))
        bucket = ts // 300_000  # 5-minute buckets
        with self._lock:
            self._conn.execute("""
                INSERT OR REPLACE INTO uw_market_tide
                    (ts, call_premium, put_premium, net_premium, bull_pct, tide_pct, label)
                VALUES (?,?,?,?,?,?,?)
            """, (
                bucket * 300_000,
                tide.get('call_premium', 0),
                tide.get('put_premium', 0),
                tide.get('net_premium', 0),
                tide.get('bull_pct', 50),
                tide.get('tide_pct', 0),
                tide.get('label', 'NEUTRAL'),
            ))
            self._conn.commit()

    def get_tide(self, hours: int = 8) -> List[Dict]:
        cutoff = int(time.time() * 1000) - hours * 3_600_000
        with self._lock:
            rows = self._conn.execute("""
                SELECT * FROM uw_market_tide
                WHERE ts >= ?
                ORDER BY ts ASC
            """, (cutoff,)).fetchall()
        return [dict(r) for r in rows]

    def get_latest_tide(self) -> Optional[Dict]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM uw_market_tide ORDER BY ts DESC LIMIT 1"
            ).fetchone()
        return dict(row) if row else None

    # ── IV Ranks ──────────────────────────────────────────────────────────────

    def upsert_iv_ranks(self, iv_map: Dict[str, float]) -> None:
        ts = int(time.time() * 1000)
        with self._lock:
            for ticker, rank in iv_map.items():
                self._conn.execute("""
                    INSERT OR REPLACE INTO uw_iv_ranks (ticker, iv_rank, ts)
                    VALUES (?,?,?)
                """, (ticker, rank, ts))
            self._conn.commit()

    def get_iv_ranks(self) -> Dict[str, float]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT ticker, iv_rank FROM uw_iv_ranks"
            ).fetchall()
        return {r['ticker']: r['iv_rank'] for r in rows}

    # ── Pruning ───────────────────────────────────────────────────────────────

    def prune(self) -> None:
        now = int(time.time() * 1000)
        with self._lock:
            self._conn.execute("DELETE FROM uw_flow_alerts WHERE ts < ?", (now - 7 * 86_400_000,))
            self._conn.execute("DELETE FROM uw_darkpool    WHERE ts < ?", (now - 3 * 86_400_000,))
            self._conn.execute("DELETE FROM uw_market_tide WHERE ts < ?", (now - 86_400_000,))
            # Congress kept 90 days — prune handled by get_congress query
            self._conn.commit()

    # ── Stats ─────────────────────────────────────────────────────────────────

    def stats(self) -> Dict:
        with self._lock:
            fa  = self._conn.execute("SELECT COUNT(*) FROM uw_flow_alerts").fetchone()[0]
            dp  = self._conn.execute("SELECT COUNT(*) FROM uw_darkpool").fetchone()[0]
            cg  = self._conn.execute("SELECT COUNT(*) FROM uw_congress").fetchone()[0]
            tid = self._conn.execute("SELECT COUNT(*) FROM uw_market_tide").fetchone()[0]
            iv  = self._conn.execute("SELECT COUNT(*) FROM uw_iv_ranks").fetchone()[0]
        return {'flow_alerts': fa, 'darkpool': dp, 'congress': cg,
                'tide_snapshots': tid, 'iv_tickers': iv}

    def _row_to_dict(self, row) -> Dict:
        d = dict(row)
        if 'assets' in d and isinstance(d['assets'], str):
            try:
                d['assets'] = json.loads(d['assets'])
            except Exception:
                d['assets'] = []
        return d


# Module-level singleton
_uw_store: Optional[UWStore] = None

def get_uw_store() -> UWStore:
    global _uw_store
    if _uw_store is None:
        _uw_store = UWStore()
    return _uw_store
