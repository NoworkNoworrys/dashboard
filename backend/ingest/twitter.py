"""
GeoIntel Backend — Twitter/X API Ingester
Fetches recent tweets matching geopolitical search terms using the
Twitter API v2 (free Basic tier: ~500k tweets/month read).

Register at: https://developer.twitter.com
Set env var: TWITTER_BEARER  (Bearer Token from your app)
"""
import requests
from typing import List, Dict

from config import TWITTER_BEARER
from keyword_detector import build_event

_SEARCH_URL = 'https://api.twitter.com/2/tweets/search/recent'

_QUERY = (
    '(war OR invasion OR airstrike OR "military strike" OR sanctions OR '
    '"nuclear weapon" OR "coup" OR "missile" OR "troops deployed") '
    'lang:en -is:retweet'
)


def fetch_twitter() -> List[Dict]:
    """
    Fetch recent tweets matching geopolitical keywords.
    Returns [] if no Bearer Token is configured.
    """
    if not TWITTER_BEARER:
        return []

    try:
        r = requests.get(
            _SEARCH_URL,
            headers={'Authorization': f'Bearer {TWITTER_BEARER}'},
            params={
                'query':        _QUERY,
                'max_results':  20,
                'tweet.fields': 'created_at,public_metrics,author_id',
                'expansions':   'author_id',
                'user.fields':  'name,username,verified',
            },
            timeout=12,
        )
        if r.status_code == 429:
            print('[TWITTER] rate limited — skipping')
            return []
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        print(f'[TWITTER] fetch error: {e}')
        return []

    tweets  = data.get('data', [])
    users   = {u['id']: u for u in data.get('includes', {}).get('users', [])}

    events = []
    for tweet in tweets:
        text    = (tweet.get('text') or '').strip()
        metrics = tweet.get('public_metrics', {})
        likes   = metrics.get('like_count', 0)
        rts     = metrics.get('retweet_count', 0)
        user    = users.get(tweet.get('author_id', ''), {})
        handle  = user.get('username', 'unknown')
        verified = user.get('verified', False)

        if not text:
            continue

        # Weight: verified accounts and high-engagement tweets get higher social_v
        import math
        engagement = likes + rts * 2
        social_v   = min(1.0, math.log10(engagement + 1) / 4.0) if engagement > 0 else 0.0
        if verified:
            social_v = min(1.0, social_v + 0.2)

        evt = build_event(
            title=f'@{handle}: {text[:200]}',
            desc=text,
            source='TWITTER',
            social_v=social_v,
        )
        events.append(evt)

    print(f'[TWITTER] fetched {len(events)} tweets')
    return events
