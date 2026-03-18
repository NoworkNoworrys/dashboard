/* ══════════════════════════════════════════════════════════════════════════════
   UNUSUAL WHALES INTELLIGENCE AGENT  —  v1
   ══════════════════════════════════════════════════════════════════════════════
   Polls the backend UW endpoints and:
     1. Renders the UW Intelligence panel on the dashboard
     2. Injects high-confidence flow + congress signals into the EE pipeline
     3. Adjusts EE risk sizing via IV rank (high IV = reduced position size)
     4. Feeds market tide into the regime indicator

   Backend endpoints consumed:
     GET /api/uw/status        — key status, iv_ranks, latest tide
     GET /api/uw/flow-alerts   — options flow (poll every 90s)
     GET /api/uw/darkpool      — dark pool prints (poll every 5min)
     GET /api/uw/congress      — congress trades (poll every 30min)
     GET /api/uw/tide          — tide time series (poll every 5min)
   ══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var BACKEND    = (location.port === '8765') ? '' : 'http://localhost:8765';
  var PANEL_ID   = 'uwIntelPanel';

  /* ── State ──────────────────────────────────────────────────────────────── */
  var _state = {
    ready:        false,
    keyConfigured: false,
    flowAlerts:   [],
    darkpool:     [],
    congress:     [],
    tide:         null,
    ivRanks:      {},
    lastFlow:     0,
    lastDP:       0,
    lastCong:     0,
    lastTide:     0,
    stats:        {},
  };

  /* ── EE Signal injection ─────────────────────────────────────────────────
     Convert a UW event into an EE-compatible signal and inject it.
     Only injects signals with direction (LONG/SHORT) on tracked assets.    */
  function _injectToEE(evt) {
    if (!window.EE || typeof EE.onSignals !== 'function') return;
    if (!evt.direction || !evt.ticker) return;

    // Map UW signal strength to EE confidence (0–100)
    var conf = Math.min(99, (evt.signal || 50));

    // Build EE signal object
    var sig = {
      asset:  evt.ticker,
      dir:    evt.direction,     // 'LONG' or 'SHORT'
      conf:   conf,
      region: evt.region || 'US',
      reason: evt.title || ('UW signal: ' + evt.ticker),
      from:   'UW/' + (evt.uw_type === 'flow_alert' ? 'FlowAlert' :
               evt.uw_type === 'darkpool' ? 'DarkPool' : 'Congress'),
    };

    EE.onSignals([sig]);
    _log('Injected EE signal: ' + sig.asset + ' ' + sig.dir + ' conf=' + sig.conf + ' from=' + sig.from);
  }

  /* ── IV rank → EE risk adjustment ───────────────────────────────────────
     When SPY or QQQ IV rank is extreme, tell EE to scale risk.
     This uses EE's public API to temporarily adjust max_risk_usd.           */
  function _applyIVRiskAdjustment(ivRanks) {
    if (!window.EE || typeof EE.getConfig !== 'function') return;

    var spyIV = ivRanks['SPY'] || ivRanks['QQQ'] || 50;
    var cfg   = EE.getConfig();
    if (!cfg) return;

    // Already-configured base risk (use as reference, don't mutate original)
    var baseRisk = cfg._uw_base_risk || cfg.max_risk_usd || 100;
    if (!cfg._uw_base_risk) {
      // Store original risk so we can restore it
      cfg._uw_base_risk = baseRisk;
    }

    var scaledRisk;
    if (spyIV >= 85)      scaledRisk = Math.round(baseRisk * 0.50);  // extreme IV — halve risk
    else if (spyIV >= 70) scaledRisk = Math.round(baseRisk * 0.65);  // high IV
    else if (spyIV >= 55) scaledRisk = Math.round(baseRisk * 0.80);  // elevated
    else if (spyIV <= 15) scaledRisk = Math.round(baseRisk * 1.10);  // low IV — can size up slightly
    else                   scaledRisk = baseRisk;                      // normal range — no change

    if (scaledRisk !== cfg.max_risk_usd) {
      var el = document.getElementById('eeCfg_max_risk_usd');
      if (el) {
        el.value = scaledRisk;
        if (typeof EE.updateRiskParams === 'function') {
          EE.updateRiskParams();
          _log('IV rank ' + spyIV.toFixed(0) + '% → EE risk scaled to $' + scaledRisk);
        }
      }
    }
  }

  /* ── Tide → regime broadcast ─────────────────────────────────────────────
     Emit a WATCH signal so the EE log shows the tide shift.                 */
  function _broadcastTide(tide) {
    if (!tide || !window.EE || typeof EE.onSignals !== 'function') return;
    EE.onSignals([{
      asset:  'MARKET',
      dir:    'WATCH',
      conf:   0,
      region: 'GLOBAL',
      reason: '🌊 UW Market Tide: ' + tide.label +
              '  calls=$' + _fmtM(tide.call_premium) +
              '  puts=$'  + _fmtM(tide.put_premium) +
              '  net='    + (tide.net_premium >= 0 ? '+' : '') + _fmtM(tide.net_premium),
      from:   'UW/MarketTide',
    }]);
  }

  /* ── Fetch helpers ────────────────────────────────────────────────────── */
  function _fetch(path, cb) {
    fetch(BACKEND + path)
      .then(function (r) { return r.json(); })
      .then(cb)
      .catch(function (e) { _log('fetch ' + path + ' failed: ' + e.message); });
  }

  /* ── Poll cycle ──────────────────────────────────────────────────────── */
  function _pollFlowAlerts() {
    _fetch('/api/uw/flow-alerts?limit=50&hours=24', function (res) {
      var items = res.data || [];
      var newCount = 0;
      items.forEach(function (a) {
        var isNew = !_state.flowAlerts.some(function (x) {
          return x.id === a.id && x.ts === a.ts;
        });
        if (isNew && a.ts > _state.lastFlow) {
          _state.lastFlow = a.ts;
          // Only inject into EE if high signal + has direction
          if (a.signal >= 60 && a.direction) {
            _injectToEE(a);
          }
          newCount++;
        }
      });
      _state.flowAlerts = items;
      if (newCount > 0) _renderPanel();
    });
  }

  function _pollDarkPool() {
    _fetch('/api/uw/darkpool?limit=20&hours=24', function (res) {
      _state.darkpool = res.data || [];
      _renderPanel();
    });
  }

  function _pollCongress() {
    _fetch('/api/uw/congress?limit=20&days=90', function (res) {
      var items = res.data || [];
      items.forEach(function (c) {
        var isNew = !_state.congress.some(function (x) {
          return x.id === c.id;
        });
        // Congress buys in defense/energy are strong signals — always inject
        if (isNew && c.direction === 'LONG' && c.signal >= 55) {
          _injectToEE(c);
        }
      });
      _state.congress = items;
      _renderPanel();
    });
  }

  function _pollTide() {
    _fetch('/api/uw/tide?hours=8', function (res) {
      var prev = _state.tide;
      _state.tide = res.latest || null;
      // Broadcast regime change to EE log if label changed
      if (_state.tide && (!prev || prev.label !== _state.tide.label)) {
        _broadcastTide(_state.tide);
      }
      _renderPanel();
    });
  }

  function _pollStatus() {
    _fetch('/api/uw/status', function (res) {
      _state.keyConfigured = res.key_configured;
      _state.stats         = res.stats || {};
      _state.ivRanks       = res.iv_ranks || {};
      if (Object.keys(_state.ivRanks).length) {
        _applyIVRiskAdjustment(_state.ivRanks);
      }
      _state.ready = true;
      _renderPanel();
    });
  }

  function _startPolling() {
    _pollStatus();
    _pollFlowAlerts();
    _pollDarkPool();
    _pollCongress();
    _pollTide();

    setInterval(_pollFlowAlerts, 90  * 1000);   // 90s
    setInterval(_pollDarkPool,   5   * 60 * 1000);
    setInterval(_pollTide,       5   * 60 * 1000);
    setInterval(_pollCongress,   30  * 60 * 1000);
    setInterval(_pollStatus,     15  * 60 * 1000);
  }

  /* ── Render ──────────────────────────────────────────────────────────── */
  function _renderPanel() {
    var el = document.getElementById(PANEL_ID);
    if (!el) return;
    el.innerHTML = _buildPanelHTML();
  }

  function _buildPanelHTML() {
    if (!_state.ready) return '<div style="color:var(--dim);font-size:11px;padding:8px">Loading UW data…</div>';

    var html = '';

    // ── Status bar ──────────────────────────────────────────────────────
    html += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">';
    if (!_state.keyConfigured) {
      html += '<span style="color:var(--amber);font-size:10px">⚠ No UW_API_KEY set — set env var and restart backend</span>';
    } else {
      html += '<span style="color:var(--green);font-size:10px">● LIVE</span>';
      html += '<span style="font-size:9px;color:var(--dim)">' +
              'flows: ' + (_state.stats.flow_alerts || 0) +
              ' · dark: ' + (_state.stats.darkpool || 0) +
              ' · congress: ' + (_state.stats.congress || 0) + '</span>';
    }

    // Tide badge
    if (_state.tide) {
      var tc = _tideColor(_state.tide.label);
      html += '<span style="margin-left:auto;font-size:9px;padding:2px 8px;border-radius:3px;background:' + tc.bg + ';color:' + tc.fg + ';font-weight:bold;letter-spacing:0.5px">' +
              '🌊 ' + _state.tide.label.replace('_', ' ') + '</span>';
      html += '<span style="font-size:9px;color:var(--dim)">net ' +
              ((_state.tide.net_premium || 0) >= 0 ? '+' : '') +
              '$' + _fmtM(_state.tide.net_premium || 0) + '</span>';
    }
    html += '</div>';

    // ── IV Rank heatmap ──────────────────────────────────────────────────
    var ivKeys = Object.keys(_state.ivRanks);
    if (ivKeys.length) {
      html += '<div style="margin-bottom:10px">';
      html += '<div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">IV Rank</div>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:4px">';
      ivKeys.forEach(function (t) {
        var iv = _state.ivRanks[t];
        var bg = iv >= 80 ? 'rgba(255,71,71,0.25)' :
                 iv >= 60 ? 'rgba(255,160,0,0.20)' :
                 iv <= 20 ? 'rgba(40,192,96,0.15)' : 'var(--bg3)';
        var col = iv >= 80 ? 'var(--red)' : iv >= 60 ? 'var(--amber)' : iv <= 20 ? 'var(--green)' : 'var(--text)';
        html += '<div style="font-size:9px;padding:2px 6px;border-radius:3px;background:' + bg + ';color:' + col + '">' +
                t + ' <b>' + iv.toFixed(0) + '</b></div>';
      });
      html += '</div></div>';
    }

    // ── Flow Alerts ──────────────────────────────────────────────────────
    if (_state.flowAlerts.length) {
      html += '<div style="margin-bottom:10px">';
      html += '<div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">Options Flow</div>';
      var shown = _state.flowAlerts.slice(0, 8);
      shown.forEach(function (a) {
        var dirCol = a.direction === 'LONG' ? 'var(--green)' : a.direction === 'SHORT' ? 'var(--red)' : 'var(--dim)';
        var prem   = '$' + _fmtM(a.premium || 0);
        var sweep  = a.sweep ? '<span style="font-size:7px;padding:1px 3px;background:rgba(255,160,0,0.2);color:var(--amber);border-radius:2px;margin-left:3px">SWEEP</span>' : '';
        var blk    = a.block ? '<span style="font-size:7px;padding:1px 3px;background:rgba(167,139,250,0.2);color:#a78bfa;border-radius:2px;margin-left:3px">BLOCK</span>' : '';
        html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)">' +
                '<span style="font-size:10px;font-weight:bold;color:var(--text);min-width:40px">' + (a.ticker || '') + '</span>' +
                '<span style="font-size:9px;color:var(--dim)">' + (a.opt_type || '') + ' ' + (a.strike || '') + ' ' + _fmtExpiry(a.expiry) + '</span>' +
                sweep + blk +
                '<span style="margin-left:auto;font-size:9px;font-weight:bold;color:' + dirCol + '">' + prem + '</span>' +
                '</div>';
      });
      html += '</div>';
    }

    // ── Dark Pool ────────────────────────────────────────────────────────
    if (_state.darkpool.length) {
      html += '<div style="margin-bottom:10px">';
      html += '<div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">Dark Pool Prints</div>';
      _state.darkpool.slice(0, 5).forEach(function (d) {
        var val = '$' + _fmtM(d.value || 0);
        html += '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border)">' +
                '<span style="font-size:10px;font-weight:bold;color:var(--text);min-width:40px">' + (d.ticker || '') + '</span>' +
                '<span style="font-size:9px;color:var(--dim)">@ $' + (d.price || 0).toFixed(2) + '  ×' + _fmtK(d.size || 0) + 'sh</span>' +
                '<span style="margin-left:auto;font-size:9px;font-weight:bold;color:#4da6ff">' + val + '</span>' +
                '</div>';
      });
      html += '</div>';
    }

    // ── Congress ─────────────────────────────────────────────────────────
    if (_state.congress.length) {
      html += '<div>';
      html += '<div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">Congress Trades</div>';
      _state.congress.slice(0, 6).forEach(function (c) {
        var dirCol = c.direction === 'LONG' ? 'var(--green)' : 'var(--red)';
        var arrow  = c.direction === 'LONG' ? '▲' : '▼';
        var party  = c.party === 'R' ? '<span style="color:#ff6b6b;font-size:8px">[R]</span>' :
                     c.party === 'D' ? '<span style="color:#4da6ff;font-size:8px">[D]</span>' : '';
        var amt    = c.amount ? '$' + _fmtK(c.amount) : '';
        html += '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border)">' +
                '<span style="font-size:9px;color:' + dirCol + ';font-weight:bold">' + arrow + '</span>' +
                '<span style="font-size:10px;font-weight:bold;color:var(--text)">' + (c.ticker || '') + '</span>' +
                party +
                '<span style="font-size:9px;color:var(--dim);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
                (c.politician || '').split(' ').pop() + '</span>' +
                '<span style="font-size:9px;color:var(--dim)">' + amt + '</span>' +
                '<span style="font-size:8px;color:var(--dim);min-width:28px;text-align:right">' + _relTime(c.ts) + '</span>' +
                '</div>';
      });
      html += '</div>';
    }

    if (!_state.flowAlerts.length && !_state.congress.length && !_state.darkpool.length) {
      html += '<div style="color:var(--dim);font-size:11px;padding:12px 0;text-align:center">' +
              (_state.keyConfigured ? 'No data yet — backend is populating…' : 'Set UW_API_KEY to enable') +
              '</div>';
    }

    return html;
  }

  /* ── Helpers ─────────────────────────────────────────────────────────── */
  function _fmtM(n) {
    n = Number(n) || 0;
    if (n >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3)  return (n / 1e3).toFixed(0) + 'K';
    return n.toFixed(0);
  }
  function _fmtK(n) {
    n = Number(n) || 0;
    return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n.toFixed(0);
  }
  function _fmtExpiry(s) {
    if (!s) return '';
    return s.slice(5);  // 'YYYY-MM-DD' → 'MM-DD'
  }
  function _relTime(ts) {
    if (!ts) return '';
    var d = Math.floor((Date.now() - ts) / 86400000);
    return d === 0 ? 'today' : d + 'd';
  }
  function _tideColor(label) {
    if (label === 'STRONGLY_BULLISH') return { bg: 'rgba(40,192,96,0.25)',  fg: 'var(--green)' };
    if (label === 'BULLISH')          return { bg: 'rgba(40,192,96,0.15)',  fg: 'var(--green)' };
    if (label === 'BEARISH')          return { bg: 'rgba(255,71,71,0.18)',  fg: 'var(--red)' };
    if (label === 'STRONGLY_BEARISH') return { bg: 'rgba(255,71,71,0.28)',  fg: 'var(--red)' };
    return { bg: 'var(--bg3)', fg: 'var(--dim)' };
  }
  function _log(msg) {
    console.log('[UW]', msg);
    if (window.EE && typeof EE.log === 'function') {
      EE.log('UW', msg, 'cyan');
    }
  }

  /* ── Init ────────────────────────────────────────────────────────────── */
  function _init() {
    _renderPanel();  // show loading state immediately
    _startPolling();
  }

  /* ── Public API ──────────────────────────────────────────────────────── */
  window.UWIntel = {
    state:       function () { return _state; },
    refresh:     function () { _pollStatus(); _pollFlowAlerts(); _pollDarkPool(); _pollCongress(); _pollTide(); },
    getIVRanks:  function () { return _state.ivRanks; },
    getTide:     function () { return _state.tide; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();
