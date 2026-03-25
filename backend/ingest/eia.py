"""
GeoIntel Backend — EIA Ingester
Fetches energy data from the US Energy Information Administration.
Free, no API key required.

API docs: https://www.eia.gov/opendata/

Series tracked:
  - Weekly US crude oil inventories (Cushing + total)
  - US natural gas storage
  - US crude oil production
  - Global liquid fuels supply/demand balance
  - Petroleum product prices (gasoline, diesel, jet fuel)
"""
import requests
from typing import Dict
from config import EIA_KEY as _EIA_KEY

EIA_URL = 'https://api.eia.gov/v2/seriesid/{series_id}'

# Series ID → friendly label
_SERIES = {
    'PET.WCRSTUS1.W':  'us_crude_stocks_mb',        # US crude stocks (million barrels)
    'PET.W_EPC0_SAX_YCUOK_MBBL.W': 'cushing_crude_stocks_mb',  # Cushing OK crude stocks
    'NG.NW2_EPG0_SWO_R48_BCF.W': 'us_natgas_storage_bcf',  # natural gas storage (bcf)
    'PET.MCRFPUS2.M':  'us_crude_production_mbd',    # US crude production (mb/d)
    'PET.EMM_EPMR_PTE_NUS_DPG.W': 'us_gasoline_price_gal', # retail gasoline ($/gal)
    'PET.EMD_EPD2D_PTE_NUS_DPG.W': 'us_diesel_price_gal',   # retail diesel ($/gal)
}

_cache: Dict[str, float] = {}


def _fetch_series(series_id: str):
    try:
        r = requests.get(
            f'https://api.eia.gov/v2/seriesid/{series_id}',
            params={'api_key': _EIA_KEY or 'DEMO_KEY', 'length': 1},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json().get('response', {}).get('data', [])
        if data:
            val = data[0].get('value')
            return round(float(val), 3) if val is not None else None
    except Exception as e:
        print(f'[EIA] {series_id} error: {e}')
    return None


def fetch_eia() -> Dict[str, float]:
    """
    Fetch latest EIA energy data.
    Returns {label: value} dict. Results cached in _cache.
    """
    result: Dict[str, float] = {}
    for series_id, label in _SERIES.items():
        val = _fetch_series(series_id)
        if val is not None:
            result[label] = val

    if result:
        _cache.update(result)
    print(f'[EIA] fetched {len(result)}/{len(_SERIES)} series')
    return _cache


def get_cache() -> Dict[str, float]:
    return _cache
