"""
GeoIntel Backend — NASA FIRMS Fire Ingester
Detects active fires in conflict zones using NASA's Fire Information for
Resource Management System (FIRMS). Free, no API key required for
the public CSV endpoint.

API docs: https://firms.modaps.eosdis.nasa.gov/api/

Uses VIIRS S-NPP 24h active fire data (375m resolution).
Monitors conflict hotspot bounding boxes for unusual fire activity,
which can indicate:
  - Active combat / burning infrastructure
  - Scorched-earth tactics
  - Large-scale explosions
"""
import requests
import csv
import io
from typing import List, Dict

from keyword_detector import build_event
from config import NASA_FIRMS_KEY

# URL format: /api/area/csv/{MAP_KEY}/{source}/{bbox}/{day_range}
_FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv'

# Conflict hotspots: name → "west,south,east,north" bbox
_HOTSPOTS = {
    'Ukraine':         '22.0,44.0,40.0,52.5',
    'Gaza':            '34.0,31.0,35.5,31.6',
    'Sudan':           '22.0,8.0,38.0,22.0',
    'Myanmar':         '92.0,10.0,101.5,28.5',
    'Syria':           '35.5,32.5,42.5,37.5',
    'Yemen':           '42.5,12.0,54.0,19.0',
    'Sahel (Mali/Niger/Burkina)': '-5.5,10.0,16.0,20.0',
    'Ethiopia/Tigray': '33.0,3.5,48.0,15.5',
    'South China Sea': '109.0,5.0,120.0,22.0',
}

# Minimum number of fire detections to trigger an alert
_ALERT_THRESHOLD = 5


def fetch_nasa_firms() -> List[Dict]:
    """
    Fetch 24h VIIRS fire data for each conflict hotspot.
    Returns events for hotspots exceeding the alert threshold.
    """
    if not NASA_FIRMS_KEY:
        print('[NASA-FIRMS] no API key — register free at firms.modaps.eosdis.nasa.gov/api/')
        return []

    events = []
    for name, bbox in _HOTSPOTS.items():
        try:
            url = f'{_FIRMS_BASE}/{NASA_FIRMS_KEY}/VIIRS_SNPP_NRT/{bbox}/1'
            r = requests.get(url, timeout=15)
            r.raise_for_status()
            content = r.text

            if 'latitude' not in content.lower():
                continue  # empty or error response

            reader    = csv.DictReader(io.StringIO(content))
            detections = list(reader)
            count      = len(detections)

            if count >= _ALERT_THRESHOLD:
                # Compute average confidence
                confidences = []
                for row in detections:
                    conf = row.get('confidence') or row.get('conf', '')
                    if conf.isdigit():
                        confidences.append(int(conf))
                avg_conf = round(sum(confidences) / len(confidences)) if confidences else 0

                title = (
                    f'NASA FIRMS: {count} active fire detections in {name}'
                    + (f' (avg confidence {avg_conf}%)' if avg_conf else '')
                )
                desc = f'VIIRS S-NPP satellite detected {count} active fires in {name} in the past 24 hours.'
                evt = build_event(title=title, desc=desc, source='NASA-FIRMS')
                events.append(evt)

        except Exception as e:
            print(f'[NASA-FIRMS] {name} error: {e}')

    print(f'[NASA-FIRMS] {len(events)} hotspot alerts from {len(_HOTSPOTS)} regions')
    return events
