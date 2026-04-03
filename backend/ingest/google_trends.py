"""
GeoIntel Backend — Google Trends Ingester
Tracks search interest spikes for geopolitical keywords via pytrends.
No API key required (uses unofficial Google Trends API).
Rate-limited — called every 30 cycles (~30 min) to avoid 429s.

Requires: pip install pytrends
"""
from typing import Dict, List

_cache: Dict[str, int] = {}   # keyword → interest score (0-100)

# Keywords to track — grouped to stay within pytrends 5-term limit per request
_KEYWORD_GROUPS: List[List[str]] = [
    ['war', 'sanctions', 'nuclear', 'military coup', 'invasion'],
    ['airstrike', 'missile attack', 'ceasefire', 'NATO', 'geopolitical crisis'],
    ['oil price', 'energy crisis', 'food shortage', 'refugee', 'conflict'],
]


def fetch_google_trends() -> Dict[str, int]:
    """
    Fetch 7-day search interest for geopolitical keywords.
    Returns dict of {keyword: interest_score} (0-100).
    Returns cached data (or empty) if pytrends is unavailable.
    """
    global _cache
    try:
        from pytrends.request import TrendReq
    except ImportError:
        print('[GTRENDS] pytrends not installed — skipping')
        return _cache

    # urllib3 v2 renamed method_whitelist → allowed_methods; monkey-patch for older pytrends
    try:
        import urllib3.util.retry as _retry_mod
        _orig = _retry_mod.Retry.__init__
        def _patched(self, *args, **kw):
            if 'method_whitelist' in kw:
                kw['allowed_methods'] = kw.pop('method_whitelist')
            _orig(self, *args, **kw)
        _retry_mod.Retry.__init__ = _patched
    except Exception as e:
        print(f'[GOOGLE_TRENDS] pytrends Retry patch failed (non-fatal): {e}')

    pytrends = TrendReq(hl='en-US', tz=0, timeout=(10, 25), retries=1, backoff_factor=0.5)
    results: Dict[str, int] = {}

    for group in _KEYWORD_GROUPS:
        try:
            pytrends.build_payload(group, timeframe='now 7-d', geo='')
            df = pytrends.interest_over_time()
            if df.empty:
                continue
            for kw in group:
                if kw in df.columns:
                    results[kw] = int(df[kw].iloc[-1])
        except Exception as e:
            print(f'[GTRENDS] group {group} error: {e}')

    if results:
        _cache = results
    print(f'[GTRENDS] tracked {len(_cache)} keywords')
    return _cache


def get_cache() -> Dict[str, int]:
    return _cache
