"""
GeoIntel Backend — Configuration
All tunable constants in one place.
"""
import os

# Load .env file if present (so you don't need to set env vars manually)
_env_path = os.path.join(os.path.dirname(__file__), '.env')
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith('#') and '=' in _line:
                _k, _v = _line.split('=', 1)
                os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

# ── Server ──────────────────────────────────────────────────────────────────
HOST            = '127.0.0.1'   # localhost only — prevents network exposure of trade data
PORT            = int(os.getenv('PORT', 8765))   # Render/cloud sets $PORT; local default 8765
CYCLE_SECONDS   = 60          # pipeline polling interval
MAX_EVENTS_DB   = 5000        # SQLite rows to keep
SSE_KEEPALIVE   = 25          # seconds between SSE heartbeats

# ── Storage ─────────────────────────────────────────────────────────────────
DB_PATH         = os.path.join(os.path.dirname(__file__), 'events.db')

# ── Optional API keys (set via environment variables) ───────────────────────
ALPHA_VANTAGE_KEY    = os.getenv('AV_KEY', '')              # alphavantage.co
NEWS_API_KEY         = os.getenv('NEWS_API_KEY', '')        # newsapi.org
FRED_KEY             = os.getenv('FRED_KEY', '')            # fred.stlouisfed.org (free)
ACLED_EMAIL          = os.getenv('ACLED_EMAIL', '')         # your myACLED login email
ACLED_PASSWORD       = os.getenv('ACLED_PASSWORD', '')      # kept for reference (OAuth deprecated)
ACLED_KEY            = os.getenv('ACLED_KEY', '')           # API key from acleddata.com/account
EVENTREGISTRY_KEY    = os.getenv('EVENTREGISTRY_KEY', '')   # eventregistry.org (free tier)
TWITTER_BEARER       = os.getenv('TWITTER_BEARER', '')      # developer.twitter.com (free basic)
SENTINEL_CLIENT_ID   = os.getenv('SENTINEL_CLIENT_ID', '')  # dataspace.copernicus.eu (free)
SENTINEL_CLIENT_SEC  = os.getenv('SENTINEL_CLIENT_SEC', '') # dataspace.copernicus.eu (free)
PLANET_API_KEY       = os.getenv('PLANET_API_KEY', '')      # insights.planet.com (trial)
AIS_API_KEY          = os.getenv('AIS_API_KEY', '')         # aisstream.io (free)
OTX_KEY              = os.getenv('OTX_KEY', '')             # otx.alienvault.com (free)
PROPUBLICA_KEY       = os.getenv('PROPUBLICA_KEY', '')      # propublica.org/datastore (free)
GFW_KEY              = os.getenv('GFW_KEY', '')             # globalforestwatch.org (free)
NASA_FIRMS_KEY       = os.getenv('NASA_FIRMS_KEY', '')      # firms.modaps.eosdis.nasa.gov (free, register at firms.modaps.eosdis.nasa.gov/api/)
EIA_KEY              = os.getenv('EIA_KEY', '')             # eia.gov/opendata (free)

# UW key: loaded from uw_config.json (browser-entered) first, then env var.
# This lets the key be set via the dashboard without a backend restart.
_uw_config_file = os.path.join(os.path.dirname(__file__), 'uw_config.json')
try:
    import json as _json
    with open(_uw_config_file) as _f:
        _uw_saved = _json.load(_f)
    UW_API_KEY = _uw_saved.get('uw_api_key') or os.getenv('UW_API_KEY', '')
except Exception as e:
    print(f'[CONFIG] Could not load UW API key from disk: {e}')
    UW_API_KEY = os.getenv('UW_API_KEY', '')

# ── GDELT ───────────────────────────────────────────────────────────────────
GDELT_URL = (
    'https://api.gdeltproject.org/api/v2/doc/doc'
    '?query=(military+OR+sanctions+OR+nuclear+OR+missile+OR+troops+OR+war'
    '+OR+invasion+OR+airstrike+OR+conflict)'
    '+sourcelang:English'
    '&mode=artlist&maxrecords=20&format=json&sort=DateDesc&timespan=1h'
)

