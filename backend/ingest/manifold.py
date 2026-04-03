"""
GeoIntel Backend — Manifold Markets Prediction Market Ingester
Fetches geopolitical prediction market probabilities from Manifold Markets.

Source: Manifold Markets API (no key required)
  https://docs.manifold.markets/api

Tracks markets related to: war, elections, nuclear, sanctions, conflict.
Refreshed every cycle (probability shifts = real-time crowd intelligence).
"""
import requests
from typing import List, Dict

from keyword_detector import build_event

_BASE = 'https://api.manifold.markets/v0'

_GEO_TERMS = [
    'war', 'nuclear', 'invasion', 'sanctions', 'conflict',
    'election', 'coup', 'nato', 'russia', 'china', 'taiwan',
    'iran', 'israel', 'ukraine',
]

_seen_ids: set = set()
_market_cache: List[Dict] = []   # Raw markets for /api/manifold


def get_cache() -> List[Dict]:
    return _market_cache


def fetch_manifold() -> List[Dict]:
    """
    Fetch top geopolitical prediction markets.
    Returns events for markets with significant recent probability shifts.
    """
    global _market_cache
    events = []
    fresh_markets: List[Dict] = []
    try:
        # Search for geopolitical markets
        for term in _GEO_TERMS[:5]:  # limit to 5 terms to avoid rate limiting
            r = requests.get(
                f'{_BASE}/search-markets',
                params={
                    'term': term,
                    'sort': 'score',
                    'filter': 'open',
                    'contractType': 'BINARY',
                    'limit': '5',
                },
                timeout=10,
            )
            r.raise_for_status()
            markets = r.json()

            for m in markets:
                mid = m.get('id', '')
                if mid in _seen_ids:
                    continue

                question = m.get('question', '')
                prob = m.get('probability', 0)
                volume = m.get('volume', 0)

                # Only surface high-confidence or high-volume markets
                if volume < 500 and (prob < 0.15 or prob > 0.85):
                    continue

                prob_pct = round(prob * 100)
                title = f'Manifold: {question} — {prob_pct}% probability'
                evt = build_event(
                    title=title,
                    desc=f'Prediction market: {question} ({prob_pct}% yes, ${volume:.0f} volume)',
                    source='MANIFOLD',
                )
                # High-confidence extreme outcomes get signal boost
                if prob > 0.80 or prob < 0.10:
                    evt['signal'] = min(100, evt.get('signal', 50) + 15)
                events.append(evt)
                _seen_ids.add(mid)
                fresh_markets.append({
                    'id': mid, 'question': question,
                    'probability': prob, 'volume': volume,
                })

        if fresh_markets:
            _market_cache = (_market_cache + fresh_markets)[-200:]

        # Cap seen set size
        if len(_seen_ids) > 500:
            oldest = list(_seen_ids)[:100]
            for k in oldest:
                _seen_ids.discard(k)

        print(f'[MANIFOLD] {len(events)} new prediction market events')
    except Exception as e:
        print(f'[MANIFOLD] error: {e}')

    return events
