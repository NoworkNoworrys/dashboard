"""
GeoIntel Backend — UN Comtrade Ingester
Fetches international trade flow data from the UN Comtrade database.
Free tier: 100 requests/hour (no key), 10,000/hour with free key.

API docs: https://comtradeapi.un.org/

Tracks trade flows for strategically important commodities between
geopolitically sensitive country pairs.
Refreshed in batch every 6h alongside macro data.
"""
import requests
from typing import Dict, List

COMTRADE_URL = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS'

# Commodity codes (HS) of geopolitical interest
_COMMODITIES = {
    '2709': 'crude_oil',
    '2711': 'natural_gas',
    '2601': 'iron_ore',
    '8541': 'semiconductors',
    '8542': 'integrated_circuits',
    '3102': 'fertilizers_nitrogen',
    '1001': 'wheat',
    '2844': 'nuclear_materials',
}

# Reporter countries (ISO-3 numeric) — major players
_REPORTERS = {
    '156': 'China',
    '643': 'Russia',
    '840': 'USA',
    '276': 'Germany',
    '392': 'Japan',
    '410': 'South Korea',
    '356': 'India',
}

_cache: Dict[str, Dict] = {}


def fetch_un_comtrade() -> Dict[str, Dict]:
    """
    Fetch annual trade flows for key commodities.
    Returns nested dict: {reporter: {commodity: {partner: value_usd}}}.
    """
    result: Dict[str, Dict] = {name: {} for name in _REPORTERS.values()}
    fetched = 0

    for reporter_id, reporter_name in list(_REPORTERS.items())[:3]:  # throttle: 3 countries per cycle
        for hs_code, commodity in list(_COMMODITIES.items())[:3]:    # 3 commodities per country
            try:
                r = requests.get(
                    COMTRADE_URL,
                    params={
                        'reporterCode': reporter_id,
                        'cmdCode':      hs_code,
                        'flowCode':     'M',   # Imports
                        'period':       '2023',
                        'partnerCode':  '0',   # World total
                    },
                    timeout=15,
                )
                r.raise_for_status()
                data = r.json().get('data', [])
                if data:
                    val = data[0].get('primaryValue', 0) or 0
                    if reporter_name not in result:
                        result[reporter_name] = {}
                    result[reporter_name][commodity] = round(val / 1e9, 2)  # USD billions
                    fetched += 1
            except Exception as e:
                print(f'[COMTRADE] {reporter_name}/{commodity} error: {e}')

    _cache.update(result)
    print(f'[COMTRADE] fetched {fetched} trade flow data points')
    return _cache


def get_cache() -> Dict[str, Dict]:
    return _cache
