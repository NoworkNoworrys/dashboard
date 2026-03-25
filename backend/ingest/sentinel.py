"""
GeoIntel Backend — Planet Insights Platform Satellite Ingester
Queries Planet's API for recent satellite imagery over geopolitical hotspots.
Detects new passes over conflict zones, military sites, and chokepoints.

Free trial at: insights.planet.com
Set env var: PLANET_API_KEY

API docs: https://developers.planet.com/docs/apis/data/
"""
import requests
from datetime import datetime, timedelta
from typing import List, Dict

from config import PLANET_API_KEY
from keyword_detector import build_event

_SEARCH_URL = 'https://api.planet.com/data/v1/quick-search'

# Geopolitical hotspot bounding boxes [west, south, east, north]
_HOTSPOTS = [
    ('Ukraine frontline',   [30.0, 47.0, 40.0, 52.0]),
    ('Gaza / Israel',       [34.0, 31.0, 35.5, 32.0]),
    ('Taiwan Strait',       [119.0, 22.0, 122.5, 25.5]),
    ('Korean Peninsula',    [124.0, 37.0, 130.0, 38.5]),
    ('Strait of Hormuz',    [55.0, 25.5, 57.5, 27.0]),
    ('South China Sea',     [109.0, 9.0, 118.0, 16.0]),
]


def fetch_sentinel() -> List[Dict]:
    """
    Query Planet API for recent imagery over hotspots.
    Returns event dicts for hotspots with new imagery in last 24h.
    Returns [] if PLANET_API_KEY not configured.
    """
    if not PLANET_API_KEY:
        return []

    since = (datetime.utcnow() - timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%SZ')
    auth = (PLANET_API_KEY, '')
    events = []

    for name, bbox in _HOTSPOTS:
        west, south, east, north = bbox
        try:
            payload = {
                'item_types': ['PSScene', 'SkySatCollect'],
                'filter': {
                    'type': 'AndFilter',
                    'config': [
                        {
                            'type': 'GeometryFilter',
                            'field_name': 'geometry',
                            'config': {
                                'type': 'Polygon',
                                'coordinates': [[
                                    [west, south], [east, south],
                                    [east, north], [west, north],
                                    [west, south],
                                ]],
                            },
                        },
                        {
                            'type': 'DateRangeFilter',
                            'field_name': 'acquired',
                            'config': {'gte': since},
                        },
                    ],
                },
            }
            r = requests.post(
                _SEARCH_URL,
                json=payload,
                auth=auth,
                timeout=12,
            )
            r.raise_for_status()
            features = r.json().get('features', [])
            if features:
                count = len(features)
                title = f"Planet satellite: {name} — {count} new image{'s' if count > 1 else ''}"
                evt = build_event(
                    title=title,
                    desc=f'Planet satellite imagery acquired over {name} in last 24h',
                    source='SENTINEL',
                )
                events.append(evt)
        except Exception as e:
            print(f'[SENTINEL] {name} error: {e}')

    print(f'[SENTINEL] {len(events)} hotspot(s) with new Planet imagery')
    return events
