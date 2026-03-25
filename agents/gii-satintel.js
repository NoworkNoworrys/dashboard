/* GII Satellite Intelligence Agent — gii-satintel.js v1
 * Correlates NASA FIRMS fire detections + Sentinel imagery hits + GDACS disaster alerts
 * to produce compound "ground truth" signals that can't be gamed by narrative sources.
 *
 * Logic: Single sources get moderate confidence.
 *        Two sources agreeing on same region → confidence boost (+15%).
 *        All three agreeing → high-confidence compound signal.
 *
 * Reads: window.__IC.events (source tags: NASA-FIRMS, SENTINEL, GDACS, USGS)
 * Exposes: window.GII_AGENT_SATINTEL
 */
(function () {
  'use strict';

  var POLL_INTERVAL = 90000;
  var MAX_SIGNALS   = 25;
  var WINDOW_MS     = 6 * 60 * 60 * 1000; // 6-hour look-back

  // Region → primary tradeable asset
  var REGION_ASSET = {
    'UKRAINE':          'WTI',
    'RUSSIA':           'WTI',
    'MIDDLE EAST':      'WTI',
    'IRAN':             'WTI',
    'ISRAEL':           'GLD',
    'GAZA':             'GLD',
    'SYRIA':            'WTI',
    'YEMEN':            'WTI',
    'RED SEA':          'BRENT',
    'SUDAN':            'GLD',
    'SAHEL':            'GLD',
    'MYANMAR':          'GLD',
    'SOUTH CHINA SEA':  'TSM',
    'TAIWAN':           'TSM',
    'NORTH KOREA':      'GLD',
    'ETHIOPIA':         'GLD',
    'SOMALIA':          'GLD',
    'GLOBAL':           'GLD',
  };

  // GDACS alert level → signal boost
  var GDACS_BOOST = { 'RED': 0.25, 'ORANGE': 0.12, 'GREEN': 0 };

  var _signals = [];
  var _status  = {
    lastPoll:     null,
    firmsAlerts:  0,
    gdacsAlerts:  0,
    sentinelHits: 0,
    usgsEvents:   0,
    compoundHits: 0,
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

  function _extractGdacsLevel(title) {
    var t = (title || '').toUpperCase();
    if (t.indexOf('RED') !== -1)    return 'RED';
    if (t.indexOf('ORANGE') !== -1) return 'ORANGE';
    if (t.indexOf('GREEN') !== -1)  return 'GREEN';
    return 'ORANGE'; // default GDACS events to orange if unspecified
  }

  function _analyse() {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now    = Date.now();
    var cutoff = now - WINDOW_MS;

    // Bucket events by source
    var firms    = [];
    var sentinel = [];
    var gdacs    = [];
    var usgs     = [];

    IC.events.forEach(function (e) {
      if (e.ts <= cutoff) return;
      var src = (e.source || e.sbFeed || '').toUpperCase();
      if (src.indexOf('NASA') !== -1 || src.indexOf('FIRMS') !== -1) firms.push(e);
      else if (src.indexOf('SENTINEL') !== -1 || src.indexOf('PLANET') !== -1) sentinel.push(e);
      else if (src.indexOf('GDACS') !== -1) gdacs.push(e);
      else if (src.indexOf('USGS') !== -1) usgs.push(e);
    });

    _status.firmsAlerts  = firms.length;
    _status.sentinelHits = sentinel.length;
    _status.gdacsAlerts  = gdacs.length;
    _status.usgsEvents   = usgs.length;

    // ── GDACS alerts ────────────────────────────────────────────────────────
    gdacs.forEach(function (e) {
      var level  = _extractGdacsLevel(e.title || '');
      var boost  = GDACS_BOOST[level] || 0.10;
      var region = e.region || 'GLOBAL';
      var asset  = _assetForRegion(region);
      var sig    = (e.signal || 50) / 100;
      var conf   = _clamp(sig * 0.65 + boost, 0.28, 0.78);
      if (level === 'GREEN') return; // skip green GDACS
      _pushSignal({
        source:      'satintel',
        asset:       asset,
        bias:        'long',
        confidence:  conf,
        reasoning:   'GDACS ' + level + ' alert: ' + (e.title || region).substring(0, 70),
        region:      region,
        evidenceKeys: ['gdacs', 'disaster', level.toLowerCase()]
      });
    });

    // ── NASA FIRMS fire detections ──────────────────────────────────────────
    firms.forEach(function (e) {
      var region = e.region || 'GLOBAL';
      var asset  = _assetForRegion(region);
      var sig    = (e.signal || 55) / 100;
      var conf   = _clamp(sig * 0.70, 0.30, 0.72);
      _pushSignal({
        source:      'satintel',
        asset:       asset,
        bias:        'long',
        confidence:  conf,
        reasoning:   'NASA FIRMS fire detected in ' + region + ': ' + (e.title || '').substring(0, 60),
        region:      region,
        evidenceKeys: ['nasa', 'fire', 'satellite', 'firms']
      });
    });

    // ── Sentinel / Planet imagery hits ──────────────────────────────────────
    sentinel.forEach(function (e) {
      var region = e.region || 'GLOBAL';
      var asset  = _assetForRegion(region);
      var sig    = (e.signal || 55) / 100;
      var conf   = _clamp(sig * 0.68, 0.28, 0.70);
      _pushSignal({
        source:      'satintel',
        asset:       asset,
        bias:        'long',
        confidence:  conf,
        reasoning:   'Satellite imagery change detected in ' + region + ': ' + (e.title || '').substring(0, 60),
        region:      region,
        evidenceKeys: ['sentinel', 'satellite', 'imagery', 'planet']
      });
    });

    // ── USGS seismic near sensitive zones ───────────────────────────────────
    usgs.forEach(function (e) {
      var region = e.region || 'GLOBAL';
      var sig    = (e.signal || 50) / 100;
      if (sig < 0.50) return; // only significant quakes
      var isNuclearZone = /iran|north korea|pakistan|ukraine/i.test(e.title || region);
      var conf = _clamp(sig * 0.60 + (isNuclearZone ? 0.12 : 0), 0.25, 0.68);
      _pushSignal({
        source:      'satintel',
        asset:       isNuclearZone ? 'GLD' : _assetForRegion(region),
        bias:        'long',
        confidence:  conf,
        reasoning:   'USGS seismic event' + (isNuclearZone ? ' near sensitive zone' : '') +
                     ': ' + (e.title || region).substring(0, 60),
        region:      region,
        evidenceKeys: ['usgs', 'seismic', 'earthquake']
      });
    });

    // ── COMPOUND: FIRMS + SENTINEL same region ──────────────────────────────
    var firmsRegions    = {};
    var sentinelRegions = {};
    var gdacsRegions    = {};

    firms.forEach(function (e)    { firmsRegions[(e.region||'GLOBAL').toUpperCase()]    = e; });
    sentinel.forEach(function (e) { sentinelRegions[(e.region||'GLOBAL').toUpperCase()] = e; });
    gdacs.forEach(function (e)    { gdacsRegions[(e.region||'GLOBAL').toUpperCase()]    = e; });

    var allRegions = Object.keys(firmsRegions).concat(Object.keys(sentinelRegions))
      .concat(Object.keys(gdacsRegions))
      .filter(function (r, i, a) { return a.indexOf(r) === i; });

    allRegions.forEach(function (region) {
      var sources = [];
      if (firmsRegions[region])    sources.push('FIRMS');
      if (sentinelRegions[region]) sources.push('SENTINEL');
      if (gdacsRegions[region])    sources.push('GDACS');
      if (sources.length < 2) return; // need at least 2 sources to compound

      _status.compoundHits++;
      var asset  = _assetForRegion(region);
      var conf   = _clamp(0.55 + sources.length * 0.12, 0.55, 0.88);
      _pushSignal({
        source:      'satintel-compound',
        asset:       asset,
        bias:        'long',
        confidence:  conf,
        reasoning:   '[COMPOUND ' + sources.join('+') + '] ' + sources.length +
                     ' independent satellite sources confirm activity in ' + region,
        region:      region,
        evidenceKeys: ['compound', 'satellite', 'multi-source'].concat(sources.map(function(s){return s.toLowerCase();}))
      });
    });
  }

  function poll() {
    _status.lastPoll = Date.now();
    _status.compoundHits = 0;
    _signals = [];
    _analyse();
  }

  window.GII_AGENT_SATINTEL = {
    poll:     poll,
    signals:  function () { return _signals.slice(); },
    status:   function () { return Object.assign({}, _status); },
    accuracy: function () { return Object.assign({}, _accuracy); }
  };

  window.addEventListener('load', function () {
    setTimeout(function () { poll(); setInterval(poll, POLL_INTERVAL); }, 8500);
  });

})();
