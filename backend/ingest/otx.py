"""
GeoIntel Backend — AlienVault OTX Cyber Threat Intel Ingester
Fetches geopolitically significant cyber threat pulses from AlienVault OTX.

Source: OTX API (free API key required — register at otx.alienvault.com)
Set env var: OTX_KEY

Tracks state-sponsored and nation-state cyber threat campaigns.
Refreshed every cycle.
"""
import requests
from typing import List, Dict

from config import OTX_KEY
from keyword_detector import build_event

_BASE = 'https://otx.alienvault.com/api/v1'

_seen_ids: set = set()

_STATE_KEYWORDS = [
    'apt', 'nation state', 'state sponsored', 'china', 'russia', 'iran',
    'north korea', 'lazarus', 'cozy bear', 'fancy bear', 'volt typhoon',
    'critical infrastructure', 'power grid', 'water', 'financial system',
    'military', 'government', 'espionage', 'cyber', 'ransomware',
]


def fetch_otx() -> List[Dict]:
    """
    Fetch recent OTX threat pulses filtered to geopolitically relevant ones.
    Returns [] if OTX_KEY not configured.
    """
    if not OTX_KEY:
        return []

    events = []
    try:
        r = requests.get(
            f'{_BASE}/pulses/subscribed',
            params={'limit': '20', 'page': '1', 'modified_since': '2024-01-01'},
            headers={'X-OTX-API-KEY': OTX_KEY},
            timeout=15,
        )
        r.raise_for_status()
        pulses = r.json().get('results', [])

        for pulse in pulses:
            pid = pulse.get('id', '')
            if pid in _seen_ids:
                continue

            name = pulse.get('name', '')
            desc = pulse.get('description', '')
            tags = [t.lower() for t in pulse.get('tags', [])]
            adversary = pulse.get('adversary', '')

            combined = (name + ' ' + desc + ' ' + ' '.join(tags) + ' ' + adversary).lower()
            if not any(kw in combined for kw in _STATE_KEYWORDS):
                continue

            title = f'OTX Cyber: {name}'
            if adversary:
                title += f' [{adversary}]'

            evt = build_event(
                title=title,
                desc=desc[:300] if desc else name,
                source='OTX',
            )
            # APT/state-sponsored campaigns get signal boost
            if any(kw in combined for kw in ['apt', 'state sponsored', 'nation state']):
                evt['signal'] = min(100, evt.get('signal', 50) + 20)
            events.append(evt)
            _seen_ids.add(pid)

        # Cap seen set
        if len(_seen_ids) > 1000:
            for k in list(_seen_ids)[:200]:
                _seen_ids.discard(k)

        print(f'[OTX] {len(events)} new cyber threat events')
    except Exception as e:
        print(f'[OTX] error: {e}')

    return events
