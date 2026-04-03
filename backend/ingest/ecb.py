"""
GeoIntel Backend — ECB Data Warehouse Ingester
Fetches key European Central Bank monetary and financial statistics.

Source: ECB Statistical Data Warehouse REST API (no key required)
  https://data-api.ecb.europa.eu/

Key series tracked:
  - EUR/USD exchange rate
  - ECB main refinancing rate
  - Euro area inflation (HICP)
  - Euro area M3 money supply growth
  - 10Y German Bund yield

Refreshed every 6h alongside macro data.
"""
import requests
from typing import Dict

_BASE = 'https://data-api.ecb.europa.eu/service/data'

# flowRef/key → friendly label
_SERIES = {
    ('EXR', 'D.USD.EUR.SP00.A'):                    'eur_usd',
    ('FM',  'B.U2.EUR.4F.KR.DFR.LEV'):               'ecb_main_rate',
    ('ICP', 'M.U2.N.000000.4.ANR'):                  'euro_hicp_yoy',
    ('BSI', 'M.U2.Y.V.M30.X.I.U2.2300.Z01.A'):      'm3_growth',
    ('YC',  'B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y'):    'de_bund_10y',
}

_cache: Dict[str, float] = {}


def _fetch_series(flow_ref: str, key: str, label: str) -> None:
    try:
        url = f'{_BASE}/{flow_ref}/{key}'
        r = requests.get(
            url,
            params={
                'format': 'jsondata',
                'lastNObservations': '1',
                'detail': 'dataonly',
            },
            headers={'Accept': 'application/json'},
            timeout=15,
        )
        r.raise_for_status()
        body = r.json()
        # Navigate the SDMX-JSON structure
        datasets = body.get('dataSets', [])
        if not datasets:
            return
        series = datasets[0].get('series', {})
        if not series:
            return
        # First series, last observation
        first_series = next(iter(series.values()))
        obs = first_series.get('observations', {})
        if not obs:
            return
        last_val = list(obs.values())[-1][0]
        if last_val is not None:
            _cache[label] = round(float(last_val), 4)
    except Exception as e:
        print(f'[ECB] {label} error: {e}')


def fetch_ecb() -> Dict[str, float]:
    """Fetch latest ECB data for all tracked series."""
    for (flow_ref, key), label in _SERIES.items():
        _fetch_series(flow_ref, key, label)
    print(f'[ECB] fetched {len(_cache)}/{len(_SERIES)} series')
    return _cache


def get_cache() -> Dict[str, float]:
    return _cache
