"""
GeoIntel Backend — ProPublica Congress API Ingester
Tracks US Congressional activity: votes, bills, and member financials
relevant to geopolitical and market-moving legislation.

Source: ProPublica Congress API (free key — register at propublica.org/datastore)
Set env var: PROPUBLICA_KEY

Tracks: defense bills, sanctions legislation, foreign policy votes.
Refreshed every 6h alongside macro data.
"""
import requests
from typing import List, Dict

from config import PROPUBLICA_KEY
from keyword_detector import build_event

_BASE = 'https://api.propublica.org/congress/v1'

_GEO_KEYWORDS = [
    'defense', 'military', 'sanction', 'foreign', 'nato', 'ukraine',
    'taiwan', 'china', 'russia', 'iran', 'israel', 'armed forces',
    'national security', 'intelligence', 'trade', 'tariff', 'appropriat',
]

_seen_ids: set = set()


def _is_relevant(text: str) -> bool:
    text_l = text.lower()
    return any(kw in text_l for kw in _GEO_KEYWORDS)


def fetch_propublica() -> List[Dict]:
    """
    Fetch recent Congressional bills and votes relevant to geopolitics.
    Returns [] if PROPUBLICA_KEY not configured.
    """
    if not PROPUBLICA_KEY:
        return []

    events = []
    headers = {'X-API-Key': PROPUBLICA_KEY}

    # Recent introduced bills (Senate + House)
    for chamber in ('senate', 'house'):
        try:
            r = requests.get(
                f'{_BASE}/119/bills/introduced.json',
                headers=headers,
                timeout=15,
            )
            r.raise_for_status()
            bills = r.json().get('results', [{}])[0].get('bills', [])

            for bill in bills[:20]:
                bid = bill.get('bill_id', '')
                if bid in _seen_ids:
                    continue
                title = bill.get('title', '') or bill.get('short_title', '')
                if not title or not _is_relevant(title):
                    continue

                sponsor = bill.get('sponsor_name', '')
                committees = bill.get('committees', '')
                evt = build_event(
                    title=f'Congress: {title}',
                    desc=f'Bill introduced by {sponsor}. Committees: {committees}',
                    source='PROPUBLICA',
                )
                events.append(evt)
                _seen_ids.add(bid)

        except Exception as e:
            print(f'[PROPUBLICA] {chamber} bills error: {e}')

    # Cap seen set
    if len(_seen_ids) > 2000:
        for k in list(_seen_ids)[:400]:
            _seen_ids.discard(k)

    print(f'[PROPUBLICA] {len(events)} new geopolitical bills')
    return events
