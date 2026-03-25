"""
GeoIntel Backend — FRED Ingester
Fetches US and global economic indicators from the Federal Reserve Bank
of St. Louis (FRED). Free key at fred.stlouisfed.org.

Set env var: FRED_KEY

Key series tracked:
  - DFF       Federal Funds Rate
  - T10Y2Y    10Y-2Y yield curve spread (recession signal)
  - BAMLH0A0HYM2  High-yield spread (credit stress)
  - DCOILWTICO WTI crude oil price
  - DTWEXBGS   USD broad trade-weighted index
  - CPIAUCSL   US CPI
  - UNRATE     US Unemployment Rate
  - M2SL       M2 Money Supply
  - VIXCLS     VIX (cross-check)
  - GEPUCURRENT Global Economic Policy Uncertainty Index
"""
import requests
from typing import Dict

from config import FRED_KEY
FRED_URL = 'https://api.stlouisfed.org/fred/series/observations'

_SERIES = {
    'fed_funds_rate':     'DFF',
    'yield_curve_10y2y':  'T10Y2Y',
    'hy_spread':          'BAMLH0A0HYM2',
    'wti_crude':          'DCOILWTICO',
    'usd_index':          'DTWEXBGS',
    'us_cpi':             'CPIAUCSL',
    'us_unemployment':    'UNRATE',
    'm2_money_supply':    'M2SL',
    'vix':                'VIXCLS',
    'global_epu':         'GEPUCURRENT',
}

_cache: Dict[str, float] = {}


def fetch_fred() -> Dict[str, float]:
    """
    Fetch the latest observation for each tracked FRED series.
    Results stored in _cache and returned as {label: value}.
    Returns cached data if no key is configured.
    """
    if not FRED_KEY:
        return _cache

    result: Dict[str, float] = {}
    for label, series_id in _SERIES.items():
        try:
            r = requests.get(
                FRED_URL,
                params={
                    'series_id':        series_id,
                    'api_key':          FRED_KEY,
                    'file_type':        'json',
                    'sort_order':       'desc',
                    'observation_start': '2020-01-01',
                    'limit':            1,
                },
                timeout=10,
            )
            r.raise_for_status()
            obs = r.json().get('observations', [])
            if obs and obs[0].get('value') not in ('.', '', None):
                result[label] = round(float(obs[0]['value']), 4)
        except Exception as e:
            print(f'[FRED] {series_id} error: {e}')

    if result:
        _cache.update(result)
    print(f'[FRED] fetched {len(result)}/{len(_SERIES)} series')
    return _cache


def get_cache() -> Dict[str, float]:
    return _cache
