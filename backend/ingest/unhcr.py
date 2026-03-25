"""
GeoIntel Backend — UNHCR Refugee Statistics Ingester
Fetches global forcibly displaced populations data from UNHCR.

Source: UNHCR Refugee Data Finder API (no key required)
  https://api.unhcr.org/population/v1/

Refreshed every 6h alongside macro data.
Used to signal humanitarian crises and displacement events.
"""
import requests
from typing import List, Dict

from keyword_detector import build_event

_BASE = 'https://api.unhcr.org/population/v1/population'

_cache: Dict[str, float] = {}


def fetch_unhcr() -> List[Dict]:
    """
    Fetch latest global displacement totals.
    Returns event dicts for significant changes. Caches summary stats.
    """
    events = []
    try:
        # Global population totals
        r = requests.get(
            'https://api.unhcr.org/population/v1/population/',
            params={'year': '2023', 'limit': '1', 'yearFrom': '2023'},
            timeout=15,
        )
        r.raise_for_status()
        items = r.json().get('items', [])
        if items:
            row = items[0]
            total_displaced = row.get('forciblyDisplaced', 0) or 0
            refugees = row.get('refugees', 0) or 0
            idps = row.get('idps', 0) or 0
            year = row.get('year', '')
            _cache.update({
                'unhcr_total_displaced_m': round(float(total_displaced) / 1e6, 2),
                'unhcr_refugees_m':        round(float(refugees) / 1e6, 2),
                'unhcr_idps_m':            round(float(idps) / 1e6, 2),
                'unhcr_year':              float(year) if year else 0,
            })
            print(f'[UNHCR] {year}: {total_displaced:,} displaced, {refugees:,} refugees')
    except Exception as e:
        print(f'[UNHCR] overview error: {e}')

    # Check for recent emergency situations via UNHCR data portal
    try:
        r2 = requests.get(
            'https://api.unhcr.org/population/v1/population/',
            params={'limit': '5', 'coa_all': 'true'},
            timeout=15,
        )
        r2.raise_for_status()
        situations = r2.json().get('items', [])
        for s in situations[:3]:
            name = s.get('name', '')
            total = s.get('total', 0)
            if name and total:
                title = f'UNHCR: {name} — {int(total):,} displaced'
                evt = build_event(
                    title=title,
                    desc=f'UNHCR emergency situation: {name}',
                    source='UNHCR',
                )
                events.append(evt)
    except Exception as e:
        print(f'[UNHCR] situations error: {e}')

    return events


def get_cache() -> Dict[str, float]:
    return _cache
