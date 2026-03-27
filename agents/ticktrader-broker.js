/* ═══════════════════════════════════════════════════════════════════════════
   TICKTRADER-BROKER v2 — TickTrader (Soft-FX) adapter for forex majors
   ═══════════════════════════════════════════════════════════════════════════
   Connects to any TickTrader-powered broker via their REST Web API.
   Uses Web API Token authentication (HMAC-SHA256) — NOT login/password.

   Common broker API base URLs:
     FXOpen Live:  https://ttapi.fxopen.com
     FXOpen Demo:  https://ttdemoapi.fxopen.com

   Auth method : Web API Token Key + Secret → HMAC-SHA256 signed headers
   Auth header : Authorization: TTWSID {tokenKey}:{timestamp}:{signature}
   Signature   : Base64( HMAC-SHA256(tokenSecret, timestamp) )

   Usage:
     TTBroker.connect(brokerUrl, tokenKey, tokenSecret, demo)
     TTBroker.covers('EURUSD')        → true / false
     TTBroker.placeOrder(asset, sizeUsd, dir, trade)
     TTBroker.closePosition(asset, positionId)
     TTBroker.status()

   Exposed as window.TTBroker
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var STORE_KEY = 'ticktrader_cfg_v2';

  /* ── Forex pairs handled by TickTrader ────────────────────────────────────
     Keys are the EE canonical asset names that appear in signals.
     Values are the TickTrader symbol name (no slash).                       */
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

  /* ── Config state ─────────────────────────────────────────────────────── */
  var _cfg = {
    brokerUrl:   'https://ttlivewebapi.fxopen.net:8443',
    tokenId:     '',       // Web API ID (UUID from FXOpen credentials page)
    tokenKey:    '',       // Web API Key
    tokenSecret: '',       // Web API Secret (used for HMAC signing)
    accountId:   '',
    balance:     null,
    currency:    'USD',
    connected:   false,
    demo:        true,
    connectedAt: null
  };

  /* ── HMAC-SHA256 signing (SubtleCrypto — available on localhost) ───────── */
  /* FXOpen TickTrader Web API auth format:
     Authorization: HMAC {WebApiId}:{WebApiKey}:{timestamp_ms}:{signature}
     Signed string: timestamp_ms + WebApiId + WebApiKey + METHOD + fullURL + body */
  async function _buildAuthHeader(method, fullUrl, body) {
    var timestamp = Date.now().toString();
    var msgStr    = timestamp + _cfg.tokenId + _cfg.tokenKey + (method || 'GET') +
                    fullUrl + (body || '');
    var enc       = new TextEncoder();
    var keyData   = enc.encode(_cfg.tokenSecret);
    var msgData   = enc.encode(msgStr);

    var cryptoKey = await crypto.subtle.importKey(
      'raw', keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['sign']
    );
    var sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    var sigB64 = btoa(String.fromCharCode.apply(null, new Uint8Array(sigBuf)));

    return 'HMAC ' + _cfg.tokenId + ':' + _cfg.tokenKey + ':' + timestamp + ':' + sigB64;
  }

  async function _headers(method, path, body) {
    var h = { 'Content-Type': 'application/json' };
    if (_cfg.tokenId && _cfg.tokenKey && _cfg.tokenSecret) {
      var fullUrl = _base() + path;
      h['Authorization'] = await _buildAuthHeader(method || 'GET', fullUrl, body || '');
    }
    return h;
  }

  function _base() {
    return (_cfg.brokerUrl || '').replace(/\/$/, '');
  }

  async function _api(path, opts) {
    var method = (opts && opts.method) || 'GET';
    var body   = (opts && opts.body)   || '';
    var url    = _base() + path;
    var hdrs   = await _headers(method, path, body);
    var res    = await fetch(url, Object.assign({ headers: hdrs }, opts || {}));
    if (!res.ok) {
      var txt = await res.text().catch(function () { return ''; });
      throw new Error('TTBroker ' + res.status + ': ' + txt.substring(0, 200));
    }
    return res.json();
  }

  /* ── Persistence ─────────────────────────────────────────────────────── */
  function _loadCfg() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (s.brokerUrl)   _cfg.brokerUrl   = s.brokerUrl;
      if (s.tokenId)     _cfg.tokenId     = s.tokenId;
      if (s.tokenKey)    _cfg.tokenKey    = s.tokenKey;
      if (s.tokenSecret) _cfg.tokenSecret = s.tokenSecret;
      if (s.demo !== undefined) _cfg.demo = s.demo;
    } catch (e) {}
  }

  function _saveCfg() {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      brokerUrl:   _cfg.brokerUrl,
      tokenId:     _cfg.tokenId,
      tokenKey:    _cfg.tokenKey,
      tokenSecret: _cfg.tokenSecret,
      demo:        _cfg.demo
    }));
  }

  /* ── Unit sizing ─────────────────────────────────────────────────────── */
  async function _calcUnits(ttSymbol, sizeUsd, dir) {
    var price = await _getMidPrice(ttSymbol);
    if (!price || price <= 0) throw new Error('No price for ' + ttSymbol);
    var baseIsUSD = ttSymbol.indexOf('USD') === 0;
    var rawUnits  = baseIsUSD ? sizeUsd : sizeUsd / price;
    var units     = Math.max(100, Math.round(rawUnits / 100) * 100);
    return dir === 'SHORT' ? -units : units;
  }

  async function _getMidPrice(ttSymbol) {
    try {
      // GET /api/v2/level2/{filter} — returns Level2 snapshot for symbol
      var data = await _api('/api/v2/level2/' + ttSymbol);
      // Response is an array; find matching symbol entry
      var entry = Array.isArray(data) ? data.find(function(x){ return x.Symbol === ttSymbol; }) : data;
      if (entry && entry.Bids && entry.Asks && entry.Bids.length && entry.Asks.length) {
        return (parseFloat(entry.Bids[0].Price) + parseFloat(entry.Asks[0].Price)) / 2;
      }
      // Fallback: GET /api/v2/tick/{filter} — best bid/ask tick
      var ticks = await _api('/api/v2/tick/' + ttSymbol);
      var tick  = Array.isArray(ticks) ? ticks.find(function(x){ return x.Symbol === ttSymbol; }) : ticks;
      if (tick && tick.Bid && tick.Ask) return (parseFloat(tick.Bid) + parseFloat(tick.Ask)) / 2;
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
            _cfg.brokerUrl.replace('https://','').split('/')[0].substring(0, 26) + '</span>' : '') +
        '</div>' +
        '<button onclick="TTBroker.disconnect()" ' +
          'style="' + btnBase + ';border:1px solid #ff4444;background:transparent;color:#ff4444">' +
          'Disconnect' +
        '</button>';
    } else {
      card.innerHTML =
        '<div class="ee-broker-name">TickTrader</div>' +
        '<div class="ee-broker-assets">Forex majors &middot; FXOpen / any TickTrader broker</div>' +
        '<div style="margin-bottom:4px">' +
          '<input id="ttUrl" type="text" placeholder="Broker API URL" ' +
            'value="' + (_cfg.brokerUrl || 'https://ttdemowebapi.soft-fx.com:8443') + '" style="' + inputStyle + '">' +
          '<input id="ttId" type="text" placeholder="Web API ID (UUID)" ' +
            'value="' + (_cfg.tokenId || '') + '" style="' + inputStyle + '">' +
          '<input id="ttKey" type="text" placeholder="Web API Key" ' +
            'value="' + (_cfg.tokenKey || '') + '" style="' + inputStyle + '">' +
          '<input id="ttSecret" type="password" placeholder="Web API Secret" ' +
            'value="' + (_cfg.tokenSecret ? '••••••••' : '') + '" style="' + inputStyle + '" ' +
            'data-filled="' + (_cfg.tokenSecret ? '1' : '0') + '">' +
          '<label style="font-size:7px;color:var(--dim);cursor:pointer">' +
            '<input id="ttDemo" type="checkbox" ' + (_cfg.demo ? 'checked' : '') + ' ' +
              'style="margin-right:3px"> Demo / practice account' +
          '</label>' +
        '</div>' +
        '<button onclick="TTBroker._connectFromUI()" ' +
          'style="' + btnBase + ';border:1px solid var(--accent);background:transparent;color:var(--accent)">' +
          (_cfg.tokenKey ? 'Reconnect' : 'Connect') +
        '</button>' +
        '<div id="ttStatus" style="font-size:7px;color:var(--dim);margin-top:2px;min-height:10px"></div>';
    }
  }

  /* ── Public API ───────────────────────────────────────────────────────── */
  var TTBroker = {
    name:    'TICKTRADER',
    version: 2,

    isConnected: function () { return _cfg.connected; },
    isDemo:      function () { return _cfg.demo; },

    covers: function (asset) {
      return Object.prototype.hasOwnProperty.call(TT_PAIRS, String(asset).toUpperCase());
    },

    toTTSymbol: function (eeAsset) {
      return TT_PAIRS[String(eeAsset).toUpperCase()] || null;
    },

    /* Connect using Web API token key + secret */
    connect: async function (brokerUrl, tokenId, tokenKey, tokenSecret, demo) {
      _cfg.brokerUrl   = (brokerUrl   || '').trim().replace(/\/$/, '');
      _cfg.tokenId     = (tokenId     || '').trim();
      _cfg.tokenKey    = (tokenKey    || '').trim();
      _cfg.tokenSecret = (tokenSecret || '').trim();
      _cfg.demo        = demo !== false;

      try {
        /* Verify credentials by fetching account info — no separate login step needed */
        var acct = await _api('/api/v2/account');
        _cfg.accountId = acct.Id         || acct.AccountId || '';
        _cfg.balance   = acct.Balance    !== undefined ? acct.Balance
                       : acct.Equity     !== undefined ? acct.Equity : null;
        _cfg.currency  = acct.Currency   || acct.BalanceCurrency || 'USD';

        _cfg.connected   = true;
        _cfg.connectedAt = Date.now();
        _saveCfg();
        _renderCard();
        return { ok: true, account: acct };
      } catch (e) {
        _cfg.connected = false;
        _renderCard();
        return { ok: false, error: e.message };
      }
    },

    /* Called by the Connect button in the card */
    _connectFromUI: async function () {
      var urlEl    = document.getElementById('ttUrl');
      var idEl     = document.getElementById('ttId');
      var keyEl    = document.getElementById('ttKey');
      var secEl    = document.getElementById('ttSecret');
      var demoEl   = document.getElementById('ttDemo');
      var stEl     = document.getElementById('ttStatus');
      if (!urlEl || !keyEl || !secEl) return;

      /* If secret field shows placeholder dots, use the stored secret */
      var secret = secEl.value;
      if (secret === '••••••••' || (secEl.dataset.filled === '1' && !secret)) {
        secret = _cfg.tokenSecret;
      }

      if (stEl) { stEl.style.color = 'var(--dim)'; stEl.textContent = 'Connecting…'; }

      var result = await TTBroker.connect(
        urlEl.value, idEl ? idEl.value : _cfg.tokenId,
        keyEl.value, secret,
        demoEl ? demoEl.checked : true
      );
      if (!result.ok && stEl) {
        stEl.style.color = '#ff4444';
        stEl.textContent = result.error || 'Connection failed';
      }
    },

    disconnect: function () {
      _cfg.connected = false;
      _saveCfg();
      _renderCard();
    },

    renderCard: _renderCard,

    getAccount: async function () {
      var acct = await _api('/api/v2/account');
      _cfg.balance  = acct.Balance !== undefined ? acct.Balance : acct.Equity;
      _cfg.currency = acct.Currency || _cfg.currency;
      return acct;
    },

    getPrice: async function (eeAsset) {
      var sym = TTBroker.toTTSymbol(eeAsset);
      if (!sym) return null;
      return _getMidPrice(sym);
    },

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

      if (trade && trade.take_profit && trade.take_profit > 0) {
        body.TakeProfit = +trade.take_profit.toFixed(5);
      }
      if (trade && trade.stop_loss && trade.stop_loss > 0) {
        body.StopLoss = +trade.stop_loss.toFixed(5);
      }

      var bodyStr = JSON.stringify(body);
      var res = await _api('/api/v2/trade', {
        method: 'POST',
        body:   bodyStr
      });

      // Response contains the created/filled trade object
      var posId = (res && res.Id) || (res && res.Position && res.Position.Id) || null;
      return { id: String(posId || ''), status: 'FILLED', raw: res };
    },

    closePosition: async function (eeAsset, positionId) {
      // DELETE /api/v2/trade with body { "Type": "Close", "Id": positionId }
      // If no positionId, close all positions for this symbol via Type: "CloseBy"
      var sym = TTBroker.toTTSymbol(eeAsset);
      try {
        if (positionId) {
          await _api('/api/v2/trade', {
            method: 'DELETE',
            body:   JSON.stringify({ Type: 'Close', Id: parseInt(positionId, 10) || positionId })
          });
        } else if (sym) {
          // Close all open positions for this symbol
          await _api('/api/v2/trade', {
            method: 'DELETE',
            body:   JSON.stringify({ Type: 'CloseAll', Symbol: sym })
          });
        }
      } catch (e) { /* best effort */ }
    },

    status: function () {
      var pairCount = Object.keys(TT_PAIRS).filter(function (k) { return k.length === 6; }).length;
      return {
        connected:   _cfg.connected,
        demo:        _cfg.demo,
        balance:     _cfg.balance,
        currency:    _cfg.currency,
        brokerUrl:   _cfg.brokerUrl,
        keyHint:     _cfg.tokenKey ? _cfg.tokenKey.substring(0, 6) + '…' : '',
        pairCount:   pairCount,
        connectedAt: _cfg.connectedAt,
        note: _cfg.connected
          ? (_cfg.demo ? 'Demo' : 'Live') + ' · ' + _cfg.currency + ' ' +
            (_cfg.balance !== null ? parseFloat(_cfg.balance).toFixed(0) : '—') +
            ' · ' + pairCount + ' pairs'
          : 'Not connected'
      };
    },

    signals: function () { return []; }
  };

  /* ── Init ─────────────────────────────────────────────────────────────── */
  _loadCfg();

  /* Pre-load credentials if passed in via hardcoded bootstrap (set below) */
  if (window._TT_BOOTSTRAP) {
    _cfg.brokerUrl   = window._TT_BOOTSTRAP.brokerUrl   || _cfg.brokerUrl;
    _cfg.tokenId     = window._TT_BOOTSTRAP.tokenId     || _cfg.tokenId;
    _cfg.tokenKey    = window._TT_BOOTSTRAP.tokenKey    || _cfg.tokenKey;
    _cfg.tokenSecret = window._TT_BOOTSTRAP.tokenSecret || _cfg.tokenSecret;
    _cfg.demo        = window._TT_BOOTSTRAP.demo !== undefined
                       ? window._TT_BOOTSTRAP.demo : _cfg.demo;
    delete window._TT_BOOTSTRAP;
    _saveCfg();
  }

  window.TTBroker         = TTBroker;
  window.TickTraderBroker = TTBroker;  // alias for agent status panel

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      _renderCard();
      /* Auto-connect if we have credentials saved */
      if (_cfg.tokenKey && _cfg.tokenSecret && !_cfg.connected) {
        TTBroker.connect(_cfg.brokerUrl, _cfg.tokenId, _cfg.tokenKey, _cfg.tokenSecret, _cfg.demo)
          .then(function (r) {
            if (!r.ok) console.warn('TTBroker auto-connect failed:', r.error);
          });
      }
    });
  } else {
    _renderCard();
    if (_cfg.tokenKey && _cfg.tokenSecret && !_cfg.connected) {
      TTBroker.connect(_cfg.brokerUrl, _cfg.tokenId, _cfg.tokenKey, _cfg.tokenSecret, _cfg.demo)
        .then(function (r) {
          if (!r.ok) console.warn('TTBroker auto-connect failed:', r.error);
        });
    }
  }

})();
