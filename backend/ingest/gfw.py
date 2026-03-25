"""
GeoIntel Backend — Global Forest Watch Ingester
Tracks deforestation alerts and forest cover loss — relevant to
commodity markets, environmental treaties, and land-use conflicts.

Source: Global Forest Watch API (free key — register at globalforestwatch.org)
Set env var: GFW_KEY

Key metrics:
  - Tree cover loss alerts (GLAD/RADD)
  - Burned area alerts
  - Top deforestation countries

Refreshed every 6h alongside macro data.
"""
import requests
from typing import List, Dict

from config import GFW_KEY
from keyword_detector import build_event

_BASE = 'https://data-api.globalforestwatch.org'

_cache: Dict[str, float] = {}


def fetch_gfw() -> List[Dict]:
    """
    Fetch forest loss alerts from Global Forest Watch.
    Returns events for significant deforestation activity.
    Returns [] if GFW_KEY not configured.
    """
    if not GFW_KEY:
        return []

    events = []
    try:
        # Fetch global tree cover loss summary (latest available year)
        r = requests.get(
            f'{_BASE}/dataset/gfw_integrated_alerts/latest/query',
            params={
                'sql': (
                    'SELECT SUM(alert__count) as total_alerts '
                    'FROM results '
                    'WHERE alert__date >= current_date - 30'
                ),
            },
            headers={'x-api-key': GFW_KEY},
            timeout=20,
        )
        r.raise_for_status()
        data = r.json().get('data', [])
        if data:
            total = data[0].get('total_alerts', 0)
            _cache['gfw_alerts_30d'] = float(total or 0)
            if total and total > 10000:
                evt = build_event(
                    title=f'GFW: {int(total):,} deforestation alerts in last 30 days',
                    desc=f'Global Forest Watch integrated alerts: {int(total):,} tree cover loss alerts detected.',
                    source='GFW',
                )
                events.append(evt)

        print(f'[GFW] {_cache.get("gfw_alerts_30d", 0):.0f} alerts (30d), {len(events)} events')
    except Exception as e:
        print(f'[GFW] error: {e}')

    return events


def get_cache() -> Dict[str, float]:
    return _cache
