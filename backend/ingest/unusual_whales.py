"""
GeoIntel Backend — Unusual Whales Ingest Module
================================================
Fetches high-signal market intelligence from the Unusual Whales API and converts
it into the same event/signal format used by all other pipeline sources.

Endpoints used (in priority order):
  1. /api/option-trades/flow-alerts   — unusual options activity (2-min poll)
  2. /api/darkpool/recent             — dark pool prints (5-min poll)
  3. /api/congress/trades             — congressional trades (30-min poll)
  4. /api/market/tide                 — market net premium tide (5-min poll)
  5. /api/stock/{ticker}/iv-rank      — IV rank per tracked asset (15-min poll)

Signal generation logic:
  - Flow alert on tracked asset  → directional EE signal (call=LONG, put=SHORT)
  - Premium > $500k              → high confidence boost
  - Dark pool print > $1M        → adds to event confidence
  - Congress buy in defense/energy → geopolitical LONG signal
  - Market tide negative          → bearish regime tag
  - IV rank > 80                  → risk-cap flag sent to EE

All signals enter the main event pipeline with source='UW' and are treated
identically to geopolitical events — they corroborate, decay, and get scored.
"""

import time
import requests
from typing import List, Dict, Optional

# ── Timestamp bounds for sanity checking ─────────────────────────────────────
_TS_MIN_MS = 631152000000   # Jan 1990 in ms
_TS_MAX_MS = 2524608000000  # Jan 2050 in ms

def _parse_ts(ts_raw) -> int:
    """Parse a raw timestamp (seconds, ms, us, or ns) into milliseconds.
    Returns current time in ms if ts_raw is missing or out of bounds."""
    try:
        v = float(ts_raw)
        if v < 1e10:        # seconds
            ts = int(v * 1000)
        elif v < 1e13:      # milliseconds
            ts = int(v)
        elif v < 1e16:      # microseconds
            ts = int(v / 1000)
        else:               # nanoseconds
            ts = int(v / 1e6)
        if _TS_MIN_MS <= ts <= _TS_MAX_MS:
            return ts
    except (ValueError, TypeError):
        pass
    return int(time.time() * 1000)

# ── Tracked assets (must match EE/HL routing maps) ───────────────────────────
TRACKED_TICKERS = [
    'SPY', 'QQQ', 'VXX', 'TLT', 'GLD', 'SLV', 'XLE', 'XAR',
    'LMT', 'RTX', 'NOC', 'BA', 'GD',                   # defense
    'NVDA', 'TSM', 'AMAT', 'ASML',                      # semis
    'XOM', 'CVX',                                        # energy majors
    'AAPL', 'MSFT', 'TSLA', 'AMZN', 'META', 'GOOGL',   # mega-cap
]

# Tickers mapped to our internal asset names for EE routing
TICKER_TO_EE = {
    'SPY': 'SPY', 'QQQ': 'QQQ', 'VXX': 'VXX', 'TLT': 'TLT',
    'GLD': 'GLD', 'SLV': 'SLV', 'XLE': 'XLE', 'XAR': 'XAR',
    'LMT': 'LMT', 'RTX': 'RTX', 'NOC': 'NOC', 'BA': 'BA',
    'NVDA': 'NVDA', 'TSM': 'TSM',
    'XOM': 'XOM', 'CVX': 'CVX',
    'AAPL': 'AAPL', 'MSFT': 'MSFT', 'TSLA': 'TSLA',
    'AMZN': 'AMZN', 'META': 'META', 'GOOGL': 'GOOGL',
}

# Sector → geopolitical region mapping for event tagging
SECTOR_TO_REGION = {
    'Energy':              'GLOBAL',
    'Industrials':         'US',
    'Information Technology': 'US',
    'Financials':          'US',
    'Consumer Discretionary': 'US',
    'Health Care':         'US',
    'Utilities':           'GLOBAL',
    'Materials':           'GLOBAL',
    'Communication Services': 'GLOBAL',
}

