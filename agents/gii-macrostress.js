/* GII Macro Stress Agent — gii-macrostress.js v1
 * Synthesises BIS credit gaps + OECD labour/inflation + Eurostat EU data
 * + EIA energy inventories into per-country financial stress scores.
 *
 * Logic: Each data source contributes a stress component (0–1).
 *        Components are averaged with source-specific weights.
 *        High stress → long GLD/VIX; specific country stress → relevant asset.
 *
 * Polls: /api/bis, /api/oecd, /api/eurostat, /api/eia
 * Exposes: window.GII_AGENT_MACROSTRESS
 */
(function () {
  'use strict';

  var POLL_INTERVAL = 120000; // 2 min
  var MAX_SIGNALS   = 20;
  var API_BASE      = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
                      ? 'http://localhost:8765' : '';

  // Country → primary tradeable asset when stress is localised
  var COUNTRY_ASSET = {
    'US': 'SPY', 'GB': 'GLD', 'DE': 'GLD', 'FR': 'GLD',
    'JP': 'GLD', 'KR': 'TSM', 'TR': 'GLD', 'PL': 'GLD',
    'HU': 'GLD', 'CZ': 'GLD',
  };

  // BIS credit-to-GDP gap thresholds (Basel III early-warning: >2 = elevated, >10 = critical)
  var BIS_GAP_ELEVATED  = 2;
  var BIS_GAP_CRITICAL  = 10;

  // EIA inventory deviation thresholds (percent from 5-year avg — positive = glut, negative = deficit)
  var EIA_DEFICIT_PCT   = -5;   // below 5-yr avg → supply stress
  var EIA_GLUT_PCT      = 10;   // above 5-yr avg → demand weakness

  var _signals = [];
  var _status  = {
    lastPoll:        null,
    bisCountries:    0,
    oecdCountries:   0,
    eurostatSeries:  0,
    eiaSeries:       0,
    stressSignals:   0,
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _fetchJSON(path) {
    return fetch(API_BASE + path)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // Score a BIS credit-to-GDP gap value → stress 0–1
  function _bisStress(gap) {
    if (gap === null || gap === undefined) return null;
    if (gap <= 0) return 0.05;
    if (gap >= BIS_GAP_CRITICAL) return 0.90;
    if (gap >= BIS_GAP_ELEVATED) return _clamp(0.40 + (gap - BIS_GAP_ELEVATED) / (BIS_GAP_CRITICAL - BIS_GAP_ELEVATED) * 0.50, 0.40, 0.90);
    return _clamp(0.05 + gap / BIS_GAP_ELEVATED * 0.35, 0.05, 0.40);
  }

  // Score OECD unemployment (%) → stress 0–1
  function _unempStress(u) {
    if (u === null || u === undefined) return null;
    if (u <= 3.5) return 0.05;
    if (u >= 12)  return 0.85;
    return _clamp((u - 3.5) / (12 - 3.5) * 0.80 + 0.05, 0.05, 0.85);
  }

  // Score OECD CPI YoY (%) → stress 0–1 (both deflation and high inflation are stressful)
  function _cpiStress(cpi) {
    if (cpi === null || cpi === undefined) return null;
    var abs = Math.abs(cpi);
    if (abs <= 2.5) return 0.05;
    if (abs >= 10)  return 0.85;
    return _clamp((abs - 2.5) / (10 - 2.5) * 0.80 + 0.05, 0.05, 0.85);
  }

  // Score EIA crude stocks vs normal → stress 0–1
  // Here we use: if natgas_storage_bcf is unusually low that's stress
  function _eiaStress(eia) {
    if (!eia) return null;
    var stress = 0;
    var count  = 0;
    // Natural gas storage: ~3400 bcf is near-normal for US
    var gasNorm = 3400;
    if (eia.us_natgas_storage_bcf) {
      var gasDev = (eia.us_natgas_storage_bcf - gasNorm) / gasNorm * 100;
      if (gasDev < EIA_DEFICIT_PCT) stress += _clamp(0.30 + Math.abs(gasDev) / 20 * 0.40, 0.30, 0.70);
      else stress += 0.10;
      count++;
    }
    // Crude stocks: ~440 mb is near-normal
    var crudeNorm = 440;
    if (eia.us_crude_stocks_mb) {
      var crudeDev = (eia.us_crude_stocks_mb - crudeNorm) / crudeNorm * 100;
      if (crudeDev < EIA_DEFICIT_PCT) stress += _clamp(0.25 + Math.abs(crudeDev) / 20 * 0.35, 0.25, 0.60);
      else stress += 0.08;
      count++;
    }
    return count > 0 ? stress / count : null;
  }

  function _analyse(bis, oecd, eurostat, eia) {
    _status.bisCountries   = bis    ? Object.keys(bis).length    : 0;
    _status.oecdCountries  = oecd   ? Object.keys(oecd).length   : 0;
    _status.eurostatSeries = eurostat ? Object.keys(eurostat).length : 0;
    _status.eiaSeries      = eia    ? Object.keys(eia).length    : 0;

    var globalStressComponents = [];

    // ── Per-country stress from BIS + OECD ─────────────────────────────────
    var countries = {};

    if (bis) {
      Object.keys(bis).forEach(function (cty) {
        countries[cty] = countries[cty] || {};
        countries[cty].bisGap = bis[cty];
      });
    }
    if (oecd) {
      Object.keys(oecd).forEach(function (cty) {
        countries[cty] = countries[cty] || {};
        var d = oecd[cty];
        if (d.unemployment !== undefined) countries[cty].unemployment = d.unemployment;
        if (d.cpi          !== undefined) countries[cty].cpi          = d.cpi;
        if (d.gdp_growth   !== undefined) countries[cty].gdpGrowth    = d.gdp_growth;
      });
    }

    Object.keys(countries).forEach(function (cty) {
      var d = countries[cty];
      var components = [];
      if (d.bisGap      !== undefined) components.push({ w: 0.40, v: _bisStress(d.bisGap) });
      if (d.unemployment !== undefined) components.push({ w: 0.30, v: _unempStress(d.unemployment) });
      if (d.cpi          !== undefined) components.push({ w: 0.30, v: _cpiStress(d.cpi) });

      var valid = components.filter(function (c) { return c.v !== null; });
      if (!valid.length) return;

      var wSum = valid.reduce(function (s, c) { return s + c.w; }, 0);
      var stress = valid.reduce(function (s, c) { return s + c.v * c.w; }, 0) / wSum;
      globalStressComponents.push(stress);

      if (stress >= 0.50) {
        var asset = COUNTRY_ASSET[cty] || 'GLD';
        var conf  = _clamp(stress * 0.85, 0.38, 0.80);
        var reasons = [];
        if (d.bisGap      !== undefined && d.bisGap > BIS_GAP_ELEVATED) reasons.push('credit gap ' + d.bisGap.toFixed(1));
        if (d.unemployment !== undefined && d.unemployment > 7)         reasons.push('unemployment ' + d.unemployment.toFixed(1) + '%');
        if (d.cpi          !== undefined && Math.abs(d.cpi) > 4)        reasons.push('CPI ' + d.cpi.toFixed(1) + '%');
        _pushSignal({
          source:       'macrostress',
          asset:        asset,
          bias:         'long',
          confidence:   conf,
          reasoning:    'Macro stress elevated in ' + cty + ' (' + reasons.join(', ') + ')',
          region:       cty,
          evidenceKeys: ['macro', 'bis', 'oecd', 'stress', cty.toLowerCase()],
        });
        _status.stressSignals++;
      }
    });

    // ── Eurostat EU-wide inflation divergence ───────────────────────────────
    if (eurostat) {
      var inflValues = [];
      Object.keys(eurostat).forEach(function (k) {
        if (k.indexOf('hicp') !== -1 && typeof eurostat[k] === 'number') {
          inflValues.push(eurostat[k]);
        }
      });
      if (inflValues.length >= 2) {
        var max = Math.max.apply(null, inflValues);
        var min = Math.min.apply(null, inflValues);
        var spread = max - min;
        if (spread > 3) {
          var conf = _clamp(0.35 + spread / 15 * 0.40, 0.35, 0.72);
          globalStressComponents.push(conf);
          _pushSignal({
            source:       'macrostress',
            asset:        'GLD',
            bias:         'long',
            confidence:   conf,
            reasoning:    'Eurostat EU inflation divergence ' + spread.toFixed(1) + ' pp — fragmentation risk',
            region:       'EUROPE',
            evidenceKeys: ['eurostat', 'inflation', 'divergence', 'eu'],
          });
          _status.stressSignals++;
        }
      }
    }

    // ── EIA energy stress ───────────────────────────────────────────────────
    var eiaS = _eiaStress(eia);
    if (eiaS !== null) {
      globalStressComponents.push(eiaS);
      if (eiaS >= 0.40) {
        _pushSignal({
          source:       'macrostress',
          asset:        'WTI',
          bias:         'long',
          confidence:   _clamp(eiaS * 0.88, 0.32, 0.72),
          reasoning:    'EIA energy inventory stress score ' + (eiaS * 100).toFixed(0) + '% — supply pressure',
          region:       'US',
          evidenceKeys: ['eia', 'energy', 'inventory', 'stress'],
        });
        _status.stressSignals++;
      }
    }

    // ── Global composite stress signal ─────────────────────────────────────
    if (globalStressComponents.length >= 3) {
      var globalAvg = globalStressComponents.reduce(function (s, v) { return s + v; }, 0) / globalStressComponents.length;
      if (globalAvg >= 0.55) {
        _pushSignal({
          source:       'macrostress-global',
          asset:        'GLD',
          bias:         'long',
          confidence:   _clamp(globalAvg * 0.90, 0.45, 0.85),
          reasoning:    '[GLOBAL MACRO] Composite stress ' + (globalAvg * 100).toFixed(0) + '% across ' +
                        globalStressComponents.length + ' components — risk-off',
          region:       'GLOBAL',
          evidenceKeys: ['macro', 'global', 'composite', 'stress'],
        });
        _status.stressSignals++;
      }
    }
  }

  function poll() {
    _status.lastPoll = Date.now();
    _status.stressSignals = 0;
    _signals = [];

    Promise.all([
      _fetchJSON('/api/bis'),
      _fetchJSON('/api/oecd'),
      _fetchJSON('/api/eurostat'),
      _fetchJSON('/api/eia'),
    ]).then(function (results) {
      _analyse(results[0], results[1], results[2], results[3]);
    });
  }

  window.GII_AGENT_MACROSTRESS = {
    poll:     poll,
    signals:  function () { return _signals.slice(); },
    status:   function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); },
  };

  window.addEventListener('load', function () {
    setTimeout(function () { poll(); setInterval(poll, POLL_INTERVAL); }, 11000);
  });

})();
