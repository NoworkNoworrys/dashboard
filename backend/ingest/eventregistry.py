"""
GeoIntel Backend — EventRegistry Ingester
Fetches categorised news events from eventregistry.org.
Free tier available — register at eventregistry.org to get a key.

Set env var: EVENTREGISTRY_KEY
"""
import requests
from typing import List, Dict

from config import EVENTREGISTRY_KEY
from keyword_detector import build_event

ER_URL = 'https://eventregistry.org/api/v1/article/getArticles'

_CONCEPTS = [
    'http://en.wikipedia.org/wiki/War',
    'http://en.wikipedia.org/wiki/Military',
    'http://en.wikipedia.org/wiki/Sanctions',
    'http://en.wikipedia.org/wiki/Nuclear_weapon',
    'http://en.wikipedia.org/wiki/Geopolitics',
]


def fetch_eventregistry() -> List[Dict]:
    """
    Fetch recent geopolitical articles from EventRegistry.
    Returns [] if no API key is configured.
    """
    if not EVENTREGISTRY_KEY:
        return []

    try:
        r = requests.post(
            ER_URL,
            json={
                'apiKey':           EVENTREGISTRY_KEY,
                'conceptUri':       _CONCEPTS,
                'lang':             'eng',
                'articlesCount':    30,
                'articlesSortBy':   'date',
                'articlesSortByAsc': False,
                'dataType':         ['news'],
                'resultType':       'articles',
                'includeArticleTitle':   True,
                'includeArticleBody':    True,
                'articleBodyLen':        300,
                'includeSourceTitle':    True,
            },
            timeout=15,
        )
        r.raise_for_status()
        articles = r.json().get('articles', {}).get('results', [])
    except Exception as e:
        print(f'[EVENTREG] fetch error: {e}')
        return []

    events = []
    for art in articles:
        title  = (art.get('title') or '').strip()
        body   = (art.get('body') or '')[:300].strip()
        source = (art.get('source', {}).get('title') or 'EVENTREG').upper()[:8]

        if not title:
            continue

        evt = build_event(title=title, desc=body, source=source)
        events.append(evt)

    print(f'[EVENTREG] fetched {len(events)} articles')
    return events
