"""
GeoIntel Backend — OCHA Financial Tracking Service (FTS) Ingester
Tracks international humanitarian funding flows — which crises are
receiving (or not receiving) emergency funding.

Source: OCHA FTS API (no key required)
  https://api.hpc.tools/

Refreshed every 6h alongside macro data.
"""
import requests
from typing import List, Dict

from keyword_detector import build_event

_BASE = 'https://api.hpc.tools/v1/public'

_cache: Dict[str, float] = {}


def fetch_ocha() -> List[Dict]:
    """
    Fetch top humanitarian funding flows from OCHA FTS.
    Uses /fts/flow endpoint (plan overview endpoint was removed).
    Returns events for large emergency funding movements.
    """
    events = []
    # Try current and previous year
    for year in [2025, 2024]:
        try:
            r = requests.get(
                f'{_BASE}/fts/flow',
                params={'year': year, 'limit': 100},
                timeout=20,
            )
            r.raise_for_status()
            flows = r.json().get('data', {}).get('flows', [])
            if not flows:
                continue

            total_usd = sum(f.get('amountUSD', 0) or 0 for f in flows)
            _cache['ocha_flows_year'] = year
            _cache['ocha_total_flows_bn'] = round(total_usd / 1e9, 2)
            _cache['ocha_flow_count'] = len(flows)

            # Surface significant emergency flows (>$5M)
            for flow in flows:
                amt = flow.get('amountUSD', 0) or 0
                desc_text = (flow.get('description') or flow.get('budgetYear') or '').strip()
                if amt > 5_000_000:
                    title = f'OCHA FTS: ${amt/1e6:.0f}M humanitarian flow — {desc_text[:80]}'
                    evt = build_event(title=title, desc=desc_text[:200], source='OCHA-FTS')
                    events.append(evt)
                    if len(events) >= 5:
                        break

            print(f'[OCHA] {year}: {len(flows)} flows, ${total_usd/1e9:.1f}B total, {len(events)} events surfaced')
            return events
        except Exception as e:
            print(f'[OCHA] {year} error: {e}')

    return events


def get_cache() -> Dict[str, float]:
    return _cache