DEFENSE_TICKERS = {'LMT', 'RTX', 'NOC', 'BA', 'GD', 'HII', 'LDOS', 'SAIC', 'L3T', 'XAR'}
ENERGY_TICKERS  = {'XOM', 'CVX', 'COP', 'PSX', 'XLE', 'OXY', 'HAL', 'SLB'}

BASE_URL = 'https://api.unusualwhales.com'
TIMEOUT  = 10


def _headers(api_key: str) -> Dict:
    return {
        'Authorization': f'Bearer {api_key}',
        'Accept': 'application/json',
        'User-Agent': 'GeoIntel/1.0',
    }


def _get(api_key: str, path: str, params: Dict = None) -> Optional[Dict]:
    """Make a GET request to the UW API. Returns parsed JSON or None on failure."""
    try:
        r = requests.get(
            BASE_URL + path,
            headers=_headers(api_key),
            params=params or {},
            timeout=TIMEOUT,
        )
        if r.status_code == 429:
            print(f'[UW] Rate limited on {path} — backing off')
            return None
        if r.status_code == 401:
            print(f'[UW] Invalid API key — check UW_API_KEY env var')
            return None
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f'[UW] {path} error: {e}')
        return None


# ─────────────────────────────────────────────────────────────────────────────
# 1. FLOW ALERTS — unusual options activity
# ─────────────────────────────────────────────────────────────────────────────

def _premium_to_signal(premium: float, is_sweep: bool, is_block: bool) -> int:
    """
    Map option premium size to signal strength (20–95).
    Sweeps and blocks add urgency. Larger premium = higher conviction.
    """
    if premium >= 5_000_000:  base = 85
    elif premium >= 2_000_000:  base = 75
    elif premium >= 1_000_000:  base = 65
    elif premium >= 500_000:    base = 55
    elif premium >= 250_000:    base = 42
    else:                       base = 30

    if is_sweep: base = min(95, base + 8)
    if is_block: base = min(95, base + 5)
    return base


def _flow_direction(alert: Dict) -> Optional[str]:
    """
    Determine signal direction from flow alert.
    Returns 'LONG', 'SHORT', or None if ambiguous.
    Bearish = puts OR call selling; Bullish = calls OR put selling.
    """
    opt_type = (alert.get('type') or alert.get('option_type') or '').upper()
    # Bid-side premium > ask-side = seller-initiated = fading the move
    ask_prem = float(alert.get('total_ask_side_prem') or 0)
    bid_prem = float(alert.get('total_bid_side_prem') or 0)
    total    = float(alert.get('total_premium') or 0)

    if total == 0:
        return None

    ask_ratio = ask_prem / total if total else 0.5

    if opt_type == 'CALL':
        # Calls bought on ask = bullish; on bid = potentially bearish hedge
        return 'LONG' if ask_ratio >= 0.55 else None
    elif opt_type == 'PUT':
        # Puts bought on ask = bearish
        return 'SHORT' if ask_ratio >= 0.55 else None
    return None


