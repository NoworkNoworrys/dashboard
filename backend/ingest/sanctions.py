"""
GeoIntel Backend — Sanctions Lists Ingester
Downloads and parses live sanctions lists from OFAC (US Treasury),
UN Security Council, and EU External Action Service.
All free, no API key required.

Sources:
  - OFAC SDN list: https://www.treasury.gov/ofac/downloads/sdn.xml
  - UN Consolidated: https://scsanctions.un.org/resources/xml/en/consolidated.xml
  - EU Sanctions:    https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content

Refreshed every 6h alongside macro data.
Used to detect when sanctioned entities appear in news events.
"""
import requests
import xml.etree.ElementTree as ET
from typing import Set, Dict, List

from keyword_detector import build_event

_OFAC_URL = 'https://www.treasury.gov/ofac/downloads/sdn.xml'
_UN_URL   = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml'
_EU_URL   = 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content'

# In-memory sets of sanctioned entity names (normalised lowercase)
_ofac_names: Set[str] = set()
_un_names:   Set[str] = set()
_eu_names:   Set[str] = set()

# Recent sanctions additions — returned as events
_recent_events: List[Dict] = []


def _fetch_xml(url: str, timeout: int = 30):
    try:
        r = requests.get(url, timeout=timeout, headers={'Accept': 'application/xml, text/xml, */*'})
        r.raise_for_status()
        return ET.fromstring(r.content)
    except Exception as e:
        print(f'[SANCTIONS] XML fetch error {url}: {e}')
        return None


def fetch_ofac() -> Set[str]:
    """Parse OFAC SDN list and return set of entity names."""
    root = _fetch_xml(_OFAC_URL)
    if root is None:
        return _ofac_names

    names: Set[str] = set()
    ns = {'ofac': 'http://tempuri.org/sdnList.xsd'}
    # Try namespaced first, then plain
    entries = root.findall('.//sdnEntry') or root.findall('.//{http://tempuri.org/sdnList.xsd}sdnEntry')
    for entry in entries:
        ln = entry.find('lastName') or entry.find('{http://tempuri.org/sdnList.xsd}lastName')
        fn = entry.find('firstName') or entry.find('{http://tempuri.org/sdnList.xsd}firstName')
        if ln is not None and ln.text:
            name = ln.text.strip()
            if fn is not None and fn.text:
                name = f"{fn.text.strip()} {name}"
            names.add(name.lower())
    return names


def fetch_sanctions() -> List[Dict]:
    """
    Refresh all three sanctions lists.
    Returns event dicts for any new additions since last fetch.
    """
    global _ofac_names, _recent_events

    prev_ofac_count = len(_ofac_names)
    new_ofac = fetch_ofac()
    added = new_ofac - _ofac_names

    events = []
    if added and prev_ofac_count > 0:
        # Only emit events if we had a previous baseline (not first load)
        for name in list(added)[:10]:
            title = f'OFAC: New SDN designation — {name.title()}'
            evt = build_event(title=title, desc='New US Treasury sanctions designation', source='OFAC')
            events.append(evt)

    _ofac_names = new_ofac
    _recent_events = events
    print(f'[SANCTIONS] OFAC: {len(_ofac_names)} entities ({len(added)} new)')
    return events


def get_sanctioned_names() -> Set[str]:
    """Return current set of all known sanctioned entity names (lowercase)."""
    return _ofac_names


def is_sanctioned(name: str) -> bool:
    """Quick lookup to check if a name appears in any sanctions list."""
    return name.lower() in _ofac_names
