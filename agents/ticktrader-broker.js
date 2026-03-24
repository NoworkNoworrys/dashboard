/* ═══════════════════════════════════════════════════════════════════════════
   TICKTRADER-BROKER v1 — TickTrader (Soft-FX) adapter for forex majors
   ═══════════════════════════════════════════════════════════════════════════
   Connects to any TickTrader-powered broker via their REST Web API.
   The broker URL differs per broker — enter it in the dashboard card.

   Common broker API base URLs (check your broker's API docs):
     FXOpen:    https://ttapi.fxopen.com
     Libertex:  https://trading.libertex.com
     Generic:   https://api.{yourbroker}.com  (ask your broker)

   Auth flow  : POST /api/v2/account/login → {Token}
   Auth header: Authorization: TTWebApiKey {Token}

   Usage:
     TTBroker.connect(brokerUrl, login, password)
     TTBroker.covers('EURUSD')        → true / false
     TTBroker.placeOrder(asset, sizeUsd, dir, trade)
     TTBroker.closePosition(asset, positionId)
     TTBroker.status()

   Exposed as window.TTBroker
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var STORE_KEY = 'ticktrader_cfg_v1';

  /* ── Forex pairs handled by TickTrader ────────────────────────────────────
     Keys are the EE canonical asset names that will appear in signals.
     Values are the TickTrader symbol name (usually identical, no slash).   */
  var TT_PAIRS = {
    /* Majors */
    'EURUSD': 'EURUSD',  'EUR': 'EURUSD',
    'GBPUSD': 'GBPUSD',  'GBP': 'GBPUSD',
    'USDJPY': 'USDJPY',  'JPY': 'USDJPY',
    'USDCHF': 'USDCHF',  'CHF': 'USDCHF',
    'AUDUSD': 'AUDUSD',  'AUD': 'AUDUSD',
    'USDCAD': 'USDCAD',  'CAD': 'USDCAD',
    'NZDUSD': 'NZDUSD',  'NZD': 'NZDUSD',
    /* Minors */
    'GBPJPY': 'GBPJPY',
    'EURJPY': 'EURJPY',
    'EURGBP': 'EURGBP',
    'AUDJPY': 'AUDJPY',
    'CHFJPY': 'CHFJPY',
    'EURCAD': 'EURCAD',
    'EURCHF': 'EURCHF',
  };

  /* ── Config state ────────────────────────────────────────────────────── */
  var _cfg = {
    brokerUrl:   '',       // e.g. "https://ttapi.fxopen.com"
    login:       '',
    password:    '',
    token:       '',
    accountId:   '',
    balance:     null,
    currency:    'USD',
    connected:   false,
    demo:        true,
    connectedAt: null
  };

  /* ── Helpers ─────────────────────────────────────────────────────────── */
  function _base() {
    return (_cfg.brokerUrl || '').replace(/\/$/, '');
  }

  function _headers() {
    var h = { 'Content-Type': 'application/json' };
    if (_cfg.token) h['Authorization'] = 'TTWebApiKey ' + _cfg.token;
    return h;
  }

  async function _api(path, opts) {
    var url = _base() + path;
    var res = await fetch(url, Object.assign({ headers: _headers() }, opts || {}));
    if (!res.ok) {
      var txt = await res.text().catch(function () { return ''; });
      throw new Error('TTBroker ' + res.status + ': ' + txt.substring(0, 200));
    }
    return res.json();
  }

  function _loadCfg() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (s.brokerUrl) _cfg.brokerUrl = s.brokerUrl;
      if (s.login)     _cfg.login     = s.login;
      if (s.demo !== undefined) _cfg.demo = s.demo;
      // Never persist token, password, or connected=true — always re-auth on load
    } catch (e) {}
  }

  function _saveCfg() {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      brokerUrl: _cfg.brokerUrl,
      login:     _cfg.login,
      demo:      _cfg.demo
    }));
  }

  /* Convert EE size_usd → TickTrader units for a given pair.
     For EUR/USD: units are EUR. 1 standard lot = 100,000 units.
     We use raw units (not lots) — TickTrader accepts both.
     Round to nearest 100 units for clean sizing.                         */
  async function _calcUnits(ttSymbol, sizeUsd, dir) {
    var price = await _getMidPrice(ttSymbol);
    if (!price || price <= 0) throw new Error('No price for ' + ttSymbol);
    // For pairs where USD is the quote (e.g. EURUSD): units = sizeUsd / price
    // For pairs where USD is the base (e.g. USDJPY): units = sizeUsd directly
    var baseIsUSD = ttSymbol.indexOf('USD') === 0;
    var rawUnits = baseIsUSD ? sizeUsd : sizeUsd / price;
    // Round to nearest 100, minimum 100
    var units = Math.max(100, Math.round(rawUnits / 100) * 100);
    return dir === 'SHORT' ? -units : units;
  }

  /* Fetch mid-price for a symbol via TickTrader quotes endpoint */
  async function _getMidPrice(ttSymbol) {
    try {
      // TickTrader level1 quote: GET /api/v2/feed/level2/{symbol}
      var data = await _api('/api/v2/feed/level2/' + ttSymbol);
      var bid = data && data.Bid  ? parseFloat(data.Bid[0]  && data.Bid[0][0]  || data.Bid)  : 0;
      var ask = data && data.Ask  ? parseFloat(data.Ask[0]  && data.Ask[0][0]  || data.Ask)  : 0;
      if (bid > 0 && ask > 0) return (bid + ask) / 2;
      // Fallback: level1 snapshot
      var snap = await _api('/api/v2/feed/level1/' + ttSymbol);
      if (snap && snap.Bid && snap.Ask) return (parseFloat(snap.Bid) + parseFloat(snap.Ask)) / 2;
    } catch (e) {}
    return null;
  }

  /* ── Card renderer ────────────────────────────────────────────────────── */
  function _renderCard() {
    var card = document.getElementById('ttBrokerCard');
    if (!card) return;

    var inputStyle = 'width:100%;box-sizing:border-box;font-size:8px;padding:2px 4px;' +
      'background:var(--bg);border:1px solid var(--border);color:var(--bright);' +
      'font-family:inherit;border-radius:2px;margin-bottom:2px';
    var btnBase = 'font-size:8px;width:100%;padding:3px 0;cursor:pointer;font-family:inherit;border-radius:2px';

    if (_cfg.connected) {
      card.innerHTML =
        '<div class="ee-broker-name" style="color:#00ff88">TICKTRADER ' +
          (_cfg.demo
            ? '<span style="color:#ffaa00;font-size:8px">DEMO</span>'
            : '<span style="color:#ff4444;font-size:8px">LIVE</span>') +
        '</div>' +
        '<div class="ee-broker-assets">Forex majors &middot; ' +
          Object.keys(TT_PAIRS).filter(function (k) { return k.length === 6; }).length +
          ' pairs</div>' +
        '<div style="font-size:8px;color:var(--dim);margin-bottom:4px">' +
          'Balance: <b style="color:var(--bright)">' +
            (_cfg.balance !== null ? _cfg.currency + ' ' + parseFloat(_cfg.balance).toFixed(2) : '—') +
          '</b>' +
          (_cfg.brokerUrl ? ' &nbsp; <span style="opacity:0.5">' +
            _cfg.brokerUrl.replace('https://','').split('/')[0].substring(0, 22) + '</span>' : '') +
        '</div>' +
        '<button onclick="TTBroker.disconnect()" ' +
          'style="' + btnBase + ';border:1px solid #ff4444;background:transparent;color:#ff4444">' +
          'Disconnect' +
        '</button>';
    } else {
      var hasInfo = _cfg.brokerUrl && _cfg.login;
      card.innerHTML =
        '<div class="ee-broker-name">TickTrader</div>' +
        '<div class="ee-broker-assets">Forex majors &middot; Any TickTrader broker</div>' +
        '<div style="margin-bottom:4px">' +
          '<input id="ttUrl" type="text" placeholder="Broker API URL  e.g. https://ttapi.fxopen.com" ' +
            'value="' + (_cfg.brokerUrl || '') + '" style="' + inputStyle + '">' +
          '<input id="ttLogin" type="text" placeholder="Login / username" ' +
            'value="' + (_cfg.login || '') + '" style="' + inputStyle + '">' +
          '<input id="ttPassword" type="password" placeholder="Password" style="' + inputStyle + '">' +
          '<label style="font-size:7px;color:var(--dim);cursor:pointer">' +
            '<input id="ttDemo" type="checkbox" ' + (_cfg.demo ? 'checked' : '') + ' ' +
              'style="margin-right:3px"> Demo / practice account' +
          '</label>' +
        '</div>' +
        '<button onclick="TTBroker._connectFromUI()" ' +
          'style="' + btnBase + ';border:1px solid var(--accent);background:transparent;color:var(--accent)">' +
          (hasInfo ? 'Reconnect' : 'Connect') +
        '</button>' +
        '<div style="font-size:7px;color:var(--dim);margin-top:3px">' +
          'Need a broker? Try <b>FXOpen</b> (fxopen.com) — free demo, TickTrader powered.' +
        '</div>' +
        '<div id="ttStatus" style="font-size:7px;color:var(--dim);margin-top:2px;min-height:10px"></div>';
    }
  }

  /* ── Public API ───────────────────────────────────────────────────────── */
  var TTBroker = {
    name:    'TICKTRADER',
    version: 1,

    isConnected: function () { return _cfg.connected; },
    isDemo:      function () { return _cfg.demo; },

    /* Does this broker cover this EE asset? Checked after HLFeed + Alpaca fail. */
    covers: function (asset) {
      return Object.prototype.hasOwnProperty.call(TT_PAIRS, String(asset).toUpperCase());
    },

    /* Map EE asset name → TickTrader symbol */
    toTTSymbol: function (eeAsset) {
      return TT_PAIRS[String(eeAsset).toUpperCase()] || null;
    },

    /* Connect: authenticate and fetch account info */
    connect: async function (brokerUrl, login, password, demo) {
      _cfg.brokerUrl = (brokerUrl || '').trim().replace(/\/$/, '');
      _cfg.login     = (login    || '').trim();
      _cfg.password  = password  || '';
      _cfg.demo      = demo !== false;

      try {
        /* Step 1: Authenticate — POST /api/v2/account/login */
        var authRes = await fetch(_cfg.brokerUrl + '/api/v2/account/login', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ Login: _cfg.login, Password: _cfg.password })
        });
        if (!authRes.ok) {
          var errTxt = await authRes.text().catch(function () { return ''; });
          throw new Error('Login failed (' + authRes.status + '): ' + errTxt.substring(0, 150));
        }
        var authData = await authRes.json();
        _cfg.token = authData.Token || authData.token || '';
        if (!_cfg.token) throw new Error('No token in login response');

        /* Step 2: Fetch account summary */
        var acct = await _api('/api/v2/account');
        _cfg.accountId = acct.Id   || acct.AccountId || '';
        _cfg.balance   = acct.Balance !== undefined ? acct.Balance
                       : acct.Equity  !== undefined ? acct.Equity : null;
        _cfg.currency  = acct.Currency || acct.BalanceCurrency || 'USD';

        _cfg.connected   = true;
        _cfg.connectedAt = Date.now();
        _cfg.password    = '';   // clear from memory
        _saveCfg();
        _renderCard();
        return { ok: true, account: acct };
      } catch (e) {
        _cfg.connected = false;
        _cfg.token     = '';
        return { ok: false, error: e.message };
      }
    },

    /* Called by the Connect button in the card */
    _connectFromUI: async function () {
      var urlEl  = document.getElementById('ttUrl');
      var logEl  = document.getElementById('ttLogin');
      var pwEl   = document.getElementById('ttPassword');
      var demoEl = document.getElementById('ttDemo');
      var stEl   = document.getElementById('ttStatus');
      if (!urlEl || !logEl || !pwEl) return;
      if (stEl) { stEl.style.color = 'var(--dim)'; stEl.textContent = 'Connecting…'; }
      var result = await TTBroker.connect(
        urlEl.value, logEl.value, pwEl.value,
        demoEl ? demoEl.checked : true
      );
      if (!result.ok && stEl) {
        stEl.style.color = '#ff4444';
        stEl.textContent = result.error || 'Connection failed';
      }
    },

    disconnect: function () {
      _cfg.connected = false;
      _cfg.token     = '';
      _saveCfg();
      _renderCard();
    },

    renderCard: _renderCard,

    /* Refresh balance from broker */
    getAccount: async function () {
      var acct = await _api('/api/v2/account');
      _cfg.balance  = acct.Balance !== undefined ? acct.Balance : acct.Equity;
      _cfg.currency = acct.Currency || _cfg.currency;
      return acct;
    },

    /* Latest mid price for an EE asset */
    getPrice: async function (eeAsset) {
      var sym = TTBroker.toTTSymbol(eeAsset);
      if (!sym) return null;
      return _getMidPrice(sym);
    },

    /* Place a market order.
       eeAsset  : EE canonical name, e.g. 'EURUSD'
       sizeUsd  : notional in USD (from trade.size_usd)
       dir      : 'LONG' | 'SHORT'
       trade    : full trade object (for TP/SL prices)              */
    placeOrder: async function (eeAsset, sizeUsd, dir, trade) {
      var sym   = TTBroker.toTTSymbol(eeAsset);
      if (!sym) throw new Error('TTBroker: no symbol mapping for ' + eeAsset);

      var units = await _calcUnits(sym, sizeUsd, dir);
      var side  = units > 0 ? 'Buy' : 'Sell';

      var body = {
        Type:    'Market',
        Symbol:  sym,
        Side:    side,
        Amount:  Math.abs(units),
        Comment: 'GII-' + (trade ? (trade.trade_id || '') : '')
      };

      /* Attach TP / SL prices if available on the trade object */
      if (trade && trade.take_profit && trade.take_profit > 0) {
        body.TakeProfit = +trade.take_profit.toFixed(5);
      }
      if (trade && trade.stop_loss && trade.stop_loss > 0) {
        body.StopLoss = +trade.stop_loss.toFixed(5);
      }

      var res = await _api('/api/v2/trade/orders/market', {
        method: 'POST',
        body:   JSON.stringify(body)
      });

      /* TickTrader returns the filled position ID */
      var posId = (res.Position && res.Position.Id)
               || (res.OrderId)
               || (res.Id)
               || null;

      return {
        id:     String(posId || ''),
        status: 'FILLED',
        raw:    res
      };
    },

    /* Close an open position (all units) */
    closePosition: async function (eeAsset, positionId) {
      if (!positionId) {
        /* Fallback: close by symbol — close all positions for this pair */
        var sym = TTBroker.toTTSymbol(eeAsset);
        if (sym) {
          try {
            await _api('/api/v2/trade/positions/' + sym + '/close', { method: 'DELETE' });
          } catch (e) { /* best effort */ }
        }
        return;
      }
      await _api('/api/v2/trade/positions/' + positionId + '/close', { method: 'DELETE' });
    },

    /* Status summary (mirrors AlpacaBroker.status() interface) */
    status: function () {
      var pairCount = Object.keys(TT_PAIRS).filter(function (k) { return k.length === 6; }).length;
      return {
        connected:   _cfg.connected,
        demo:        _cfg.demo,
        balance:     _cfg.balance,
        currency:    _cfg.currency,
        brokerUrl:   _cfg.brokerUrl,
        loginHint:   _cfg.login ? _cfg.login.substring(0, 4) + '…' : '',
        pairCount:   pairCount,
        connectedAt: _cfg.connectedAt,
        note: _cfg.connected
          ? (_cfg.demo ? 'Demo' : 'Live') + ' · ' + _cfg.currency + ' ' +
            (_cfg.balance !== null ? parseFloat(_cfg.balance).toFixed(0) : '—') +
            ' · ' + pairCount + ' pairs'
          : 'Not connected'
      };
    },

    signals: function () { return []; }  /* execution-only, no signals */
  };

  _loadCfg();
  window.TTBroker = TTBroker;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _renderCard);
  } else {
    setTimeout(_renderCard, 0);
  }

})();
