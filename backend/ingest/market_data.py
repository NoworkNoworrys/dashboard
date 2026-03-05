"""
GeoIntel Backend — Market Data Ingester
Fetches live prices for crypto (CoinGecko) and equities/commodities (Yahoo Finance).
Both APIs are free and require no key.
"""
import requests
from typing import Dict, Any

from config import (
    COINGECKO_URL,
    YAHOO_QUOTE_URL,
    YAHOO_SYMBOLS,
    BROWSER_HEADERS,
)


def fetch_market_prices() -> Dict[str, Dict[str, Any]]:
    """
    Returns a dict keyed by our internal ticker symbols, e.g.:
    {
      'BTC':   {'price': 65432.10, 'chg24h': 2.34, 'chg1h': 0.12},
      'WTI':   {'price': 82.50,    'chg24h': -0.80, 'chg1h': 0.05},
      ...
    }
    Returns empty dict on total failure.
    """
    prices: Dict[str, Dict[str, Any]] = {}
    prices.update(_fetch_crypto())
    prices.update(_fetch_yahoo())
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


# ── Yahoo Finance (commodities, equities) ────────────────────────────────────

def _fetch_yahoo() -> Dict[str, Dict[str, Any]]:
    yahoo_tickers = list(YAHOO_SYMBOLS.values())
    symbols_str   = ','.join(yahoo_tickers)
    url = YAHOO_QUOTE_URL.format(symbols=symbols_str)

    try:
        resp = requests.get(url, headers=BROWSER_HEADERS, timeout=12)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f'[MARKET] Yahoo Finance error: {e}')
        return {}

    quotes = data.get('quoteResponse', {}).get('result', [])
    if not quotes:
        print('[MARKET] Yahoo Finance returned empty result')
        return {}

    # Build reverse map: Yahoo symbol → our ticker
    rev = {v: k for k, v in YAHOO_SYMBOLS.items()}
    result = {}
    for q in quotes:
        yahoo_sym = q.get('symbol', '')
        our_ticker = rev.get(yahoo_sym)
        if not our_ticker:
            continue
        price    = q.get('regularMarketPrice')
        chg24h_pct = q.get('regularMarketChangePercent')
        result[our_ticker] = {
            'price':  round(price, 2)      if price      is not None else None,
            'chg24h': round(chg24h_pct, 2) if chg24h_pct is not None else None,
            'chg1h':  None,  # Yahoo v7 doesn't give 1h easily
        }

    print(f'[MARKET] Yahoo Finance: {list(result.keys())}')
    return result
