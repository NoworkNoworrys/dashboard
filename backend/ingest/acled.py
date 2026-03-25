"""
GeoIntel Backend — ACLED Ingester
Fetches near real-time armed conflict events from the Armed Conflict Location
& Event Data Project (ACLED).

Auth: API key + email (ACLED deprecated OAuth in 2024)
Get your key: log in at acleddata.com → Account → API Access

Set env vars: ACLED_EMAIL and ACLED_KEY

Free for non-commercial use — register at acleddata.com
"""
import requests
from typing import List, Dict

from config import ACLED_EMAIL, ACLED_KEY
from keyword_detector import build_event

_DATA_URL = 'https://api.acleddata.com/acled/read'

# Event types that are most geopolitically significant
_RELEVANT_TYPES = {
    'Battles', 'Explosions/Remote violence', 'Violence against civilians',
    'Strategic developments', 'Protests', 'Riots',
}


def fetch_acled() -> List[Dict]:
    """
    Fetch the 50 most recent ACLED conflict events globally.
    Returns [] if ACLED_EMAIL / ACLED_KEY not configured.
    """
    if not ACLED_EMAIL or not ACLED_KEY:
        print('[ACLED] skipped — set ACLED_EMAIL and ACLED_KEY in .env (get key at acleddata.com/account)')
        return []

    try:
        r = requests.get(
            _DATA_URL,
            params={
                'key':    ACLED_KEY,
                'email':  ACLED_EMAIL,
                'limit':  50,
                'fields': 'event_date|event_type|sub_event_type|country|location|fatalities|notes|source',
            },
            timeout=15,
        )
        r.raise_for_status()
        data = r.json().get('data', [])
    except Exception as e:
        print(f'[ACLED] fetch error: {e}')
        return []

    events = []
    for item in data:
        event_type = item.get('event_type', '')
        if event_type not in _RELEVANT_TYPES:
            continue

        country    = item.get('country', '')
        location   = item.get('location', '')
        fatalities = item.get('fatalities', 0)
        notes      = (item.get('notes') or '')[:400]
        source     = (item.get('source') or 'ACLED').split(';')[0].strip().upper()[:8]

        title = f'{event_type}: {location}, {country}'
        if fatalities:
            title += f' ({fatalities} fatalities)'

        evt = build_event(title=title, desc=notes, source=source or 'ACLED')
        events.append(evt)

    print(f'[ACLED] fetched {len(events)} conflict events')
    return events