def fetch_flow_alerts(api_key: str, newer_than_ms: int = None) -> List[Dict]:
    """
    Fetch recent unusual options flow alerts.
    Returns events in the standard pipeline format.
    """
    params = {'limit': 100}
    if newer_than_ms:
        params['newer_than'] = newer_than_ms // 1000  # UW uses unix seconds

    data = _get(api_key, '/api/option-trades/flow-alerts', params)
    if not data:
        return []

    alerts = data.get('data', data if isinstance(data, list) else [])
    events = []

    for alert in alerts:
        ticker  = (alert.get('ticker') or alert.get('option_chain') or '').upper().replace('O:', '')
        if not ticker:
            continue

        premium   = float(alert.get('total_premium') or 0)
        if premium < 100_000:      # filter noise — only > $100k matters
            continue

        opt_type  = (alert.get('type') or '').upper()
        strike    = alert.get('strike', '?')
        expiry    = alert.get('expiry', '')[:10] if alert.get('expiry') else '?'
        is_sweep  = bool(alert.get('has_sweep') or alert.get('is_sweep'))
        is_block  = bool(alert.get('has_floor') or alert.get('is_block'))
        sector    = alert.get('sector', '')
        vol_oi    = float(alert.get('volume_oi_ratio') or 0)
        iv_end    = float(alert.get('iv_end') or 0)

        direction = _flow_direction(alert)
        signal_str = _premium_to_signal(premium, is_sweep, is_block)

        # Extra boost for very high vol/OI ratio (not routine hedging)
        if vol_oi > 5:
            signal_str = min(95, signal_str + 5)

        prem_fmt  = f'${premium/1_000_000:.1f}M' if premium >= 1_000_000 else f'${premium/1_000:.0f}K'
        flow_type = ('SWEEP ' if is_sweep else '') + ('BLOCK ' if is_block else '') + opt_type
        desc_dir  = direction or 'NEUTRAL'

        region = SECTOR_TO_REGION.get(sector, 'GLOBAL')
        if ticker in DEFENSE_TICKERS: region = 'US'
        if ticker in ENERGY_TICKERS:  region = 'GLOBAL'

        # Map to EE asset name
        ee_asset = TICKER_TO_EE.get(ticker, ticker)
        assets   = [ee_asset] if ee_asset else []

        # Add sector-relevant macro assets
        if ticker in DEFENSE_TICKERS: assets += ['LMT', 'RTX', 'XAR']
        if ticker in ENERGY_TICKERS:  assets += ['WTI', 'BRENTOIL', 'XLE']

        keywords = ['options', 'unusual_flow', opt_type.lower()]
        if is_sweep:   keywords.append('sweep')
        if is_block:   keywords.append('block')
        if direction == 'LONG':  keywords.append('bullish')
        if direction == 'SHORT': keywords.append('bearish')
        if premium >= 1_000_000: keywords.append('major_premium')

        ts_raw = alert.get('created_at') or alert.get('start_time') or alert.get('ts')
        ts = _parse_ts(ts_raw)

        events.append({
            'title':    f'{ticker} {flow_type} {strike} exp {expiry} — {prem_fmt} premium',
            'desc':     (
                f'Unusual {opt_type} flow on {ticker}: {prem_fmt} premium, '
                f'vol/OI={vol_oi:.1f}x, IV={iv_end:.0f}%, '
                f'direction={desc_dir}. '
                f'{"Sweep execution — urgency signal. " if is_sweep else ""}'
                f'{"Block/floor trade — institutional. " if is_block else ""}'
                f'Sector: {sector or "unknown"}.'
            ),
            'source':   'UW/FlowAlert',
            'ts':       ts,
            'region':   region,
            'keywords': keywords,
            'assets':   list(set(assets)),
            'signal':   signal_str,
            'srcCount': 1,
            'socialV':  min(1.0, premium / 5_000_000),
            # UW-specific fields stored for frontend
            'uw_type':      'flow_alert',
            'uw_ticker':    ticker,
            'uw_direction': direction,
            'uw_premium':   premium,
            'uw_opt_type':  opt_type,
            'uw_strike':    str(strike),
            'uw_expiry':    expiry,
            'uw_sweep':     is_sweep,
            'uw_block':     is_block,
            'uw_vol_oi':    vol_oi,
        })

    print(f'[UW] flow_alerts: {len(alerts)} fetched, {len(events)} above threshold')
    return events


# ─────────────────────────────────────────────────────────────────────────────
# 2. DARK POOL — large institutional prints
# ─────────────────────────────────────────────────────────────────────────────

