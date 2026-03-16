/* GII De-escalation Agent — gii-deescalation.js v1
 *
 * "Every geopolitical trade dies when the crisis resolves — this agent finds that moment first."
 *
 * Actively hunts for diplomatic resolution signals that collapse the geopolitical risk premium
 * behind open trades. While all other agents wait to see bullish signals flip bearish, this agent
 * specifically scans for ceasefire, diplomacy, and de-escalation language.
 *
 * Emits SHORT signals on escalation assets (WTI, GLD, etc.) when resolution is detected.
 * Exposes: window.GII_AGENT_DEESCALATION
 */
(function () {
  'use strict';

  /* ── CONFIG ─────────────────────────────────────────────────────────────── */
  var POLL_MS       = 90 * 1000;
  var INIT_DELAY_MS = 10 * 1000;
  var SCAN_WINDOW_MS = 6 * 60 * 60 * 1000;  // look back 6h for de-escalation events
  var MIN_SCORE     = 4;                     // keyword score threshold to emit signal
  var MAX_SIGNALS   = 15;

  /* De-escalation keywords → severity weight */
  var DE_ESC_KEYWORDS = {
    /* Ceasefires & peace */
    'ceasefire':            5,
    'cease-fire':           5,
    'cease fire':           5,
    'peace deal':           5,
    'peace agreement':      5,
    'peace talks':          3,
    'peace plan':           3,
    /* Diplomacy */
    'diplomatic':           2,
    'diplomacy':            2,
    'negotiations':         2,
    'negotiation':          2,
    'mediation':            2,
    'mediator':             2,
    'accord':               3,
    'treaty':               4,
    'bilateral talks':      3,
    'back-channel':         3,
    'un resolution':        3,
    'security council resolution': 4,
    /* Military withdrawal */
    'withdrawal':           3,
    'troops withdrawal':    4,
    'forces withdrawal':    4,
    'pullback':             3,
    'deescalation':         4,
    'de-escalation':        4,
    /* Prisoner / hostage */
    'prisoner exchange':    2,
    'prisoner swap':        2,
    'hostage release':      3,
    'hostage deal':         3,
    /* Sanctions relief */
    'sanctions relief':     4,
    'sanctions lifted':     5,
    'sanctions removed':    5,
    'sanctions eased':      4,
    'sanctions waived':     4,
    'nuclear deal':         4,
    'jcpoa':                4,
    /* Normalized relations */
    'normalization':        3,
    'normalized relations': 4,
    'restored relations':   3,
    'diplomatic ties':      2,
    /* Trade route restoration */
    'pipeline reopened':    4,
    'strait reopened':      5,
    'shipping resumed':     3,
    'oil flows resumed':    4,
    'exports resumed':      3,
    'port reopened':        3,
    /* Grain / food */
    'grain deal':           3,
    'grain corridor':       3
  };

  /* Assets that benefit from escalation — SHORT these on de-escalation */
  var ESCALATION_ASSETS = {
    'MIDDLE EAST':      ['WTI', 'BRENT', 'XLE', 'GLD'],
    'STRAIT OF HORMUZ': ['WTI', 'BRENT', 'XLE'],
    'HORMUZ':           ['WTI', 'BRENT', 'XLE'],
    'RED SEA':          ['WTI', 'BRENT', 'XLE'],
    'UKRAINE':          ['GLD', 'WTI', 'BRENT'],
    'RUSSIA':           ['GLD', 'WTI', 'XLE'],
    'IRAN':             ['WTI', 'BRENT', 'GLD'],
    'TAIWAN':           ['TSM', 'SMH', 'GLD'],
    'SOUTH CHINA SEA':  ['TSM', 'SMH', 'FXI'],
    'NORTH KOREA':      ['GLD', 'TSM'],
    'GLOBAL':           ['GLD']
  };

  /* ── STATE ──────────────────────────────────────────────────────────────── */
  var _signals  = [];
  var _status   = {
    lastPoll:        0,
    regionsDetected: [],
    regionScores:    {},
    signalCount:     0
  };
  var _accuracy = {};

  /* ── CORE SCAN ──────────────────────────────────────────────────────────── */
  function _scan() {
    if (!window.__IC || !__IC.events) return;

    var cutoff      = Date.now() - SCAN_WINDOW_MS;
    var recentEvts  = __IC.events.filter(function (e) { return e.ts >= cutoff; });

    /* Score de-escalation evidence per region */
    var regionScores   = {};
    var regionEvidence = {};

    recentEvts.forEach(function (evt) {
      var text   = (evt.title + ' ' + (evt.desc || '')).toLowerCase();
      var region = evt.region || 'GLOBAL';
      var score  = 0;
      var matched = [];

      Object.keys(DE_ESC_KEYWORDS).forEach(function (kw) {
        if (text.indexOf(kw) !== -1) {
          score += DE_ESC_KEYWORDS[kw];
          if (matched.indexOf(kw) === -1) matched.push(kw);
        }
      });

      if (score > 0) {
        /* Recency decay: events in last 2h full weight, older 50% */
        var age = Date.now() - evt.ts;
        var decay = age < 2 * 3600000 ? 1.0 : 0.5;
        regionScores[region]   = (regionScores[region]   || 0) + score * decay;
        regionEvidence[region] = (regionEvidence[region] || []).concat(matched);
      }
    });

    /* Emit SHORT signals for regions with significant de-escalation activity */
    var newSignals = [];
    var detected   = [];

    Object.keys(regionScores).forEach(function (region) {
      var score = regionScores[region];
      if (score < MIN_SCORE) return;

      detected.push(region);

      /* Confidence scales with score: MIN_SCORE=4→0.55, score=10→0.79, cap 0.90 */
      var conf  = Math.min(0.90, 0.45 + score * 0.035);
      var assets = ESCALATION_ASSETS[region] || ESCALATION_ASSETS['GLOBAL'];

      /* Deduplicate evidence */
      var evidence = (regionEvidence[region] || [])
        .filter(function (v, i, a) { return a.indexOf(v) === i; })
        .slice(0, 4);

      assets.forEach(function (asset) {
        newSignals.push({
          source:       'deescalation',
          asset:        asset,
          bias:         'short',
          confidence:   conf,
          reasoning:    region + ' de-escalation (' + evidence.join(', ') + ')',
          timestamp:    Date.now(),
          region:       region,
          evidenceKeys: evidence,
          deEscScore:   score
        });
      });
    });

    /* Keep highest-confidence signal per asset */
    var byAsset = {};
    newSignals.forEach(function (s) {
      if (!byAsset[s.asset] || s.confidence > byAsset[s.asset].confidence) {
        byAsset[s.asset] = s;
      }
    });

    _signals = Object.keys(byAsset).map(function (k) { return byAsset[k]; }).slice(0, MAX_SIGNALS);

    _status.lastPoll        = Date.now();
    _status.regionsDetected = detected;
    _status.regionScores    = regionScores;
    _status.signalCount     = _signals.length;
  }

  function _poll() { _scan(); }

  /* ── PUBLIC API ─────────────────────────────────────────────────────────── */
  window.GII_AGENT_DEESCALATION = {
    poll:     _poll,
    signals:  function () { return _signals.slice(); },
    status:   function () { return Object.assign({}, _status); },
    accuracy: function () { return _accuracy; }
  };

  /* ── INIT ───────────────────────────────────────────────────────────────── */
  window.addEventListener('load', function () {
    setTimeout(function () {
      _poll();
      setInterval(_poll, POLL_MS);
      console.log('[GII-DEESCALATION] De-escalation monitor online — scanning for resolution signals');
    }, INIT_DELAY_MS);
  });

})();
