"""
GeoIntel Backend — GDACS Natural Disaster Alert Ingester
Fetches alerts from the Global Disaster Alert and Coordination System.

Source: GDACS RSS/GeoRSS Feed (no key required)
  https://www.gdacs.org/

Alert types: earthquakes, floods, cyclones, volcanoes, droughts, wildfires.
Red/Orange alerts = market-moving events (commodity disruption, refugee flows).

Refreshed every cycle.
"""
import requests
import xml.etree.ElementTree as ET
from typing import List, Dict

from keyword_detector import build_event

_RSS_URL = 'https://www.gdacs.org/xml/rss.xml'

# GDACS alert level colours → signal boost
_ALERT_BOOST = {'red': 35, 'orange': 20, 'green': 0}

_seen_ids: set = set()


def fetch_gdacs() -> List[Dict]:
    """
    Fetch GDACS disaster alerts.
    Red/orange alerts get signal boost; green alerts only surfaced if geopolitically relevant.
    """
    events = []
    try:
        r = requests.get(
            _RSS_URL,
            timeout=15,
            headers={'User-Agent': 'GeoDash/1.0', 'Accept': 'application/rss+xml, */*'},
        )
        r.raise_for_status()

        # GDACS uses gdacs: namespace
        ns = {
            'gdacs': 'http://www.gdacs.org',
            'geo':   'http://www.w3.org/2003/01/geo/wgs84_pos#',
        }
        root = ET.fromstring(r.content)

        for item in root.findall('.//item'):
            title_el = item.find('title')
            desc_el  = item.find('description')
            guid_el  = item.find('guid')

            if title_el is None or not title_el.text:
                continue

            guid  = guid_el.text if guid_el is not None else title_el.text
            if guid in _seen_ids:
                continue

            title = title_el.text.strip()
            desc  = (desc_el.text or '').strip() if desc_el is not None else ''

            # Extract alert level from gdacs namespace
            alert_el = item.find('gdacs:alertlevel', ns)
            alert_level = (alert_el.text or 'green').lower().strip() if alert_el is not None else 'green'

            # Skip green alerts unless they mention geopolitically sensitive areas
            geo_keywords = ['iran', 'russia', 'ukraine', 'taiwan', 'north korea',
                            'pakistan', 'india', 'israel', 'myanmar', 'syria']
            combined = (title + ' ' + desc).lower()
            if alert_level == 'green' and not any(k in combined for k in geo_keywords):
                continue

            evt = build_event(
                title=f'GDACS {alert_level.upper()}: {title}',
                desc=desc or title,
                source='GDACS',
            )
            boost = _ALERT_BOOST.get(alert_level, 0)
            if boost:
                evt['signal'] = min(100, evt.get('signal', 50) + boost)

            events.append(evt)
            _seen_ids.add(guid)

        # Cap seen set
        if len(_seen_ids) > 1000:
            for k in list(_seen_ids)[:200]:
                _seen_ids.discard(k)

        print(f'[GDACS] {len(events)} disaster alerts')
    except Exception as e:
        print(f'[GDACS] error: {e}')

    return events