def fetch_darkpool(api_key: str) -> List[Dict]:
    """
    Fetch recent dark pool (off-exchange) trades.
    Only surfaces prints > $2M on tracked assets — filters routine ETF rebalancing.
    """
    data = _get(api_key, '/api/darkpool/recent', {'limit': 200})
    if not data:
        return []

    prints = data.get('data', data if isinstance(data, list) else [])
    events = []

    for p in prints:
        ticker = (p.get('ticker') or p.get('symbol') or '').upper()
        if ticker not in TRACKED_TICKERS:
            continue

        price  = float(p.get('price') or p.get('executed_price') or 0)
        size   = int(p.get('size') or p.get('quantity') or 0)
        value  = price * size
        if value < 2_000_000:     # only meaningful prints
            continue

        val_fmt = f'${value/1_000_000:.1f}M'
        premium_vs_nbbo = float(p.get('premium') or 0)
        bought_above    = premium_vs_nbbo > 0  # paid above NBBO = bullish urgency

        signal_str = 60 if value >= 10_000_000 else 50 if value >= 5_000_000 else 40

        ee_asset = TICKER_TO_EE.get(ticker, ticker)
        assets   = [ee_asset]
        region   = 'US'
        if ticker in ENERGY_TICKERS:  region = 'GLOBAL'; assets += ['WTI', 'BRENTOIL']
        if ticker in DEFENSE_TICKERS: assets += ['LMT', 'RTX']

        ts_raw = p.get('executed_at') or p.get('ts') or p.get('created_at')
        ts = _parse_ts(ts_raw)

        events.append({
            'title':    f'{ticker} dark pool print {val_fmt} @ ${price:.2f}',
            'desc':     (
                f'Off-exchange print on {ticker}: {val_fmt} ({size:,} shares @ ${price:.2f}). '
                f'{"Bought above NBBO — aggressive buyer. " if bought_above else ""}'
                f'Institutional accumulation signal.'
            ),
            'source':   'UW/DarkPool',
            'ts':       ts,
            'region':   region,
            'keywords': ['darkpool', 'institutional', 'accumulation',
                         'bullish' if bought_above else 'neutral'],
            'assets':   list(set(assets)),
            'signal':   signal_str,
            'srcCount': 1,
            'socialV':  min(1.0, value / 20_000_000),
            'uw_type':  'darkpool',
            'uw_ticker': ticker,
            'uw_value': value,
            'uw_price': price,
            'uw_size':  size,
        })

    print(f'[UW] darkpool: {len(prints)} fetched, {len(events)} above $2M threshold')
    return events


# ─────────────────────────────────────────────────────────────────────────────
# 3. CONGRESS TRADES — political insider activity
# ─────────────────────────────────────────────────────────────────────────────

