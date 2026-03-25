"""
GeoIntel Backend — BIS Statistics Ingester
Fetches financial stability and cross-border banking data from the
Bank for International Settlements. Free, no API key required.

API docs: https://stats.bis.org/api-doc/v1/

Key datasets:
  - CBS: Consolidated Banking Statistics (cross-border exposures)
  - LBS: Locational Banking Statistics
  - DSS: Debt Securities Statistics
  - Total credit to non-financial sector (early warning for crises)
"""
import requests
import xml.etree.ElementTree as ET
from typing import Dict

BIS_URL = 'https://stats.bis.org/api/v1/data'

# Countries of interest (BIS country codes)
_COUNTRIES = {
    'US': 'United States',
    'CN': 'China',
    'RU': 'Russia',
    'TR': 'Turkey',
    'AR': 'Argentina',
    'BR': 'Brazil',
}

_cache: Dict[str, Dict] = {}

_NS = 'http://www.sdmx.org/resources/sdmxml/schemas/v2_1/data/structurespecific'


def fetch_bis() -> Dict[str, Dict]:
    """
    Fetch BIS credit-to-GDP gap data (WS_CREDIT_GAP dataset).
    BIS API returns SDMX-XML; parsed here to extract latest observations.
    """
    result: Dict[str, Dict] = {}

    try:
        r = requests.get(
            f'{BIS_URL}/WS_CREDIT_GAP',
            params={'startPeriod': '2023-Q1', 'detail': 'dataonly'},
            headers={'Accept': 'application/xml'},
            timeout=20,
        )
        r.raise_for_status()
        root = ET.fromstring(r.content)

        # BORROWERS_CTY is on Series; OBS_VALUE/TIME_PERIOD are on Obs children
        for series in root.iter():
            if not series.tag.endswith('}Series') and series.tag != 'Series':
                continue
            cty = series.get('BORROWERS_CTY', '')
            if cty not in _COUNTRIES:
                continue
            obs_list = []
            for obs in series:
                val_str = obs.get('OBS_VALUE')
                period  = obs.get('TIME_PERIOD', '')
                if val_str is not None:
                    try:
                        obs_list.append((period, float(val_str)))
                    except ValueError:
                        pass
            if obs_list:
                obs_list.sort(key=lambda x: x[0])
                period, val = obs_list[-1]
                result[cty] = {
                    'country': _COUNTRIES[cty],
                    'credit_gdp_gap': round(val, 2),
                    'period': period,
                }

    except Exception as e:
        print(f'[BIS] fetch error: {e}')

    if result:
        _cache.update(result)
    print(f'[BIS] fetched data for {len(result)} countries')
    return _cache


def get_cache() -> Dict[str, Dict]:
    return _cache