# ── RSS Feeds ────────────────────────────────────────────────────────────────
# Organised by tier so intent is clear when adding/removing feeds.
# Tier 1 — major wire services / global outlets (highest corroboration value)
# Tier 2 — specialist defence / geopolitics outlets
# Tier 3 — regional outlets (add corroboration for specific theatres)
RSS_FEEDS = [
    # ── Tier 1: Wire services & global broadcasters ───────────────────────
    ('https://feeds.bbci.co.uk/news/world/rss.xml',                'BBC'),
    ('https://www.france24.com/en/rss',                            'FRANCE24'),  # replaces Reuters
    ('https://api.axios.com/feed/',                                'AXIOS'),     # replaces AP
    ('https://www.aljazeera.com/xml/rss/all.xml',                  'ALJAZ'),
    ('https://www.theguardian.com/world/rss',                      'GUARDIAN'),
    ('https://rss.dw.com/xml/rss-en-world',                       'DW'),
    ('https://feeds.npr.org/1004/rss.xml',                        'NPR'),
    # ── Tier 2: Defence & geopolitics specialists ─────────────────────────
    ('https://taskandpurpose.com/feed/',                           'TASKPURP'), # replaces BRKDEF (403)
    ('https://www.defensenews.com/arc/outboundfeeds/rss/',         'DEFNEWS'),
    ('https://warontherocks.com/feed/',                            'WOTR'),
    ('https://foreignpolicy.com/feed/',                            'FP'),
    ('https://www.rfi.fr/en/rss',                                 'RFI'),      # replaces GLOBSEC
    # ── Tier 3: Regional specialists (Ukraine / ME / Asia / S.Asia) ──────
    ('https://www.themoscowtimes.com/rss/news',                    'MOSNEWS'),  # replaces KYIV
    ('https://www.jpost.com/rss/rssfeedsheadlines.aspx',          'JPOST'),
    ('https://www.middleeasteye.net/rss',                          'MEE'),
    ('https://www.timesofisrael.com/feed/',                        'TOI'),
    ('https://english.alaraby.co.uk/rss.xml',                      'ALARABY'),
    ('https://thediplomat.com/feed/',                              'DIPLOMAT'),
    ('https://www.scmp.com/rss/91/feed',                          'SCMP'),
    ('https://www.dawn.com/feeds/home',                            'DAWN'),
    # ── Government press releases ─────────────────────────────────────────
    ('https://www.whitehouse.gov/feed/',                           'WHITEHOUSE'),
    ('https://www.gov.uk/search/news-and-communications.atom',     'UKGOV'),
    # ── International organisations ───────────────────────────────────────
    ('https://news.un.org/feed/subscribe/en/news/all/rss.xml',    'UNNEWS'),
]

# ── Non-English RSS feeds (require translation) ───────────────────────────────
# Format: (url, source_tag, language_code)
# Language codes: 'ar' = Arabic, 'ru' = Russian, 'zh' = Mandarin, 'fr' = French
MULTILANG_FEEDS = [
    # ── Arabic — Middle East primary sources (often break stories 1-4h before English) ──
    ('https://www.aljazeera.net/xml/rss/all.xml',                   'ALJAZ_AR',  'ar'),
    ('https://arabic.rt.com/rss/',                                  'RT_AR',     'ar'),  # low weight (state-adj)
    ('https://www.bbc.com/arabic/index.xml',                        'BBC_AR',    'ar'),
    # ── Russian — independent coverage (Meduza is exiled independent press) ──
    ('https://meduza.io/rss/all',                                   'MEDUZA',    'ru'),
    ('https://inosmi.ru/export/rss2/index.xml',                     'INOSMI',    'ru'),
    # ── French — European/African coverage (often ahead of English-only outlets) ──
    ('https://www.lemonde.fr/international/rss_full.xml',           'LEMONDE',   'fr'),
    ('https://www.liberation.fr/arc/outboundfeeds/rss/?outputType=xml', 'LIBE',  'fr'),
]

# ── Reddit ───────────────────────────────────────────────────────────────────
REDDIT_SUBS = [
    'geopolitics',
    'worldnews',
    'CredibleDefense',
    'UkraineWarVideoReport',
    'europe',
]
REDDIT_UA = 'GeoDash/1.0 (contact: geodash@localhost)'

# ── Market data ──────────────────────────────────────────────────────────────
COINGECKO_URL = (
    'https://api.coingecko.com/api/v3/simple/price'
    '?ids=bitcoin,ethereum'
    '&vs_currencies=usd'
    '&include_24hr_change=true'
    '&include_1h_change=true'
    '&precision=2'
)

# Yahoo Finance unofficial endpoint (no key required)
YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols={symbols}'

# Ticker → Yahoo Finance symbol mapping
YAHOO_SYMBOLS = {
    'WTI':   'CL=F',    # WTI Crude Oil Futures
    'BRENT': 'BZ=F',    # Brent Crude Oil Futures
    'GLD':   'GC=F',    # Gold Futures
    'WHT':   'ZW=F',    # Wheat Futures
    'GAS':   'NG=F',    # Natural Gas Futures
    'LMT':   'LMT',     # Lockheed Martin
    'TSM':   'TSM',     # Taiwan Semiconductor
    'SPY':   'SPY',     # S&P 500 ETF
    # ── Macro fear / regime indicators ───────────────────────────────────────
    'VIX':   '^VIX',     # CBOE Volatility Index — fear gauge
    'DXY':   'DX-Y.NYB', # US Dollar Index — safe-haven flows
    'US10Y': '^TNX',     # 10-Year Treasury Yield — risk-off signal
}

# HTTP headers for requests that require a browser-like UA
BROWSER_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/120.0.0.0 Safari/537.36'
    ),
    'Accept': 'application/json, text/html, */*',
}
