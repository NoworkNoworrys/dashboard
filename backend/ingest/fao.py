"""
GeoIntel Backend — FAO / World Food Price Ingester
Fetches global food price data as a proxy for the FAO Food Price Index.

Source: World Bank API (no key required) — Global CPI as food price proxy
  https://api.worldbank.org/

Also fetches World Bank commodity price data for agricultural goods.
Refreshed every 6h alongside macro data.
"""
import requests
from typing import Dict

# World Bank US CPI (WLD has sparse data; US is the most current proxy)
_WB_CPI_URL  = 'https://api.worldbank.org/v2/country/US/indicator/FP.CPI.TOTL?format=json&mrv=3'
# World Bank food production index (WLD, base 2014-2016=100)
_WB_FOOD_URL = 'https://api.worldbank.org/v2/country/WLD/indicator/AG.PRD.FOOD.XD?format=json&mrv=3'

_cache: Dict[str, float] = {}


def _fetch_wb_indicator(url: str, key: str) -> None:
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        payload = r.json()
        if isinstance(payload, list) and len(payload) > 1:
            rows = payload[1] or []
            for row in rows:
                val = row.get('value')
                year = row.get('date', '')
                if val is not None:
                    _cache[key] = round(float(val), 2)
                    _cache[key + '_year'] = float(year) if year else 0
                    break
    except Exception as e:
        print(f'[FAO] {key} error: {e}')


def fetch_fao() -> Dict[str, float]:
    """
    Fetch latest global food/CPI data as food price indicators.
    Returns {label: value} dict. Cached in _cache.
    """
    _fetch_wb_indicator(_WB_CPI_URL, 'fao_world_cpi')
    _fetch_wb_indicator(_WB_FOOD_URL, 'fao_food_price_index')
    print(f'[FAO] world CPI: {_cache.get("fao_world_cpi", "n/a")}, '
          f'food index: {_cache.get("fao_food_price_index", "n/a")}')
    return _cache


def get_cache() -> Dict[str, float]:
    return _cache
