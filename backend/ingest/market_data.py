"""
GeoIntel Backend — Market Data Ingester
Fetches live prices for:
  • Crypto        — CoinGecko (free, no key)
  • Commodities / equities — Stooq (free, no key, no rate limit)
  • VIX           — Stooq VX.F (front-month VIX futures — good proxy)
  • US10Y yield   — US Treasury FiscalData API (official, free, no key)

Replaced Yahoo Finance (v7/v8) which returns 429 too aggressively.
"""
import csv
import io
import datetime
import requests
from typing import Dict, Any

from config import COINGECKO_URL, BROWSER_HEADERS


# ── Stooq symbol map: our ticker → Stooq symbol ──────────────────────────────
STOOQ_SYMBOLS: Dict[str, str] = {
    'WTI':   'CL.F',    # WTI Crude Oil (front-month futures)
    'BRENT': 'BR.F',    # Brent Crude Oil Futures
    'GLD':   'GC.F',    # Gold Futures
    'WHT':   'ZW.F',    # Wheat Futures
    'GAS':   'NG.F',    # Natural Gas Futures
    'LMT':   'LMT.US',  # Lockheed Martin
    'TSM':   'TSM.US',  # Taiwan Semiconductor
    'SPY':   'SPY.US',  # S&P 500 ETF
    'DXY':   'DX.F',    # US Dollar Index Futures
    'VIX':   'VX.F',    # VIX Futures (front-month; proxy for CBOE VIX)
}

# US Treasury daily yield curve — 10-Year column
_TREASURY_URL = (
    'https://home.treasury.gov/resource-center/data-chart-center/'
    'interest-rates/daily-treasury-rates.csv/{year}/all'
    '?type=daily_treasury_yield_curve'
    '&field_tdr_date_value_month={ym}'
    '&data-chart-center-interest-rates=Separate'
    '&download_data_type=CSV'
)

# Stooq real-time quote endpoint (no rate limit, no key required)
# Returns CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
_STOOQ_BASE = 'https://stooq.com/q/l/?s={symbol}&f=sd2t2ohlcv&h&e=csv'


def fetch_market_prices() -> Dict[str, Dict[str, Any]]:
    """
    Returns a dict keyed by our internal ticker symbols, e.g.:
    {
      'BTC':   {'price': 85000.0, 'chg24h': 2.34},
      'VIX':   {'price': 18.5,   'chg24h': -0.80},
      'US10Y': {'price': 4.15,   'chg24h': -0.03},
      ...
    }
    """
    prices: Dict[str, Dict[str, Any]] = {}
    prices.update(_fetch_crypto())
    prices.update(_fetch_stooq())
    prices.update(_fetch_us10y())
    return prices


# ── CoinGecko (BTC, ETH) ─────────────────────────────────────────────────────

def _fetch_crypto() -> Dict[str, Dict[str, Any]]:
    try:
        resp = requests.get(COINGECKO_URL, timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f'[MARKET] CoinGecko error: {e}')
        return {}

    result = {}
    mapping = {'bitcoin': 'BTC', 'ethereum': 'ETH'}
    for coin_id, ticker in mapping.items():
        if coin_id not in data:
            continue
        c = data[coin_id]
        result[ticker] = {
            'price':  c.get('usd'),
            'chg24h': c.get('usd_24h_change'),
            'chg1h':  c.get('usd_1h_change'),
        }

    print(f'[MARKET] CoinGecko: {list(result.keys())}')
    return result


# ── Stooq (commodities, equities, VIX, DXY) ──────────────────────────────────

def _stooq_price(symbol: str) -> Dict[str, Any]:
    """
    Fetch the current Stooq quote for `symbol`.
    CSV columns: Symbol, Date, Time, Open, High, Low, Close, Volume
    Uses intraday (Open→Close) as a proxy for 24h change.
    Returns {'price': float, 'chg24h': float} or {} on failure.
    """
    url = _STOOQ_BASE.format(symbol=symbol.lower())
    try:
        resp = requests.get(url, headers=BROWSER_HEADERS, timeout=10)
        resp.raise_for_status()
        rows = list(csv.reader(io.StringIO(resp.text)))
    except Exception as e:
        print(f'[MARKET] Stooq {symbol} error: {e}')
        return {}

    # rows[0] = header, rows[1] = quote row
    data_rows = [r for r in rows[1:] if r and len(r) >= 7 and 'N/D' not in r]
    if not data_rows:
        return {}

    row = data_rows[0]
    try:
        # Columns: 0=Symbol,1=Date,2=Time,3=Open,4=High,5=Low,6=Close,7=Volume
        open_  = float(row[3])
        close  = float(row[6])
    except (IndexError, ValueError):
        return {}

    chg24h = None
    if open_ and open_ != close:
        chg24h = round((close - open_) / open_ * 100, 2)

    return {'price': round(close, 4), 'chg24h': chg24h}


def _fetch_stooq() -> Dict[str, Dict[str, Any]]:
    result = {}
    for our_ticker, stooq_sym in STOOQ_SYMBOLS.items():
        d = _stooq_price(stooq_sym)
        if d:
            result[our_ticker] = d

    print(f'[MARKET] Stooq: {list(result.keys())}')
    return result


# ── US Treasury 10-Year Yield ─────────────────────────────────────────────────

def _fetch_us10y() -> Dict[str, Dict[str, Any]]:
    """
    Pull the official daily 10-Year yield from the US Treasury website.
    Returns {'US10Y': {'price': 4.15, 'chg24h': -0.03}} or {}.
    """
    now = datetime.date.today()
    # Try current month; fall back to previous if early in month
    for delta_months in (0, -1):
        year  = now.year  + (now.month + delta_months - 1) // 12
        month = (now.month + delta_months - 1) % 12 + 1
        ym    = f'{year}{month:02d}'
        url   = _TREASURY_URL.format(year=year, ym=ym)
        try:
            resp = requests.get(url, headers=BROWSER_HEADERS, timeout=10)
            resp.raise_for_status()
            rows = list(csv.reader(io.StringIO(resp.text)))
        except Exception as e:
            print(f'[MARKET] Treasury US10Y error: {e}')
            continue

        # rows[0] = headers, rows[1] = latest date, rows[2] = previous date
        data_rows = [r for r in rows[1:] if r and len(r) > 12]
        if not data_rows:
            continue

        # Find '10 Yr' column index
        headers = rows[0]
        try:
            idx = headers.index('10 Yr')
        except ValueError:
            print('[MARKET] Treasury: 10 Yr column not found')
            return {}

        try:
            yield_today = float(data_rows[0][idx])
        except (IndexError, ValueError):
            continue

        chg24h = None
        if len(data_rows) >= 2:
            try:
                yield_prev = float(data_rows[1][idx])
                chg24h = round(yield_today - yield_prev, 3)  # yield points, not %
            except (IndexError, ValueError):
                pass

        print(f'[MARKET] US10Y: {yield_today}% (chg24h {chg24h})')
        return {'US10Y': {'price': yield_today, 'chg24h': chg24h}}

    return {}
