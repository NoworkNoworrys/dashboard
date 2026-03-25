"""
GeoIntel Backend — International Crisis Group (ICG) Crisis Watch Ingester
Fetches ICG's authoritative monthly conflict ratings and alerts.

Source: ICG CrisisWatch RSS (no key required)
  https://www.crisisgroup.org/crisiswatch

CrisisWatch rates every country monthly:
  - Deteriorated / Improved / No change / Crisis
  - Highly respected, used by governments and institutions worldwide

Refreshed every cycle (new entries appear when ICG publishes updates).
"""
import requests
import xml.etree.ElementTree as ET
from typing import List, Dict

from keyword_detector import build_event

_RSS_URLS = [
    'https://www.crisisgroup.org/rss.xml',
    'https://www.crisisgroup.org/crisiswatch/rss.xml',
]

_seen_ids: set = set()

_HIGH_PRIORITY = [
    'deteriorat', 'escalat', 'coup', 'war', 'conflict', 'crisis',
    'ceasefire', 'attack', 'offensive', 'invasion', 'sanction',
    'nuclear', 'missile', 'airstrike', 'troops',
]


def fetch_icg() -> List[Dict]:
    """
    Fetch ICG CrisisWatch and analysis RSS feeds.
    Returns events for conflict deteriorations and major alerts.
    """
    events = []

    for url in _RSS_URLS:
        try:
            r = requests.get(
                url,
                timeout=15,
                headers={'User-Agent': 'GeoDash/1.0', 'Accept': 'application/rss+xml, */*'},
            )
            r.raise_for_status()
            root = ET.fromstring(r.content)

            for item in root.findall('.//item'):
                title_el = item.find('title')
                desc_el  = item.find('description')
                link_el  = item.find('link')

                if title_el is None or not title_el.text:
                    continue

                link  = link_el.text if link_el is not None else ''
                if link in _seen_ids:
                    continue

                title = title_el.text.strip()
                desc  = (desc_el.text or '').strip() if desc_el is not None else ''

                combined = (title + ' ' + desc).lower()
                is_priority = any(kw in combined for kw in _HIGH_PRIORITY)

                # Skip low-relevance items
                if not is_priority:
                    continue

                evt = build_event(
                    title=f'ICG: {title}',
                    desc=desc[:300] if desc else title,
                    source='ICG',
                )
                # CrisisWatch deteriorations get a signal boost
                if 'deteriorat' in combined or 'crisis' in combined:
                    evt['signal'] = min(100, evt.get('signal', 50) + 15)

                events.append(evt)
                _seen_ids.add(link)

        except Exception as e:
            print(f'[ICG] {url} error: {e}')

    # Cap seen set
    if len(_seen_ids) > 1000:
        for k in list(_seen_ids)[:200]:
            _seen_ids.discard(k)

    print(f'[ICG] {len(events)} conflict watch events')
    return events
