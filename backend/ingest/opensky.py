"""
GeoIntel Backend — OpenSky Network Flight Tracker
Monitors aircraft movements over geopolitical hotspots using the OpenSky Network.

Source: OpenSky Network REST API (no key required for anonymous access)
  https://opensky-network.org/apidoc/

Tracks:
  - Military/government callsign patterns over conflict zones
  - Unusual flight activity near nuclear sites, ports, border regions
  - Large cargo or surveillance aircraft patterns

Anonymous access: 400 requests/day, 10s resolution data.
Refreshed every 5 cycles (~5 min) to stay within rate limits.
"""
import requests
from typing import List, Dict

from keyword_detector import build_event

_BASE = 'https://opensky-network.org/api'

# Hotspot bounding boxes [min_lat, max_lat, min_lon, max_lon]
_HOTSPOTS = [
    ('Ukraine/Russia border', 44.0, 52.5, 28.0, 40.0),
    ('Taiwan Strait',         21.0, 26.0, 118.0, 122.5),
    ('Korean Peninsula',      37.0, 42.5, 124.0, 130.5),
    ('Strait of Hormuz',      22.0, 28.0, 54.0, 58.0),
    ('South China Sea',        9.0, 22.0, 109.0, 120.0),
    ('Eastern Mediterranean', 30.0, 38.0, 28.0, 38.0),
]

# Callsign prefixes associated with military/government operators
_MIL_PREFIXES = (
    'RRR', 'RFF', 'USAF', 'UKAF', 'NATO', 'LAGR', 'JAKE',
    'REACH', 'SPAR', 'VENUS', 'ROCKY', 'PRICE', 'IRON',
    'DUKE', 'KNIFE', 'BLADE', 'HAWK', 'EAGLE', 'VIPER',
)

_seen: set = set()
_cache: List[Dict] = []


def get_cache() -> List[Dict]:
    """Return the last set of OpenSky flight events (populated by fetch_opensky)."""
    return _cache


def fetch_opensky() -> List[Dict]:
    """
    Poll OpenSky for aircraft over geopolitical hotspots.
    Flags military callsigns and unusual high-density traffic.
    """
    events = []

    for name, min_lat, max_lat, min_lon, max_lon in _HOTSPOTS:
        try:
            r = requests.get(
                f'{_BASE}/states/all',
                params={
                    'lamin': min_lat, 'lamax': max_lat,
                    'lomin': min_lon, 'lomax': max_lon,
                },
                timeout=15,
            )
            r.raise_for_status()
            states = r.json().get('states', []) or []

            mil_aircraft = []
            for s in states:
                if not s or len(s) < 8:
                    continue
                callsign = (s[1] or '').strip().upper()
                if any(callsign.startswith(p) for p in _MIL_PREFIXES):
                    mil_aircraft.append(callsign)

            total = len(states)

            # Surface: military callsigns OR unusually high traffic (>30 aircraft)
            if mil_aircraft:
                key = f'opensky_{name}_{",".join(sorted(mil_aircraft)[:3])}'
                if key not in _seen:
                    title = f'OpenSky: Military aircraft over {name} — {", ".join(mil_aircraft[:3])}'
                    evt = build_event(
                        title=title,
                        desc=f'{len(mil_aircraft)} military callsign(s) detected over {name}: {", ".join(mil_aircraft[:5])}',
                        source='OPENSKY',
                    )
                    evt['signal'] = min(100, evt.get('signal', 50) + 20)
                    events.append(evt)
                    _seen.add(key)

            elif total > 30:
                key = f'opensky_{name}_high_{total // 10}'
                if key not in _seen:
                    title = f'OpenSky: High air traffic over {name} — {total} aircraft'
                    evt = build_event(
                        title=title,
                        desc=f'Elevated aircraft density ({total} tracked) over {name}',
                        source='OPENSKY',
                    )
                    events.append(evt)
                    _seen.add(key)

        except Exception as e:
            print(f'[OPENSKY] {name} error: {e}')

    # Cap seen set
    if len(_seen) > 500:
        for k in list(_seen)[:100]:
            _seen.discard(k)

    global _cache
    _cache = events
    print(f'[OPENSKY] {len(events)} flight events')
    return events
