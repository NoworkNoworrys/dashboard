/* GII Crisis Ranking Agent — gii-crisisrank.js v1
 * Combines ICG CrisisWatch deteriorations + OCHA humanitarian funding gaps
 * + GDACS/USGS disaster alerts to rank escalating crises by severity.
 *
 * Logic: Each crisis gets a composite score from:
 *   - ICG CrisisWatch rating change (deteriorated/conflict risk)
 *   - OCHA funding gap (underfunding of humanitarian appeal)
 *   - GDACS disaster alert level
 *   - Recency weighting (newer events score higher)
 *
 * Reads:  window.__IC.events (source tags: GDACS, USGS, ICG, OCHA)
 * Polls:  /api/ocha for live funding data
 * Exposes: window.GII_AGENT_CRISISRANK
 */
(function () {
  'use strict';

  var POLL_INTERVAL = 120000; // 2 min
  var MAX_SIGNALS   = 20;
  var WINDOW_MS     = 12 * 60 * 60 * 1000; // 12-hour look-back
  var API_BASE      = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
                      ? 'http://localhost:8765' : '';

  // Region → primary tradeable asset
  var REGION_ASSET = {
    'UKRAINE':       'WTI', 'RUSSIA':      'WTI', 'MIDDLE EAST': 'WTI',
    'IRAN':          'WTI', 'ISRAEL':      'GLD', 'GAZA':        'GLD',
    'SYRIA':         'WTI', 'YEMEN':       'WTI', 'RED SEA':     'BRENT',
    'SUDAN':         'GLD', 'SAHEL':       'GLD', 'MYANMAR':     'GLD',
    'SOUTH CHINA SEA':'TSM','TAIWAN':      'TSM', 'NORTH KOREA': 'GLD',
    'ETHIOPIA':      'GLD', 'SOMALIA':     'GLD', 'GLOBAL':      'GLD',
    'DRC':           'GLD', 'HAITI':       'GLD', 'LIBYA':       'WTI',
    'IRAQ':          'WTI', 'AFGHANISTAN': 'GLD', 'PAKISTAN':    'GLD',
  };

  // ICG status keywords mapped to a severity score
  var ICG_SEVERITY = {
    'conflict':      0.90,
    'deteriorated':  0.75,
    'crisis':        0.80,
    'military':      0.70,
    'coup':          0.85,
    'escalat':       0.72,
    'ceasefire':     0.45,
    'tension':       0.50,
    'improved':      0.15,
    'resolved':      0.05,
  };

  var _signals  = [];
  var _rankings = []; // [{region, score, sources, asset}]
  var _status   = {
    lastPoll:       null,
    gdacsAlerts:    0,
    icgEvents:      0,
    ochaFlows:      0,
    rankedCrises:   0,
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _assetForRegion(region) {
    var r = (region || 'GLOBAL').toUpperCase();
    for (var key in REGION_ASSET) {
      if (r.indexOf(key) !== -1) return REGION_ASSET[key];
    }
    return 'GLD';
  }

  function _icgSeverity(text) {
    var t = (text || '').toLowerCase();
    var score = 0;
    for (var kw in ICG_SEVERITY) {
      if (t.indexOf(kw) !== -1) score = Math.max(score, ICG_SEVERITY[kw]);
    }
    return score || 0.40; // default moderate if no keyword matched
  }

  function _recencyWeight(ts) {
    var age = Date.now() - ts;
    if (age < 60 * 60 * 1000)  return 1.00; // < 1h
    if (age < 3 * 60 * 60 * 1000)  return 0.85; // < 3h
    if (age < 6 * 60 * 60 * 1000)  return 0.70; // < 6h
    return 0.55;                               // < 12h
  }

  function _analyse(ochaData) {
    var IC     = window.__IC;
    var now    = Date.now();
    var cutoff = now - WINDOW_MS;

    var crisisMap = {}; // region → {score, sources, asset}

    function _addScore(region, score, source) {
      var r = (region || 'GLOBAL').toUpperCase();
      if (!crisisMap[r]) crisisMap[r] = { score: 0, count: 0, sources: [], asset: _assetForRegion(r) };
      crisisMap[r].score += score;
      crisisMap[r].count++;
      if (crisisMap[r].sources.indexOf(source) === -1) crisisMap[r].sources.push(source);
    }

    // ── ICG CrisisWatch events ──────────────────────────────────────────────
    if (IC && IC.events) {
      IC.events.forEach(function (e) {
        if (!e.ts || e.ts <= cutoff) return;
        var src = (e.source || e.sbFeed || '').toUpperCase();
        if (src.indexOf('ICG') === -1 && src.indexOf('CRISIS') === -1) return;
        var severity = _icgSeverity(e.title + ' ' + (e.summary || ''));
        var rw       = _recencyWeight(e.ts);
        var region   = e.region || 'GLOBAL';
        _addScore(region, severity * rw, 'ICG');
        _status.icgEvents++;
      });

      // ── GDACS alerts ──────────────────────────────────────────────────────
      IC.events.forEach(function (e) {
        if (!e.ts || e.ts <= cutoff) return;
        var src = (e.source || e.sbFeed || '').toUpperCase();
        if (src.indexOf('GDACS') === -1) return;
        var t   = (e.title || '').toUpperCase();
        var lev = t.indexOf('RED') !== -1 ? 0.80 : t.indexOf('ORANGE') !== -1 ? 0.55 : 0.20;
        var rw  = _recencyWeight(e.ts);
        _addScore(e.region || 'GLOBAL', lev * rw, 'GDACS');
        _status.gdacsAlerts++;
      });
    }

    // ── OCHA funding gap data ───────────────────────────────────────────────
    if (ochaData && ochaData.events) {
      ochaData.events.forEach(function (e) {
        var region = (e.region || 'GLOBAL');
        // Funding gap expressed in signal field (0–100)
        var gap    = (e.signal || 50) / 100;
        var score  = gap * 0.65; // underfunding → humanitarian stress
        _addScore(region, score, 'OCHA');
        _status.ochaFlows++;
      });
    } else if (ochaData && Array.isArray(ochaData)) {
      // Handle flat array format from /api/ocha
      ochaData.forEach(function (e) {
        var region = e.region || 'GLOBAL';
        var gap    = (e.signal || 50) / 100;
        _addScore(region, gap * 0.65, 'OCHA');
        _status.ochaFlows++;
      });
    }

    // ── Build ranked list and emit signals ─────────────────────────────────
    _rankings = Object.keys(crisisMap).map(function (r) {
      var d = crisisMap[r];
      var avg = d.count > 0 ? d.score / d.count : 0;
      return { region: r, score: avg, sources: d.sources, asset: d.asset };
    }).sort(function (a, b) { return b.score - a.score; });

    _status.rankedCrises = _rankings.length;

    // Emit signals for top-ranked crises
    _rankings.slice(0, 8).forEach(function (crisis, i) {
      if (crisis.score < 0.40) return;
      var conf = _clamp(crisis.score * 0.90, 0.35, 0.82);
      var rank = i + 1;
      _pushSignal({
        source:       'crisisrank',
        asset:        crisis.asset,
        bias:         'long',
        confidence:   conf,
        reasoning:    '[CRISIS #' + rank + '] ' + crisis.region + ' — score ' +
                      (crisis.score * 100).toFixed(0) + '% via ' + crisis.sources.join('+'),
        region:       crisis.region,
        evidenceKeys: ['crisis', 'rank', crisis.region.toLowerCase()].concat(
                        crisis.sources.map(function (s) { return s.toLowerCase(); })
                      ),
      });
    });
  }

  function poll() {
    _status.lastPoll    = Date.now();
    _status.gdacsAlerts = 0;
    _status.icgEvents   = 0;
    _status.ochaFlows   = 0;
    _signals = [];

    fetch(API_BASE + '/api/ocha')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (ocha) { _analyse(ocha); });
  }

  window.GII_AGENT_CRISISRANK = {
    poll:     poll,
    signals:  function () { return _signals.slice(); },
    status:   function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); },
    rankings: function () { return _rankings.slice(); },
  };

  window.addEventListener('load', function () {
    setTimeout(function () { poll(); setInterval(poll, POLL_INTERVAL); }, 13500);
  });

})();
