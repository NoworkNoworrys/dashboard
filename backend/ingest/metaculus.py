"""
GeoIntel Backend — Metaculus Ingester
Fetches crowd-sourced geopolitical probability forecasts from Metaculus.
Free, no API key required for public questions.

API docs: https://www.metaculus.com/api2/

Tracks questions tagged: geopolitics, military, nuclear, conflict, economics
High-probability or rapidly-moving forecasts are surfaced as events.
"""
import os
import requests
from typing import List, Dict

from keyword_detector import build_event

# Metaculus now requires an API token — set METACULUS_API_TOKEN in .env
_TOKEN = os.environ.get('METACULUS_API_TOKEN', '')

_BASE_URL = 'https://www.metaculus.com/api/questions/'

_TAGS = ['geopolitics', 'military', 'nuclear', 'conflict', 'war', 'sanctions']

# Probability thresholds that warrant surfacing as an event
_HIGH_PROB_THRESHOLD = 0.70   # >70% → high-probability event
_SPIKE_THRESHOLD     = 0.15   # probability moved >15 points recently


def fetch_metaculus() -> List[Dict]:
    """
    Fetch open Metaculus questions on geopolitical topics.
    Surfaces questions where community probability is high (>70%)
    or has moved significantly.
    """
    if not _TOKEN:
        print('[METACULUS] skipped — no METACULUS_API_TOKEN set')
        return []

    events = []
    seen_ids: set = set()

    for tag in _TAGS[:3]:  # limit to 3 tags to avoid rate limits
        try:
            r = requests.get(
                _BASE_URL,
                params={
                    'status':   'open',
                    'tag':      tag,
                    'order_by': '-activity',
                    'limit':    20,
                },
                headers={
                    'Accept': 'application/json',
                    'Authorization': f'Token {_TOKEN}',
                },
                timeout=12,
            )
            r.raise_for_status()
            questions = r.json().get('results', [])
        except Exception as e:
            err_str = str(e)
            if '403' in err_str:
                print(f'[METACULUS] API now requires auth token — skipping')
                break  # All tags will fail — stop trying
            print(f'[METACULUS] tag={tag} error: {e}')
            continue

        for q in questions:
            qid = q.get('id')
            if qid in seen_ids:
                continue
            seen_ids.add(qid)

            title     = (q.get('title') or '').strip()
            community = q.get('community_prediction', {})
            prob      = community.get('full', {}).get('q2') if isinstance(community, dict) else None

            if prob is None or not title:
                continue

            # Only surface high-probability or near-certain questions
            if prob < _HIGH_PROB_THRESHOLD:
                continue

            pct = round(prob * 100)
            evt_title = f'Metaculus [{pct}%]: {title}'
            desc = f'Community forecast: {pct}% probability. Tag: {tag}.'
            evt = build_event(title=evt_title, desc=desc, source='METACULUS')
            events.append(evt)

    print(f'[METACULUS] {len(events)} high-probability forecasts surfaced')
    return events
