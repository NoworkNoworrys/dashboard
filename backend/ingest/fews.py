"""
GeoIntel Backend — FEWS NET Famine Alert Ingester
Fetches food security and famine early warning data from FEWS NET
(Famine Early Warning Systems Network).

Source: FEWS NET API (no key required)
  https://fdw.fews.net/api/

Tracks IPC Phase 3+ (Crisis/Emergency/Famine) classifications.
Refreshed every 6h alongside macro data.
"""
import requests
from typing import List, Dict

from keyword_detector import build_event

_BASE = 'https://fdw.fews.net/api'

# IPC phase labels
_PHASE_LABELS = {
    1: 'Minimal',
    2: 'Stressed',
    3: 'Crisis',
    4: 'Emergency',
    5: 'Famine',
}


def fetch_fews() -> List[Dict]:
    """
    Fetch latest FEWS NET food insecurity alerts.
    Returns events for IPC Phase 3+ (Crisis and above) areas.
    """
    events = []
    try:
        r = requests.get(
            f'{_BASE}/ipcphase/',
            params={
                'format': 'json',
                'phase': '3,4,5',      # Crisis, Emergency, Famine only
                'ordering': '-end_date',
                'page_size': '20',
            },
            timeout=20,
        )
        r.raise_for_status()
        results = r.json().get('results', [])
        for item in results[:10]:
            country = item.get('country', {})
            country_name = country.get('name', 'Unknown') if isinstance(country, dict) else str(country)
            phase = item.get('ipc_phase', 0)
            phase_label = _PHASE_LABELS.get(phase, f'Phase {phase}')
            pop_affected = item.get('population_affected', 0)
            period = item.get('period_date', '')

            if pop_affected:
                title = (f'FEWS NET: {country_name} — IPC {phase_label} '
                         f'({int(pop_affected):,} people)')
            else:
                title = f'FEWS NET: {country_name} — IPC {phase_label}'

            evt = build_event(
                title=title,
                desc=f'Food security IPC {phase_label} classification in {country_name}. Period: {period}',
                source='FEWSNET',
            )
            # Boost signal for Emergency/Famine
            if phase >= 4:
                evt['signal'] = min(100, evt.get('signal', 50) + 20)
            events.append(evt)

        print(f'[FEWS NET] {len(events)} Phase 3+ food insecurity alerts')
    except Exception as e:
        print(f'[FEWS NET] error: {e}')

    return events
