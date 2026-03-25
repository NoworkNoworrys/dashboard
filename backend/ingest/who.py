"""
GeoIntel Backend — WHO Disease Outbreak Ingester
Fetches disease outbreak alerts from the World Health Organization.
Free, no API key required.

Sources:
  - WHO Disease Outbreak News (DON) RSS feed
  - WHO Emergency RSS feed
"""
import feedparser
from typing import List, Dict

from keyword_detector import build_event

_FEEDS = [
    ('https://www.who.int/rss-feeds/news-english.xml',           'WHO'),
    ('https://www.who.int/feeds/entity/csr/don/en/rss.xml',      'WHO-DON'),
    ('https://www.who.int/feeds/entity/emergencies/en/rss.xml',  'WHO-EMRG'),
]

_BIO_KEYWORDS = {
    'outbreak', 'epidemic', 'pandemic', 'disease', 'virus', 'pathogen',
    'ebola', 'cholera', 'plague', 'mpox', 'monkeypox', 'avian flu',
    'h5n1', 'h1n1', 'coronavirus', 'dengue', 'malaria', 'yellow fever',
    'hemorrhagic', 'quarantine', 'public health emergency',
}


def fetch_who() -> List[Dict]:
    """
    Fetch WHO disease outbreak and emergency news.
    Filters for biological risk / outbreak content.
    """
    events = []
    for url, source in _FEEDS:
        try:
            feed = feedparser.parse(url)
            if feed.bozo and not feed.entries:
                continue
            for entry in feed.entries[:15]:
                title = (getattr(entry, 'title', '') or '').strip()
                desc  = (getattr(entry, 'summary', '') or getattr(entry, 'description', '') or '')[:300].strip()
                combined = (title + ' ' + desc).lower()

                if not any(kw in combined for kw in _BIO_KEYWORDS):
                    continue

                evt = build_event(title=title, desc=desc, source=source)
                events.append(evt)
        except Exception as e:
            print(f'[WHO] {source} error: {e}')

    print(f'[WHO] {len(events)} outbreak/emergency items')
    return events
