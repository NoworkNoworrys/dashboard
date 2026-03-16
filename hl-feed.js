/* ══════════════════════════════════════════════════════════════════════════════
   HL-FEED — Hyperliquid Real-Time Price Feed
   ══════════════════════════════════════════════════════════════════════════════
   Connects to Hyperliquid's WebSocket (wss://api.hyperliquid.xyz/ws) and
   subscribes to the allMids channel, which streams mid-prices for all 300+
   trading pairs including WTI, Brent crude, Gold, Silver, BTC/ETH, and
   150+ US equities.

   Prices are injected into the Execution Engine via EE.injectPrice() so
   monitorTrades() uses real market data instead of stale HTTP polls.

   Public API: window.HLFeed
     .status()    → { connected, lastTs, pairsReceived, injected, errors }
     .tickers()   → object of last known prices keyed by HL ticker
     .restart()   → force a reconnect
   ══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var HL_WS_URL    = 'wss://api.hyperliquid.xyz/ws';
  var RECONNECT_MS = 12000;   // 12 s between reconnect attempts
  var MAX_ERRORS   = 10;      // give up logging after this many consecutive parse errors

  /* ── HL ticker → EE asset name(s) to cache ─────────────────────────────────
     Only include assets the bot actually trades (from IMPACT_MAP).
     CL  = WTI Crude  |  BRENTOIL = Brent  |  GOLD = spot gold  |  SILVER = spot silver
     NOTE: GLD (SPDR ETF ≈ 1/10 oz) is intentionally excluded — its USD price is
     ~$275 while spot GOLD is ~$3,000. Injecting spot GOLD price as GLD would cause
     a 10× position-sizing error. GLD continues to use Yahoo Finance prices.      */
  var HL_MAP = {
    /* Commodities */
    'CL':          ['WTI', 'OIL', 'CRUDE'],
    'BRENTOIL':    ['BRENT'],
    'GOLD':        ['GOLD', 'XAU'],
    'SILVER':      ['SILVER', 'XAG', 'SLV'],

    /* Crypto */
    'BTC':         ['BTC', 'BITCOIN'],
    'ETH':         ['ETH', 'ETHEREUM'],
    'SOL':         ['SOL'],
    'XRP':         ['XRP'],

    /* Rates / macro proxies */
    'UNIBTC':      [],    // placeholder — excluded

    /* US Equities that appear in IMPACT_MAP */
    'NVDA':        ['NVDA'],
    'TSM':         ['TSM'],
    'AAPL':        ['AAPL'],
    'TSLA':        ['TSLA'],
    'SPY':         ['SPY'],
    'QQQ':         ['QQQ'],
    'LMT':         ['LMT'],
    'RTX':         ['RTX'],
    'NOC':         ['NOC'],
    'SMH':         ['SMH'],
    'GDX':         ['GDX'],
    'XLE':         ['XLE'],
    'FXI':         ['FXI'],
    'VIX':         ['VIX']
  };

  /* ── State ─────────────────────────────────────────────────────────────────── */
  var _ws            = null;
  var _connected     = false;
  var _lastTs        = null;
  var _pairsReceived = 0;      // total unique tickers seen
  var _injected      = 0;      // total EE.injectPrice() calls made
  var _errors        = 0;
  var _reconnectTimer = null;
  var _lastPrices    = {};     // { 'CL': '73.50', ... }
  var _eeReady       = false;

  /* ── Wait until EE is available ─────────────────────────────────────────────── */
  function _checkEE() {
    if (window.EE && typeof window.EE.injectPrice === 'function') {
      _eeReady = true;
      return true;
    }
    return false;
  }

  /* ── Connect / subscribe ─────────────────────────────────────────────────────── */
  function _connect() {
    if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) return;
    if (typeof WebSocket === 'undefined') return;
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }

    try {
      _ws = new WebSocket(HL_WS_URL);

      _ws.onopen = function () {
        _connected = true;
        _errors    = 0;
        /* Subscribe to allMids — one message gives all asset prices */
        _ws.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'allMids' }
        }));
        _log('HL WebSocket connected — allMids feed active');
      };

      _ws.onmessage = function (evt) {
        try {
          var msg = JSON.parse(evt.data);
          /* Ignore subscription acknowledgements */
          if (!msg || msg.channel !== 'allMids' || !msg.data || !msg.data.mids) return;

          var mids = msg.data.mids;   // { 'CL': '73.50', 'GOLD': '3180.00', ... }
          _lastTs = Date.now();
          _pairsReceived = Object.keys(mids).length;

          /* Only inject if EE is ready */
          if (!_eeReady && !_checkEE()) return;

          Object.keys(HL_MAP).forEach(function (hlTicker) {
            var rawStr = mids[hlTicker];
            if (rawStr === undefined || rawStr === null) return;
            var price = parseFloat(rawStr);
            if (!isFinite(price) || price <= 0) return;

            /* Cache the raw HL price for status inspection */
            _lastPrices[hlTicker] = rawStr;

            /* Inject under every EE alias */
            var eeNames = HL_MAP[hlTicker];
            eeNames.forEach(function (eeName) {
              EE.injectPrice(eeName, price);
              _injected++;
            });
          });

        } catch (e) {
          _errors++;
          if (_errors <= MAX_ERRORS) _log('HL parse error: ' + (e.message || String(e)), true);
        }
      };

      _ws.onclose = function () {
        _connected = false;
        _log('HL WebSocket closed — reconnecting in ' + (RECONNECT_MS / 1000) + 's');
        _reconnectTimer = setTimeout(_connect, RECONNECT_MS);
      };

      _ws.onerror = function () {
        _connected = false;
        /* onclose fires after onerror, so reconnect is handled there */
      };

    } catch (e) {
      _log('HL WebSocket unavailable: ' + (e.message || String(e)), true);
      _reconnectTimer = setTimeout(_connect, RECONNECT_MS * 2);
    }
  }

  /* ── Minimal console logger (avoids spamming) ────────────────────────────────── */
  function _log(msg, isWarn) {
    var prefix = '[HL-Feed] ';
    if (typeof console !== 'undefined') {
      if (isWarn) { console.warn(prefix + msg); }
      else        { console.log(prefix + msg);  }
    }
    /* Also push into EE activity log if available */
    if (_eeReady && window.EE && typeof window.EE.render === 'function') {
      /* EE doesn't expose a direct log() call, but the system log is
         visible in the UI — silently skip to avoid noisy injections. */
    }
  }

  /* ── Public API ──────────────────────────────────────────────────────────────── */
  window.HLFeed = {

    /** Current feed status object */
    status: function () {
      return {
        connected:     _connected,
        lastTs:        _lastTs,
        lastUpdate:    _lastTs ? Math.round((Date.now() - _lastTs) / 1000) + 's ago' : 'never',
        pairsReceived: _pairsReceived,
        injected:      _injected,
        errors:        _errors
      };
    },

    /** Live snapshot of last received prices keyed by HL ticker */
    tickers: function () {
      return Object.assign({}, _lastPrices);
    },

    /** Force a reconnect (e.g., after network outage) */
    restart: function () {
      if (_ws) { try { _ws.close(); } catch (e) {} }
      _connected = false;
      _connect();
    }
  };

  /* ── Boot: wait for window.load, start 6 s after to avoid clash with IC bootstrap ── */
  window.addEventListener('load', function () {
    setTimeout(function () {
      _checkEE();
      _connect();
    }, 6000);
  });

}());
