"""
GeoIntel Backend — UCDP Ingester
Fetches georeferenced conflict events from the Uppsala Conflict Data Program.
Free, no API key required.

API docs: https://ucdpapi.pcr.uu.se/
Data: georeferenced events with date, country, parties involved, fatality estimates.
Refreshed in batch — called once at startup then every 6h with macro data.
"""
import os
import requests
from typing import List, Dict
from datetime import datetime, timedelta

from keyword_detector import build_event

UCDP_URL = 'https://ucdpapi.pcr.uu.se/api/gedevents/25.1'
# UCDP now requires a free API token — register at https://ucdpapi.pcr.uu.se/
# Set UCDP_API_TOKEN in your .env or environment to enable this source.
_TOKEN = os.environ.get('UCDP_API_TOKEN', '')

# In-memory cache — updated by fetch_ucdp(), read by get_cache()
_cache: List[Dict] = []


def fetch_ucdp() -> List[Dict]:
    """
    Fetch UCDP georeferenced conflict events from the past 90 days.
    Stores results in cache and returns event dicts for the pipeline.
    """
    global _cache

    # Build date range: past 90 days
    end   = datetime.utcnow()
    start = end - timedelta(days=90)

    if not _TOKEN:
        print('[UCDP] skipped — no UCDP_API_TOKEN set (register free at https://ucdpapi.pcr.uu.se/)')
        return []

    try:
        r = requests.get(
            UCDP_URL,
            params={
                'StartDate': start.strftime('%Y-%m-%d'),
                'EndDate':   end.strftime('%Y-%m-%d'),
                'pagesize':  100,
            },
            headers={'x-ucdp-access-token': _TOKEN},
            timeout=20,
        )
        r.raise_for_status()
        items = r.json().get('Result', [])
    except Exception as e:
        print(f'[UCDP] fetch error: {e}')
        return []

    events = []
    for item in items:
        country     = item.get('country', '')
        date_prec   = item.get('date_prec', '')
        best        = item.get('best', 0) or 0        # best fatality estimate
        side_a      = item.get('side_a', '')
        side_b      = item.get('side_b', '')
        source_orig = (item.get('source_article') or '')[:200]

        if not country:
            continue

        title = f"UCDP conflict event: {side_a} vs {side_b}, {country}"
        desc  = f"Fatalities (best estimate): {best}. {source_orig}"

        evt = build_event(title=title, desc=desc, source='UCDP')
        events.append(evt)

    _cache = events
    print(f'[UCDP] fetched {len(events)} conflict events')
    return events


def get_cache() -> List[Dict]:
    return _cache
