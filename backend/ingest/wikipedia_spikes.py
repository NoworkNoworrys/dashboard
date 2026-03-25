"""
GeoIntel Backend — Wikipedia Edit Spike Detector
Monitors recent edits to Wikipedia articles about countries, conflicts,
and geopolitical entities. A sudden burst of edits to a country or
conflict article is a reliable early signal of a breaking event.

Uses the Wikipedia Recent Changes API — free, no key required.
API docs: https://www.mediawiki.org/wiki/API:RecentChanges
"""
import requests
from collections import Counter
from typing import List, Dict
from datetime import datetime, timedelta

from keyword_detector import build_event

_API_URL = 'https://en.wikipedia.org/w/api.php'

# Articles to monitor — country/conflict pages most likely to spike on events
_WATCH_ARTICLES = {
    # Active conflict zones
    'Russo-Ukrainian War', 'Israel–Hamas war', 'Syrian civil war',
    'Myanmar civil war', 'Tigray War', 'Sudanese civil war (2023–present)',
    'Second Libyan Civil War', 'Yemeni civil war (2014–present)',
    # Countries of interest
    'Russia', 'China', 'Iran', 'North Korea', 'Israel', 'Taiwan',
    'Ukraine', 'United States', 'Saudi Arabia', 'Pakistan', 'India',
    # Nuclear / WMD
    'Nuclear warfare', 'Iran and weapons of mass destruction',
    'North Korea and weapons of mass destruction',
    # Economic
    'Sanctions against Russia', 'Inflation', 'OPEC',
}

# Minimum edits in 1h to trigger an alert
_SPIKE_THRESHOLD = 5


def fetch_wikipedia_spikes() -> List[Dict]:
    """
    Check recent edit activity on monitored Wikipedia articles.
    Returns events for articles with abnormal edit spikes in the past hour.
    """
    since = (datetime.utcnow() - timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%SZ')
    events = []

    # Fetch recent changes across all monitored titles in one request
    titles_str = '|'.join(list(_WATCH_ARTICLES)[:50])  # API limit: 50 titles
    try:
        r = requests.get(
            _API_URL,
            params={
                'action':    'query',
                'list':      'recentchanges',
                'rcstart':   datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
                'rcend':     since,
                'rcdir':     'older',
                'rclimit':   500,
                'rctype':    'edit',
                'rcnamespace': 0,
                'rctitles':  titles_str,
                'format':    'json',
            },
            headers={'User-Agent': 'GeoDashboard/1.0 (https://github.com/geodash; research use; megamorgs807@gmail.com)'},
            timeout=12,
        )
        r.raise_for_status()
        changes = r.json().get('query', {}).get('recentchanges', [])
    except Exception as e:
        print(f'[WIKI] recent changes error: {e}')
        return []

    # Count edits per article
    edit_counts: Counter = Counter()
    for change in changes:
        title = change.get('title', '')
        if title in _WATCH_ARTICLES:
            edit_counts[title] += 1

    # Surface articles with spike-level edit activity
    for title, count in edit_counts.items():
        if count >= _SPIKE_THRESHOLD:
            evt_title = f'Wikipedia edit spike: "{title}" — {count} edits in 1h'
            desc = f'Unusual Wikipedia activity on "{title}" may indicate a breaking event ({count} edits in the past hour).'
            evt = build_event(title=evt_title, desc=desc, source='WIKI')
            events.append(evt)

    print(f'[WIKI] {len(events)} article spike(s) detected ({len(edit_counts)} articles had edits)')
    return events
