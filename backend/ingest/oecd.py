"""
GeoIntel Backend — OECD-equivalent Macro Ingester
Fetches key economic indicators for OECD member countries.
Uses World Bank API (free, no key) as the data source — same underlying data,
more reliable access than OECD's own SDMX endpoint.

Refreshed in batch — called once at startup then every 6h with macro data.
"""
import requests
from typing import Dict

_WB_BASE = 'https://api.worldbank.org/v2/country'

# OECD member country ISO-2 codes most relevant to geopolitical analysis
_COUNTRIES = ['US', 'GB', 'DE', 'FR', 'JP', 'KR', 'TR', 'PL', 'HU', 'CZ']

# World Bank indicator code → friendly label
_INDICATORS = {
    'unemployment': 'SL.UEM.TOTL.ZS',    # unemployment % of labour force
    'cpi':          'FP.CPI.TOTL.ZG',    # CPI inflation (annual %)
    'gdp_growth':   'NY.GDP.MKTP.KD.ZG', # GDP growth (annual %)
}

_cache: Dict[str, Dict] = {}


def _fetch_indicator(label: str, indicator: str) -> Dict[str, float]:
    """Fetch one World Bank indicator for all countries. Returns {iso2: value}."""
    countries = ';'.join(_COUNTRIES)
    url = f'{_WB_BASE}/{countries}/indicator/{indicator}'
    try:
        r = requests.get(url, params={'format': 'json', 'mrv': 3, 'per_page': 100}, timeout=20)
        r.raise_for_status()
        payload = r.json()
        rows = payload[1] if isinstance(payload, list) and len(payload) > 1 else []

        result = {}
        for row in (rows or []):
            iso2 = (row.get('countryiso3code') or '')[:2]  # iso3 → iso2 prefix
            # Use country id (iso2) directly
            cid = row.get('country', {}).get('id', '')
            val = row.get('value')
            if val is not None and cid:
                if cid not in result:  # take most recent (mrv=3 returns newest first)
                    result[cid] = round(float(val), 2)
        return result
    except Exception as e:
        print(f'[OECD] {label} error: {e}')
        return {}


def fetch_oecd() -> Dict[str, Dict]:
    """
    Fetch macro indicators for key OECD member countries via World Bank API.
    Results stored in _cache and returned.
    """
    global _cache
    result: Dict[str, Dict] = {}

    for label, indicator in _INDICATORS.items():
        values = _fetch_indicator(label, indicator)
        for iso2, val in values.items():
            if iso2 not in result:
                result[iso2] = {}
            result[iso2][label] = val

    if result:
        _cache = result
    country_count = sum(1 for v in result.values() if v)
    print(f'[OECD] fetched data for {country_count} countries')
    return _cache


def get_cache() -> Dict[str, Dict]:
    return _cache
