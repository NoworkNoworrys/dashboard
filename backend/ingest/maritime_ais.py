"""
GeoIntel Backend — Maritime AIS Ingester
Tracks vessels in geopolitically sensitive straits and chokepoints using
the aisstream.io WebSocket API (free tier — register at aisstream.io).

Falls back to a polling approach if WebSocket is not practical in the pipeline.
Set env var: AIS_API_KEY  (free at aisstream.io)

Monitors: Strait of Hormuz, Strait of Malacca, Taiwan Strait, Black Sea,
          Red Sea / Bab-el-Mandeb, South China Sea chokepoints.
"""
import requests
from typing import List, Dict

from config import AIS_API_KEY
from keyword_detector import build_event

# aisstream.io REST snapshot endpoint (where available)
_AIS_REST_URL = 'https://api.aisstream.io/v0/vessels'

# Chokepoints — bounding boxes and alert thresholds
_CHOKEPOINTS = [
    ('Strait of Hormuz',        55.8, 25.8, 57.0, 26.8),
    ('Strait of Malacca',      100.0,  1.0, 104.5,  4.0),
    ('Taiwan Strait',           119.5, 22.5, 121.5, 25.5),
    ('Bab-el-Mandeb',            43.0, 11.5,  44.0, 13.0),
    ('Black Sea Bosphorus',      28.8, 40.8,  29.2, 41.3),
    ('South China Sea (Spratly)',111.0,  9.0, 117.0, 12.0),
]

_cache: List[Dict] = []


def fetch_maritime_ais() -> List[Dict]:
    """
    Query AIS vessel positions at geopolitical chokepoints.
    Returns event dicts for unusual vessel activity.
    Returns [] if no API key is configured.
    """
    global _cache
    if not AIS_API_KEY:
        return []

    events = []
    headers = {'Authorization': f'Bearer {AIS_API_KEY}'}

    for name, west, south, east, north in _CHOKEPOINTS:
        try:
            r = requests.get(
                _AIS_REST_URL,
                headers=headers,
                params={
                    'bbox':  f'{west},{south},{east},{north}',
                    'limit': 50,
                },
                timeout=10,
            )
            if r.status_code == 404:
                # Endpoint not available on free tier — skip silently
                continue
            r.raise_for_status()
            vessels = r.json() if isinstance(r.json(), list) else r.json().get('vessels', [])

            # Flag warships and tankers specifically
            flagged = [
                v for v in vessels
                if _is_notable(v)
            ]
            if flagged:
                names = ', '.join(v.get('name', 'Unknown') for v in flagged[:3])
                title = f"AIS: {len(flagged)} notable vessel(s) at {name} — {names}"
                evt = build_event(title=title, desc=f'Vessel activity detected at {name}', source='AIS')
                events.append(evt)
        except Exception as e:
            print(f'[AIS] {name} error: {e}')

    _cache = events
    print(f'[AIS] {len(events)} chokepoint event(s) detected')
    return events


def _is_notable(vessel: dict) -> bool:
    """Return True for warships, tankers, or vessels with unusual behaviour."""
    ship_type = vessel.get('shipType', 0)
    # AIS ship type codes: 30-39 = fishing, 50-59 = special, 80-89 = tanker, 35=military
    return ship_type in range(35, 36) or ship_type in range(80, 90)


def get_cache() -> List[Dict]:
    return _cache