def fetch_congress_trades(api_key: str) -> List[Dict]:
    """
    Fetch recent congressional stock disclosures.
    Focuses on defense, energy, and tech — directly linked to geopolitical policy.
    Congress trades are lagged (up to 45 days) but still highly predictive
    because they reveal policy direction before it's public.
    """
    data = _get(api_key, '/api/congress/trades', {'limit': 50})
    if not data:
        return []

    trades = data.get('data', data if isinstance(data, list) else [])
    events = []

    for t in trades:
        ticker    = (t.get('ticker') or t.get('asset_description') or '').upper()
        tx_type   = (t.get('type') or t.get('transaction_type') or '').lower()
        politician = t.get('politician') or t.get('representative') or 'Unknown'
        party     = (t.get('party') or '')[:1].upper()  # R/D
        chamber   = (t.get('chamber') or t.get('congress_type') or '').lower()
        amount_str = t.get('amount') or t.get('amount_range') or '$1,001 - $15,000'
        sector    = t.get('sector', '')
        committee  = t.get('committees', '')

        # Only surface buys — sales are ambiguous (could be diversification)
        is_buy    = 'purchase' in tx_type or 'buy' in tx_type or tx_type == 'buy'
        is_sell   = 'sale' in tx_type or 'sell' in tx_type
        if not is_buy and not is_sell:
            continue

        # Filter to sectors relevant to geopolitical trading
        relevant_sectors = {'Industrials', 'Energy', 'Information Technology',
                            'Financials', 'Materials', 'Communication Services'}
        ticker_relevant = (
            ticker in DEFENSE_TICKERS or
            ticker in ENERGY_TICKERS or
            ticker in TRACKED_TICKERS or
            sector in relevant_sectors
        )
        if not ticker_relevant:
            continue

        # Parse amount range to midpoint
        amount_mid = _parse_amount(amount_str)
        if amount_mid < 1000:
            continue

        # Signal strength: higher for defense/energy, larger amounts, senior members
        signal_str = 45  # base
        if ticker in DEFENSE_TICKERS: signal_str += 15  # defense = policy signal
        if ticker in ENERGY_TICKERS:  signal_str += 10
        if amount_mid >= 100_000:      signal_str += 10
        if amount_mid >= 500_000:      signal_str += 10
        if 'Armed Services' in committee or 'Intelligence' in committee: signal_str += 10
        if is_sell: signal_str -= 10   # sells less predictive

        signal_str = min(80, signal_str)

        direction = 'LONG' if is_buy else 'SHORT'
        region = 'US'
        if ticker in ENERGY_TICKERS: region = 'GLOBAL'

        ee_asset = TICKER_TO_EE.get(ticker, ticker)
        assets   = [ee_asset] if ee_asset in TRACKED_TICKERS else []
        if ticker in DEFENSE_TICKERS: assets += ['LMT', 'RTX', 'XAR']
        if ticker in ENERGY_TICKERS:  assets += ['WTI', 'BRENTOIL', 'XLE']

        party_str = f'({party}-{chamber[:1].upper()})' if party and chamber else ''
        amt_fmt   = f'${amount_mid/1_000:.0f}K' if amount_mid < 1_000_000 else f'${amount_mid/1_000_000:.1f}M'

        ts_raw = t.get('disclosure_date') or t.get('traded_date') or t.get('created_at')
        try:
            from datetime import datetime
            ts_parsed = int(datetime.strptime(ts_raw[:10], '%Y-%m-%d').timestamp() * 1000) if ts_raw else 0
            ts = ts_parsed if _TS_MIN_MS <= ts_parsed <= _TS_MAX_MS else int(time.time() * 1000)
        except Exception:
            ts = int(time.time() * 1000)

        events.append({
            'title':    f'Congress {tx_type.title()}: {politician} {party_str} → {ticker} {amt_fmt}',
            'desc':     (
                f'{politician} {party_str} disclosed a {tx_type} of {ticker} '
                f'worth approx {amt_fmt}. '
                f'{"Defense-sector trade with policy implications. " if ticker in DEFENSE_TICKERS else ""}'
                f'{"Energy-sector trade — geopolitical supply signal. " if ticker in ENERGY_TICKERS else ""}'
                f'{"Committee: " + committee + ". " if committee else ""}'
                f'Direction implied: {direction}.'
            ),
            'source':   'UW/Congress',
            'ts':       ts,
            'region':   region,
            'keywords': ['congress', 'insider', tx_type.replace(' ', '_'),
                         'defense_sector' if ticker in DEFENSE_TICKERS else 'equity',
                         'political_signal'],
            'assets':   list(set(assets)),
            'signal':   signal_str,
            'srcCount': 1,
            'socialV':  min(0.8, amount_mid / 500_000),
            'uw_type':      'congress',
            'uw_ticker':    ticker,
            'uw_direction': direction,
            'uw_politician': politician,
            'uw_party':     party,
            'uw_amount':    amount_mid,
            'uw_tx_type':   tx_type,
            'uw_committee': committee,
        })

    print(f'[UW] congress: {len(trades)} fetched, {len(events)} relevant')
    return events


