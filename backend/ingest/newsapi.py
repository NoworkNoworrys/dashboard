"""
GeoIntel Backend — NewsAPI Ingester
Fetches near real-time news articles from newsapi.org.
Free tier: 100 requests/day, headlines only for production domains.

Set env var: NEWS_API_KEY  (get free key at newsapi.org)
"""
import time
import requests
from typing import List, Dict

from config import NEWS_API_KEY
from keyword_detector import build_event

# Cache — NewsAPI free tier = 100 req/day. Cache for 30 min to stay within limit.
_cache: List[Dict] = []
_last_fetch: float = 0.0
_CACHE_TTL = 1800  # 30 minutes

_HEADLINES_URL  = 'https://newsapi.org/v2/top-headlines'
_EVERYTHING_URL = 'https://newsapi.org/v2/everything'

_QUERY = (
    'war OR conflict OR sanctions OR nuclear OR missile OR troops '
    'OR invasion OR airstrike OR military OR coup OR protest OR ceasefire '
    'OR NATO OR geopolitical'
)

# Top-headline categories that catch geopolitical stories
_HEADLINE_PARAMS = [
    {'category': 'general',  'language': 'en'},
    {'category': 'politics', 'language': 'en'},
]


def fetch_newsapi() -> List[Dict]:
    """
    Fetch top geopolitical news articles from NewsAPI.
    Uses top-headlines (fewer restrictions on free tier) with /everything as fallback.
    Returns [] if no API key is configured.
    Cached for 30 minutes — free tier is 100 req/day.
    """
    global _cache, _last_fetch
    if not NEWS_API_KEY:
        return []

    if _cache and (time.time() - _last_fetch) < _CACHE_TTL:
        print(f'[NEWSAPI] serving cache ({len(_cache)} articles)')
        return _cache

    articles = []

    # Try top-headlines first (works on free tier without domain restrictions)
    for params in _HEADLINE_PARAMS:
        try:
            r = requests.get(
                _HEADLINES_URL,
                params={**params, 'apiKey': NEWS_API_KEY, 'pageSize': 20},
                timeout=12,
            )
            if r.status_code == 200:
                articles.extend(r.json().get('articles', []))
        except Exception as e:
            print(f'[NEWSAPI] headlines error: {e}')

    # Fallback: /everything with keyword query (developer environments only)
    if not articles:
        try:
            r = requests.get(
                _EVERYTHING_URL,
                params={
                    'apiKey':   NEWS_API_KEY,
                    'q':        _QUERY,
                    'language': 'en',
                    'sortBy':   'publishedAt',
                    'pageSize': 30,
                },
                timeout=12,
            )
            if r.status_code == 200:
                articles.extend(r.json().get('articles', []))
            else:
                print(f'[NEWSAPI] /everything error {r.status_code}: {r.text[:100]}')
        except Exception as e:
            print(f'[NEWSAPI] fetch error: {e}')

    events = []
    seen_titles = set()
    for art in articles:
        title  = (art.get('title') or '').strip()
        desc   = (art.get('description') or '')[:300].strip()
        source = (art.get('source', {}).get('name') or 'NEWSAPI').upper()[:8]

        if not title or title == '[Removed]' or title in seen_titles:
            continue
        seen_titles.add(title)

        evt = build_event(title=title, desc=desc, source=source)
        events.append(evt)

    print(f'[NEWSAPI] fetched {len(events)} articles')
    if events:
        _cache      = events
        _last_fetch = time.time()
    return events
