/* GII Forecast Divergence Agent — gii-forecast.js v1
 * Detects when prediction market prices diverge from news-signal sentiment.
 *
 * Logic: Polls Manifold markets for geopolitical outcomes.
 *        Computes a "news pressure" score from recent IC events for the same topic.
 *        When market probability < news pressure by a significant margin → underpriced risk.
 *        When market probability > news pressure → market is ahead of news (fade signal).
 *
 * Reads:  window.__IC.events, window.__IC.marketData (Manifold via pipeline)
 * Polls:  /api/manifold (if endpoint exists)
 * Exposes: window.GII_AGENT_FORECAST
 */
(function () {
  'use strict';

  var POLL_INTERVAL  = 150000; // 2.5 min
  var MAX_SIGNALS    = 20;
  var WINDOW_MS      = 6 * 60 * 60 * 1000; // 6-hour news look-back
  var DIVERGE_THRESH = 0.18; // 18 pp gap = signal
  var API_BASE       = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
                       ? 'http://localhost:8765' : '';

  // Topic → tradeable asset mapping
  var TOPIC_ASSET = {
    'ukraine':       'WTI',
    'russia':        'WTI',
    'iran':          'WTI',
    'israel':        'GLD',
    'china':         'TSM',
    'taiwan':        'TSM',
    'oil':           'WTI',
    'crude':         'WTI',
    'gold':          'GLD',
    'nuclear':       'GLD',
    'nato':          'GLD',
    'sanctions':     'GLD',
    'ceasefire':     'WTI',
    'conflict':      'GLD',
    'war':           'GLD',
    'fed':           'SPY',
    'rate':          'SPY',
    'recession':     'SPY',
    'default':       'GLD',
  };

  // Keywords that imply bearish news pressure
  var BEAR_KW = [
    'airstrike','attack','invade','invasion','sanction','missile','troops',
    'escalat','nuclear','collapse','crisis','coup','assassin','blockade',
    'conflict','offensive','withdraw','casualt','strike','bomb',
  ];
  // Keywords that imply bullish/de-escalation news pressure
  var BULL_KW = [
    'ceasefire','peace','withdrawal','deal','agreement','negotiat','truce',
    'diplomacy','release','freed','resolved','calm','reduced',
  ];

  var _signals  = [];
  var _divergences = []; // [{question, marketProb, newsScore, gap, asset}]
  var _status   = {
    lastPoll:        null,
    marketsChecked:  0,
    divergenceFound: 0,
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _assetForTopic(text) {
    var t = (text || '').toLowerCase();
    for (var kw in TOPIC_ASSET) {
      if (t.indexOf(kw) !== -1) return TOPIC_ASSET[kw];
    }
    return 'GLD';
  }

  // Compute a news pressure score for a given topic from IC events
  function _newsPressure(topic) {
    var IC = window.__IC;
    if (!IC || !IC.events) return null;
    var cutoff = Date.now() - WINDOW_MS;
    var tLower = (topic || '').toLowerCase();
    var words  = tLower.split(/\W+/).filter(function (w) { return w.length > 3; });

    var bearScore = 0;
    var bullScore = 0;
    var matched   = 0;

    IC.events.forEach(function (e) {
      if (!e.ts || e.ts <= cutoff) return;
      var text = ((e.title || '') + ' ' + (e.summary || '')).toLowerCase();

      // Does this event relate to the topic?
      var relevant = words.some(function (w) { return text.indexOf(w) !== -1; });
      if (!relevant) return;
      matched++;

      var sig = (e.signal || 50) / 100;
      BEAR_KW.forEach(function (k) { if (text.indexOf(k) !== -1) bearScore += sig; });
      BULL_KW.forEach(function (k) { if (text.indexOf(k) !== -1) bullScore += sig * 0.5; });
    });

    if (!matched) return null;
    // Net pressure: 0.5 = neutral, >0.5 = bearish/risk-on, <0.5 = bullish/de-escalation
    var net = 0.50 + _clamp((bearScore - bullScore) / (matched * 2), -0.40, 0.40);
    return _clamp(net, 0.05, 0.95);
  }

  function _analyse(manifoldData) {
    _divergences = [];
    var markets = [];

    // Try data from /api/manifold endpoint
    if (manifoldData && Array.isArray(manifoldData)) {
      markets = manifoldData;
    }
    // Try data from window.__IC market events
    var IC = window.__IC;
    if (IC && IC.events) {
      IC.events.forEach(function (e) {
        var src = (e.source || e.sbFeed || '').toUpperCase();
        if (src.indexOf('MANIFOLD') !== -1 || src.indexOf('POLYMARKET') !== -1) {
          // Events with a probability field
          if (e.probability !== undefined || e.signal !== undefined) {
            markets.push({
              question:    e.title || 'Unknown',
              probability: e.probability !== undefined ? e.probability : e.signal / 100,
            });
          }
        }
      });
    }

    _status.marketsChecked = markets.length;

    markets.forEach(function (market) {
      var q     = market.question || '';
      var mProb = market.probability;
      if (mProb === undefined || mProb === null) return;
      if (mProb < 0.05 || mProb > 0.95) return; // ignore resolved markets

      var newsScore = _newsPressure(q);
      if (newsScore === null) return; // no relevant news

      var gap  = newsScore - mProb; // positive = news more bearish than market priced
      var absG = Math.abs(gap);
      if (absG < DIVERGE_THRESH) return;

      var asset = _assetForTopic(q);
      var conf  = _clamp(0.35 + absG * 1.50, 0.35, 0.78);
      var bias  = gap > 0 ? 'long' : 'short'; // news > market → risk underpriced → long risk-off

      _divergences.push({
        question:    q,
        marketProb:  mProb,
        newsScore:   newsScore,
        gap:         gap,
        asset:       asset,
        confidence:  conf,
        bias:        bias,
      });
      _status.divergenceFound++;

      _pushSignal({
        source:       'forecast-diverge',
        asset:        asset,
        bias:         bias,
        confidence:   conf,
        reasoning:    '[DIVERGENCE] Market ' + (mProb * 100).toFixed(0) + '% vs news ' +
                      (newsScore * 100).toFixed(0) + '% on "' + q.substring(0, 60) + '"',
        region:       'GLOBAL',
        evidenceKeys: ['forecast', 'manifold', 'divergence', 'prediction-market'],
      });
    });

    // Sort divergences by absolute gap descending
    _divergences.sort(function (a, b) { return Math.abs(b.gap) - Math.abs(a.gap); });
  }

  function poll() {
    _status.lastPoll        = Date.now();
    _status.divergenceFound = 0;
    _signals = [];

    fetch(API_BASE + '/api/manifold')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (data) { _analyse(data); });
  }

  window.GII_AGENT_FORECAST = {
    poll:        poll,
    signals:     function () { return _signals.slice(); },
    status:      function () { return Object.assign({}, _status); },
    accuracy:    function () { return Object.assign({}, _accuracy); },
    divergences: function () { return _divergences.slice(); },
  };

  window.addEventListener('load', function () {
    setTimeout(function () { poll(); setInterval(poll, POLL_INTERVAL); }, 16000);
  });

})();