def _parse_amount(s: str) -> float:
    """Parse UW amount range strings like '$15,001 - $50,000' to midpoint."""
    import re
    nums = [float(x.replace(',', '')) for x in re.findall(r'[\d,]+', str(s))]
    if len(nums) >= 2:
        return (nums[0] + nums[1]) / 2
    elif len(nums) == 1:
        return nums[0]
    return 0.0


# ─────────────────────────────────────────────────────────────────────────────
# 4. MARKET TIDE — net options premium flow direction
# ─────────────────────────────────────────────────────────────────────────────

def fetch_market_tide(api_key: str) -> Optional[Dict]:
    """
    Fetch market-wide net premium tide (calls vs puts dollar flow).
    Returns a structured tide dict consumed by the pipeline regime detector.
    Negative tide = more put premium = bearish institutional positioning.
    """
    data = _get(api_key, '/api/market/tide')
    if not data:
        return None

    tide_data = data.get('data', data if isinstance(data, list) else [])

    # API may return a list of time-bucketed snapshots — take the most recent
    if isinstance(tide_data, list) and tide_data:
        latest = tide_data[-1]
    elif isinstance(tide_data, dict):
        latest = tide_data
    else:
        return None

    call_prem = float(latest.get('call_premium') or latest.get('calls_premium') or 0)
    put_prem  = float(latest.get('put_premium')  or latest.get('puts_premium')  or 0)
    net       = call_prem - put_prem
    total     = call_prem + put_prem

    if total == 0:
        return None

    bull_pct = call_prem / total * 100
    tide_pct = net / total * 100  # +100 = all calls, -100 = all puts

    label = (
        'STRONGLY_BULLISH' if tide_pct >  30 else
        'BULLISH'          if tide_pct >  10 else
        'NEUTRAL'          if tide_pct > -10 else
        'BEARISH'          if tide_pct > -30 else
        'STRONGLY_BEARISH'
    )

    print(f'[UW] market_tide: net={net/1e6:.1f}M calls={call_prem/1e6:.1f}M puts={put_prem/1e6:.1f}M label={label}')

    return {
        'call_premium': call_prem,
        'put_premium':  put_prem,
        'net_premium':  net,
        'bull_pct':     bull_pct,
        'tide_pct':     tide_pct,
        'label':        label,
        'ts':           int(time.time() * 1000),
    }


# ─────────────────────────────────────────────────────────────────────────────
# 5. IV RANK — implied volatility rank per asset
# ─────────────────────────────────────────────────────────────────────────────

IV_TICKERS = ['SPY', 'QQQ', 'VXX', 'GLD', 'TLT', 'XLE', 'XAR',
              'LMT', 'RTX', 'NOC', 'NVDA', 'TSLA', 'AAPL', 'MSFT']

def fetch_iv_ranks(api_key: str) -> Dict[str, float]:
    """
    Fetch IV rank (0–100) for each tracked ticker.
    High IV rank (>80) = options expensive relative to history = risk-off signal.
    Low IV rank (<20)  = options cheap = potential vol expansion ahead.
    Returns dict: { 'SPY': 45.2, 'QQQ': 38.1, ... }
    """
    iv_map = {}
    for ticker in IV_TICKERS:
        data = _get(api_key, f'/api/stock/{ticker}/iv-rank')
        if not data:
            continue
        iv_data = data.get('data', data)
        if isinstance(iv_data, dict):
            rank = (
                iv_data.get('iv_rank') or
                iv_data.get('ivRank') or
                iv_data.get('rank')
            )
            if rank is not None:
                iv_map[ticker] = float(rank)
        elif isinstance(iv_data, list) and iv_data:
            rank = iv_data[-1].get('iv_rank') or iv_data[-1].get('rank')
            if rank is not None:
                iv_map[ticker] = float(rank)

    print(f'[UW] iv_ranks: {len(iv_map)} tickers fetched')
    return iv_map
