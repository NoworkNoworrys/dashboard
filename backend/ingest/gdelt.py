"""
GeoIntel Backend — GDELT Ingester
Fetches geopolitical articles from GDELT v2 API (free, no key).
"""
import requests
from typing import List, Dict

from config import GDELT_URL, BROWSER_HEADERS
from keyword_detector import build_event


def fetch_gdelt() -> List[Dict]:
    """
    Fetch up to 20 recent geopolitical articles from GDELT v2.
    Returns a list of event dicts ready for EventStore.
    """
    try:
        resp = requests.get(GDELT_URL, headers=BROWSER_HEADERS, timeout=12)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f'[GDELT] fetch error: {e}')
        return []

    articles = data.get('articles', [])
    events = []
    for art in articles:
        title = (art.get('title') or '').strip()
        desc  = (art.get('seendescription') or art.get('socialimage') or '').strip()
        url   = art.get('url', '')
        src   = _short_source(art.get('domain', 'GDELT'))

        if not title:
            continue

        evt = build_event(
            title=title,
            desc=desc,
            source=src,
        )
        events.append(evt)

    print(f'[GDELT] fetched {len(events)} articles')
    return events


def _short_source(domain: str) -> str:
    """Turn a domain like 'reuters.com' into 'REUTERS'."""
    d = domain.lower().replace('www.', '')
    known = {
        'reuters.com':       'REUTERS',
        'bbc.com':           'BBC',
        'bbc.co.uk':         'BBC',
        'aljazeera.com':     'ALJAZ',
        'theguardian.com':   'GUARDIAN',
        'dw.com':            'DW',
        'npr.org':           'NPR',
        'apnews.com':        'AP',
        'afp.com':           'AFP',
        'thehill.com':       'HILL',
        'politico.com':      'POLITICO',
        'foreignpolicy.com': 'FP',
        'defensenews.com':   'DEFNEWS',
        'janes.com':         'JANES',
        'axios.com':         'AXIOS',
    }
    return known.get(d, d.split('.')[0].upper()[:8])
