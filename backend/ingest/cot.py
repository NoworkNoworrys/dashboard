"""
CFTC Commitments of Traders (COT) — weekly futures positioning data.

Data source: CFTC public files (no API key required)
  Financial futures: https://www.cftc.gov/dea/newcot/FinFutWk.txt
  Commodity futures: https://www.cftc.gov/dea/newcot/ComFutWk.txt

Updated: every Friday ~15:30 ET

What we extract:
  - Non-commercial (speculative) net positions (long - short)
  - Net position as % of open interest (sentiment score -100 to +100)
  - Week-over-week change

Markets tracked: SPY, QQQ, TLT, GLD, WTI, DXY, BTC
"""
import csv
import io
import time
from typing import Dict, Any, Optional

import requests

# ── CFTC file URLs (legacy COT format) ───────────────────────────────────────
_FIN_URL = 'https://www.cftc.gov/dea/newcot/FinFutWk.txt'   # financial futures
_COM_URL = 'https://www.cftc.gov/dea/newcot/ComFutWk.txt'   # commodity futures

# ── Market name substrings → our ticker ──────────────────────────────────────
# Match against the first column of the COT CSV (case-insensitive)
_MARKET_MAP: Dict[str, str] = {
    'E-MINI S&P 500':             'SPY',    # E-MINI S&P 500 - CME
    'S&P 500 CONSOLIDATED':       'SPY',    # S&P 500 Consolidated fallback
    'NASDAQ MINI':                'QQQ',    # NASDAQ MINI - CME
    'UST BOND':                   'TLT',    # UST Bond - CBOT (30yr proxy)
    'VIX FUTURES':                'VIX',    # VIX FUTURES - CBOE
    'U.S. DOLLAR INDEX':          'DXY',    # ICE dollar index
    'BITCOIN':                    'BTC',    # CME Bitcoin
    'EURO FX':                    'EUR',    # CME Euro FX
}

# ── Legacy COT CSV column indices ─────────────────────────────────────────────
# Source: CFTC "Legacy" COT file specification
_COL_REPORT_DATE   = 1   # "As_of_Date_In_Form_YYYY-MM-DD"
_COL_OPEN_INTEREST = 7   # "Open_Interest_All"
_COL_NC_LONG       = 8   # "NonComm_Positions_Long_All"  (speculative longs)
_COL_NC_SHORT      = 9   # "NonComm_Positions_Short_All" (speculative shorts)

# ── Cache (COT only updates weekly — cache 12h) ───────────────────────────────
_cache: Dict[str, Any] = {}
_cache_ts: float = 0.0
_CACHE_TTL = 12 * 3600  # 12 hours


def _parse_cot_file(url: str) -> Dict[str, Any]:
    """Download and parse one CFTC COT file. Returns {ticker: {...}}."""
    result: Dict[str, Any] = {}
    try:
        resp = requests.get(url, timeout=20,
                            headers={'User-Agent': 'Mozilla/5.0 GeoIntel/1.0'})
        resp.raise_for_status()
        text = resp.text
    except Exception as e:
        print(f'[COT] Fetch error {url}: {e}')
        return {}

    rows = list(csv.reader(io.StringIO(text)))
    # Skip header row
    data_rows = rows[1:] if rows else []

    for row in data_rows:
        if len(row) < 15:
            continue
        market_name = row[0].strip().upper()

        # Match to a ticker
        ticker: Optional[str] = None
        for key, tkr in _MARKET_MAP.items():
            if key.upper() in market_name:
                ticker = tkr
                break
        if not ticker:
            continue
        # Skip if we already have a (possibly better) match
        if ticker in result:
            continue

        try:
            oi    = int(row[_COL_OPEN_INTEREST].replace(',', '').strip())
            nc_l  = int(row[_COL_NC_LONG].replace(',', '').strip())
            nc_s  = int(row[_COL_NC_SHORT].replace(',', '').strip())
        except (ValueError, IndexError):
            continue

        net      = nc_l - nc_s
        sentiment = round(net / oi * 100, 1) if oi else 0.0   # -100 to +100

        # Interpret positioning
        if   sentiment >= 30: positioning = 'NET_LONG_EXTREME'
        elif sentiment >= 15: positioning = 'NET_LONG'
        elif sentiment >= 5:  positioning = 'SLIGHTLY_LONG'
        elif sentiment <= -30: positioning = 'NET_SHORT_EXTREME'
        elif sentiment <= -15: positioning = 'NET_SHORT'
        elif sentiment <= -5: positioning = 'SLIGHTLY_SHORT'
        else:                 positioning = 'NEUTRAL'

        # Normalise report_date: CFTC Legacy file uses YYMMDD (e.g. "260317")
        # Convert to ISO YYYY-MM-DD so JS Date() can parse it directly.
        raw_date = row[_COL_REPORT_DATE].strip()
        if len(raw_date) == 6 and raw_date.isdigit():
            iso_date = f'20{raw_date[:2]}-{raw_date[2:4]}-{raw_date[4:]}'
        else:
            iso_date = raw_date   # already ISO or unknown format — pass through

        result[ticker] = {
            'ticker':      ticker,
            'report_date': iso_date,
            'open_interest': oi,
            'nc_long':     nc_l,
            'nc_short':    nc_s,
            'net':         net,
            'sentiment':   sentiment,    # net / OI × 100  (-100 to +100)
            'positioning': positioning,
            'market_name': market_name[:60],
        }

    return result


def fetch_cot() -> Dict[str, Any]:
    """Fetch financial futures COT data. Returns {ticker: {...}}."""
    data: Dict[str, Any] = {}
    data.update(_parse_cot_file(_FIN_URL))
    # Note: _COM_URL (commodity futures) returns 404 from CFTC — financial file
    # covers VIX, S&P 500, QQQ, bonds, dollar, bitcoin, EUR which are the key markets.

    print(f'[COT] Fetched {len(data)} markets: {list(data.keys())}')
    return data


def get_cache() -> Dict[str, Any]:
    """Return cached COT data, refreshing if stale (> 12h)."""
    global _cache, _cache_ts
    now = time.time()
    if _cache and (now - _cache_ts) < _CACHE_TTL:
        return _cache
    fresh = fetch_cot()
    if fresh:
        _cache    = fresh
        _cache_ts = now
    return _cache or {}
