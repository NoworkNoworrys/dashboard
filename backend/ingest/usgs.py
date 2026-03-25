"""
GeoIntel Backend — USGS Earthquake Ingester
Fetches real-time earthquake data from the USGS Earthquake Hazards Program.

Source: USGS GeoJSON Feed (no key required)
  https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php

Geopolitically significant earthquakes:
  - Near nuclear power plants or weapons sites
  - Near active conflict zones
  - Large (M5.0+) quakes anywhere — destabilise governments, affect supply chains

Refreshed every cycle.
"""
import requests
from typing import List, Dict

from keyword_detector import build_event

_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson'
_URL_M4 = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson'

# Geopolitically sensitive regions [name, min_lon, min_lat, max_lon, max_lat]
_SENSITIVE_ZONES = [
    ('Iran nuclear sites',     44.0, 28.0, 60.0, 38.0),
    ('North Korea',            124.0, 37.5, 130.5, 42.5),
    ('Pakistan nuclear',       66.0, 24.0, 77.0, 36.0),
    ('Ukraine conflict zone',  28.0, 44.0, 40.0, 52.5),
    ('Taiwan Strait',          118.0, 21.0, 122.5, 26.0),
    ('Middle East',            34.0, 28.0, 56.0, 38.0),
    ('Japan (Fukushima area)', 139.0, 36.0, 142.0, 38.5),
]

_seen_ids: set = set()


def _in_zone(lon: float, lat: float) -> str:
    for name, min_lon, min_lat, max_lon, max_lat in _SENSITIVE_ZONES:
        if min_lon <= lon <= max_lon and min_lat <= lat <= max_lat:
            return name
    return ''


def fetch_usgs() -> List[Dict]:
    """
    Fetch significant and M4.5+ earthquakes, flagging those near sensitive zones.
    Returns event dicts for geopolitically relevant seismic activity.
    """
    events = []

    for url, label in [(_URL, 'significant'), (_URL_M4, 'M4.5+')]:
        try:
            r = requests.get(url, timeout=12)
            r.raise_for_status()
            features = r.json().get('features', [])

            for f in features:
                fid = f.get('id', '')
                if fid in _seen_ids:
                    continue

                props = f.get('properties', {})
                mag = props.get('mag', 0) or 0
                place = props.get('place', 'Unknown location')
                coords = f.get('geometry', {}).get('coordinates', [])

                if len(coords) < 2:
                    continue

                lon, lat = coords[0], coords[1]
                zone = _in_zone(lon, lat)

                # Only surface: significant feed always, M4.5+ only if in sensitive zone or M6+
                if label == 'M4.5+' and not zone and mag < 6.0:
                    continue

                title = f'USGS M{mag:.1f} earthquake: {place}'
                desc = f'Magnitude {mag:.1f} earthquake near {place}'
                if zone:
                    title += f' [near {zone}]'
                    desc += f' — geopolitically sensitive zone: {zone}'

                evt = build_event(title=title, desc=desc, source='USGS')

                # Boost signal for sensitive zones or large quakes
                if zone:
                    evt['signal'] = min(100, evt.get('signal', 50) + 25)
                if mag >= 7.0:
                    evt['signal'] = min(100, evt.get('signal', 50) + 20)

                events.append(evt)
                _seen_ids.add(fid)

        except Exception as e:
            print(f'[USGS] {label} error: {e}')

    # Cap seen set
    if len(_seen_ids) > 2000:
        for k in list(_seen_ids)[:400]:
            _seen_ids.discard(k)

    print(f'[USGS] {len(events)} seismic events')
    return events
