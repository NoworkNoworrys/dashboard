"""
GeoIntel Backend — Eurostat Ingester
Fetches EU economic indicators from the Eurostat REST API.
Free, no API key required.

API docs: https://ec.europa.eu/eurostat/web/json-and-unicode-web-services

Key indicators:
  - Inflation (HICP) by country
  - Unemployment rate
  - Industrial production index
  - Energy import dependency
  - Government debt (% of GDP)
Refreshed in batch every 6h alongside macro data.
"""
import requests
from typing import Dict

EUROSTAT_BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data'

# Dataset code → params (as list for repeated geo keys) → friendly label
# Eurostat requires geo as repeated params: &geo=DE&geo=FR — not comma-separated
_DATASETS = [
    ('prc_hicp_manr',
     [('geo','DE'),('geo','FR'),('geo','IT'),('geo','ES'),('geo','PL'),('geo','HU'),('geo','RO'),('geo','SE'),
      ('coicop','CP00'),('lastTimePeriod',1)],
     'hicp_inflation'),
    ('une_rt_m',
     [('geo','DE'),('geo','FR'),('geo','IT'),('geo','ES'),('geo','PL'),('geo','HU'),
      ('sex','T'),('age','TOTAL'),('lastTimePeriod',1)],
     'unemployment'),
    ('sts_inpr_m',
     [('geo','DE'),('geo','FR'),('geo','IT'),('geo','ES'),
      ('nace_r2','MIG_ING'),('lastTimePeriod',1)],
     'industrial_production'),
]

_cache: Dict[str, Dict] = {}


def _fetch_dataset(dataset: str, params: list, label: str) -> Dict[str, float]:
    """Fetch one Eurostat dataset and return {country_code: latest_value}."""
    try:
        r = requests.get(
            f'{EUROSTAT_BASE}/{dataset}',
            params=params + [('format', 'JSON')],
            timeout=20,
        )
        r.raise_for_status()
        data = r.json()

        # Eurostat JSON-stat format: dimension → value array
        dims   = data.get('dimension', {})
        values = data.get('value', {})

        geo_dim = dims.get('geo', {}).get('category', {})
        geo_idx = geo_dim.get('index', {})  # {country_code: position}

        result = {}
        for code, idx in geo_idx.items():
            val = values.get(str(idx))
            if val is not None:
                result[code] = round(float(val), 2)
        return result
    except Exception as e:
        print(f'[EUROSTAT] {dataset} error: {e}')
        return {}


def fetch_eurostat() -> Dict[str, Dict]:
    """
    Fetch key EU economic indicators for member states.
    Returns nested dict: {country_code: {indicator: value}}.
    """
    combined: Dict[str, Dict] = {}

    for dataset, params, label in _DATASETS:
        values = _fetch_dataset(dataset, params, label)
        for country, val in values.items():
            if country not in combined:
                combined[country] = {}
            combined[country][label] = val

    if combined:
        _cache.update(combined)
    print(f'[EUROSTAT] fetched data for {len(combined)} EU countries')
    return _cache


def get_cache() -> Dict[str, Dict]:
    return _cache
