/**
 * Data Health Monitor Agent
 *
 * Meta-agent that monitors all data sources for staleness, errors, and anomalies.
 * Not a trading agent — provides system health visibility and emits warnings
 * when data sources go stale or start failing.
 *
 * Polls key API endpoints and agent data stores, tracks last-good timestamps,
 * and flags sources that haven't refreshed within expected windows.
 *
 * Exposes: window.GII_DATA_HEALTH
 *
 * Public API:
 *   GII_DATA_HEALTH.status()    → { sources: [...], alerts: [...], healthy: bool }
 *   GII_DATA_HEALTH.alerts()    → current active alerts array
 *   GII_DATA_HEALTH.sources()   → all tracked source statuses
 */
(function () {
  'use strict';

  var POLL_MS = 60 * 1000;  // check every 60s

  /* ── Source definitions ────────────────────────────────────────────────────
     Each source has:
       name:       display name
       type:       'api' (backend endpoint) or 'agent' (window global)
       check:      function that returns { ok, ts, detail } or null
       maxAgeMs:   max acceptable age before alert (ms)
  */
  var _sources = [];
  var _alerts  = [];
  var _history = {};  // name → [{ ts, ok, detail }] last 10 checks

  /* ── API source checker factory ────────────────────────────────────────── */
  function _apiCheck(endpoint, validator) {
    return function () {
      return new Promise(function (resolve) {
        var API = (typeof window !== 'undefined' && window.GEO_API_BASE) || 'http://localhost:8765';
        var ctrl = new AbortController();
        var tid = setTimeout(function () { ctrl.abort(); }, 15000);
        fetch(API + endpoint, { signal: ctrl.signal })
          .then(function (r) {
            clearTimeout(tid);
            if (!r.ok) return resolve({ ok: false, ts: Date.now(), detail: 'HTTP ' + r.status });
            return r.json();
          })
          .then(function (data) {
            if (!data) return resolve({ ok: false, ts: Date.now(), detail: 'empty response' });
            var result = validator(data);
            result.ts = Date.now();
            resolve(result);
          })
          .catch(function (e) {
            clearTimeout(tid);
            resolve({ ok: false, ts: Date.now(), detail: e.message || 'fetch error' });
          });
      });
    };
  }

  /* ── Agent source checker factory ──────────────────────────────────────── */
  function _agentCheck(globalName, validator) {
    return function () {
      return new Promise(function (resolve) {
        var agent = window[globalName];
        if (!agent) return resolve({ ok: false, ts: Date.now(), detail: 'not loaded' });
        try {
          var result = validator(agent);
          result.ts = Date.now();
          resolve(result);
        } catch (e) {
          resolve({ ok: false, ts: Date.now(), detail: 'error: ' + (e.message || '?') });
        }
      });
    };
  }

  /* ── Register all data sources ─────────────────────────────────────────── */
  function _registerSources() {
    // Backend API endpoints
    _sources.push({
      name: 'Market Prices (Stooq)',
      type: 'api',
      maxAgeMs: 20 * 60 * 1000,  // 20 min (Stooq TTL is 15min)
      check: _apiCheck('/api/market', function (data) {
        var tickers = Object.keys(data);
        var staleCount = 0;
        tickers.forEach(function (t) { if (data[t].stale) staleCount++; });
        if (!tickers.length) return { ok: false, detail: 'no tickers returned' };
        if (staleCount > 3) return { ok: false, detail: staleCount + '/' + tickers.length + ' tickers stale' };
        return { ok: true, detail: tickers.length + ' tickers, ' + staleCount + ' stale' };
      })
    });

    _sources.push({
      name: 'GDELT Events',
      type: 'api',
      maxAgeMs: 30 * 60 * 1000,  // 30 min
      check: _apiCheck('/api/events', function (data) {
        var events = Array.isArray(data) ? data : (data.events || []);
        if (!events.length) return { ok: false, detail: 'no events' };
        // Check if newest event is recent
        var newest = events[0];
        var age = newest.ts ? (Date.now() - newest.ts) : null;
        if (age && age > 60 * 60 * 1000) return { ok: false, detail: 'newest event ' + Math.round(age / 60000) + 'min old' };
        return { ok: true, detail: events.length + ' events' };
      })
    });

    _sources.push({
      name: 'VIX (CBOE)',
      type: 'api',
      maxAgeMs: 15 * 60 * 1000,
      check: _apiCheck('/api/market', function (data) {
        if (!data.VIX) return { ok: false, detail: 'VIX missing from market data' };
        var vix = data.VIX.price;
        if (!vix || vix <= 0) return { ok: false, detail: 'VIX price invalid: ' + vix };
        if (vix > 80) return { ok: false, detail: 'VIX=' + vix + ' — suspiciously high (stale contract?)' };
        return { ok: true, detail: 'VIX=' + vix };
      })
    });

    _sources.push({
      name: 'COT Data',
      type: 'api',
      maxAgeMs: 8 * 60 * 60 * 1000,  // 8 hours (weekly data)
      check: _apiCheck('/api/cot', function (data) {
        var keys = Object.keys(data);
        if (!keys.length) return { ok: false, detail: 'no COT data' };
        return { ok: true, detail: keys.length + ' instruments' };
      })
    });

    _sources.push({
      name: 'ECB Data',
      type: 'api',
      maxAgeMs: 2 * 60 * 60 * 1000,  // 2 hours
      check: _apiCheck('/api/ecb', function (data) {
        var keys = Object.keys(data);
        if (!keys.length) return { ok: false, detail: 'no ECB series' };
        return { ok: true, detail: keys.length + ' series' };
      })
    });

    _sources.push({
      name: 'Earthquakes (USGS)',
      type: 'api',
      maxAgeMs: 30 * 60 * 1000,
      check: _apiCheck('/api/earthquakes', function (data) {
        var quakes = data.features || data;
        if (!Array.isArray(quakes)) return { ok: false, detail: 'unexpected format' };
        return { ok: true, detail: (quakes.length || 0) + ' events' };
      })
    });

    _sources.push({
      name: 'FRED Macro',
      type: 'api',
      maxAgeMs: 4 * 60 * 60 * 1000,  // 4 hours
      check: _apiCheck('/api/fred', function (data) {
        var keys = Object.keys(data);
        if (!keys.length) return { ok: false, detail: 'no FRED data' };
        return { ok: true, detail: keys.length + ' series' };
      })
    });

    // Agent data freshness
    _sources.push({
      name: 'Technicals Agent',
      type: 'agent',
      maxAgeMs: 10 * 60 * 1000,  // 10 min
      check: _agentCheck('GII_AGENT_TECHNICALS', function (ag) {
        var st = ag.status ? ag.status() : null;
        if (!st) return { ok: false, detail: 'no status' };
        var sigCount = (st.activeSignals || []).length;
        if (!st.lastPoll) return { ok: false, detail: 'never polled' };
        var age = Date.now() - st.lastPoll;
        if (age > 10 * 60 * 1000) return { ok: false, detail: 'last poll ' + Math.round(age / 60000) + 'min ago' };
        return { ok: true, detail: sigCount + ' signals, polled ' + Math.round(age / 1000) + 's ago' };
      })
    });

    _sources.push({
      name: 'Energy Agent',
      type: 'agent',
      maxAgeMs: 5 * 60 * 1000,
      check: _agentCheck('GII_AGENT_ENERGY', function (ag) {
        var st = ag.status ? ag.status() : null;
        if (!st) return { ok: false, detail: 'no status' };
        if (!st.lastPoll) return { ok: false, detail: 'never polled' };
        var age = Date.now() - st.lastPoll;
        if (age > 5 * 60 * 1000) return { ok: false, detail: 'last poll ' + Math.round(age / 60000) + 'min ago' };
        return { ok: true, detail: 'online, ' + (st.energyEventCount || 0) + ' events' };
      })
    });

    _sources.push({
      name: 'Macro Agent',
      type: 'agent',
      maxAgeMs: 5 * 60 * 1000,
      check: _agentCheck('GII_AGENT_MACRO', function (ag) {
        var st = ag.status ? ag.status() : null;
        if (!st) return { ok: false, detail: 'no status' };
        return { ok: true, detail: 'riskMode=' + (st.riskMode || '?') };
      })
    });

    _sources.push({
      name: 'Regime Agent',
      type: 'agent',
      maxAgeMs: 5 * 60 * 1000,
      check: _agentCheck('GII_AGENT_REGIME', function (ag) {
        var st = ag.status ? ag.status() : null;
        if (!st) return { ok: false, detail: 'no status' };
        return { ok: true, detail: 'regime=' + (st.currentRegime || '?') };
      })
    });

    _sources.push({
      name: 'Consultation System',
      type: 'agent',
      maxAgeMs: 10 * 60 * 1000,
      check: _agentCheck('GII_CONSULTATION', function (ag) {
        var tracks = ag.trackRecords ? ag.trackRecords() : {};
        var agents = Object.keys(tracks);
        if (!agents.length) return { ok: true, detail: 'no track data yet' };
        var muted = agents.filter(function (a) { return tracks[a].earlyAccuracy < 0.35 && tracks[a].totalVotes >= 50; });
        var detail = agents.length + ' tracked';
        if (muted.length) detail += ', ' + muted.length + ' circuit-broken';
        return { ok: true, detail: detail };
      })
    });

    _sources.push({
      name: 'HL Broker',
      type: 'agent',
      maxAgeMs: 5 * 60 * 1000,
      check: _agentCheck('HLBroker', function (ag) {
        if (typeof ag.isConnected !== 'function') return { ok: false, detail: 'no isConnected()' };
        var connected = ag.isConnected();
        if (!connected) return { ok: true, detail: 'disconnected (normal if not trading)' };
        return { ok: true, detail: 'connected' };
      })
    });

    _sources.push({
      name: 'Execution Engine',
      type: 'agent',
      maxAgeMs: 5 * 60 * 1000,
      check: _agentCheck('EE', function (ag) {
        if (typeof ag.status !== 'function') return { ok: false, detail: 'no status()' };
        var st = ag.status();
        if (!st) return { ok: false, detail: 'null status' };
        return { ok: true, detail: 'open=' + (st.openCount || 0) + ' today=' + (st.todayCount || 0) };
      })
    });
  }

  /* ── Polling logic ─────────────────────────────────────────────────────── */
  function _poll() {
    var promises = _sources.map(function (src) {
      return src.check().then(function (result) {
        // Track history
        if (!_history[src.name]) _history[src.name] = [];
        _history[src.name].unshift(result);
        if (_history[src.name].length > 10) _history[src.name].length = 10;

        src._lastCheck = result;
        src._lastCheckTs = Date.now();
        return { source: src, result: result };
      }).catch(function (e) {
        var failResult = { ok: false, ts: Date.now(), detail: 'check failed: ' + (e.message || '?') };
        src._lastCheck = failResult;
        src._lastCheckTs = Date.now();
        return { source: src, result: failResult };
      });
    });

    Promise.all(promises).then(function (results) {
      _rebuildAlerts(results);
    });
  }

  function _rebuildAlerts(results) {
    var newAlerts = [];
    results.forEach(function (r) {
      var src = r.source;
      var check = r.result;
      if (!check.ok) {
        newAlerts.push({
          source:   src.name,
          type:     src.type,
          severity: _severity(src, check),
          detail:   check.detail,
          ts:       check.ts
        });
      }
    });

    // Log new alerts that weren't in the previous cycle
    var prevNames = _alerts.map(function (a) { return a.source; });
    newAlerts.forEach(function (a) {
      if (prevNames.indexOf(a.source) === -1) {
        console.warn('[DATA-HEALTH] ALERT: ' + a.source + ' — ' + a.detail + ' [' + a.severity + ']');
      }
    });

    // Log recoveries
    var newNames = newAlerts.map(function (a) { return a.source; });
    _alerts.forEach(function (a) {
      if (newNames.indexOf(a.source) === -1) {
        console.info('[DATA-HEALTH] RECOVERED: ' + a.source);
      }
    });

    _alerts = newAlerts;
  }

  function _severity(src, check) {
    // Critical: market data or execution engine down
    if (src.name.indexOf('Market') !== -1 || src.name.indexOf('Execution') !== -1) return 'CRITICAL';
    if (src.name.indexOf('VIX') !== -1) return 'HIGH';
    // High: trading-relevant agents
    if (src.name.indexOf('Technicals') !== -1 || src.name.indexOf('Energy') !== -1) return 'HIGH';
    // Medium: everything else
    return 'MEDIUM';
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */

  function status() {
    var sourceStatuses = _sources.map(function (src) {
      return {
        name:      src.name,
        type:      src.type,
        ok:        src._lastCheck ? src._lastCheck.ok : null,
        detail:    src._lastCheck ? src._lastCheck.detail : 'not checked yet',
        lastCheck: src._lastCheckTs || null,
        maxAgeMs:  src.maxAgeMs
      };
    });
    return {
      sources: sourceStatuses,
      alerts:  _alerts.slice(),
      healthy: _alerts.length === 0,
      checkedAt: Date.now()
    };
  }

  function alerts() { return _alerts.slice(); }

  function sources() {
    return _sources.map(function (src) {
      return {
        name:   src.name,
        type:   src.type,
        ok:     src._lastCheck ? src._lastCheck.ok : null,
        detail: src._lastCheck ? src._lastCheck.detail : 'pending',
        history: (_history[src.name] || []).slice()
      };
    });
  }

  /* ── Init ───────────────────────────────────────────────────────────────── */
  var _initialized = false;
  window.addEventListener('load', function () {
    if (_initialized) return;
    _initialized = true;
    _registerSources();
    // First poll after 10s (let other agents boot)
    setTimeout(function () {
      _poll();
      setInterval(_poll, POLL_MS);
    }, 10000);
  });

  window.GII_DATA_HEALTH = {
    status:  status,
    alerts:  alerts,
    sources: sources,
    refresh: function () { _poll(); }
  };

  console.log('[DATA-HEALTH] Data Health Monitor loaded');
})();
