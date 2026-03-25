/* GII Intel Master Agent — gii-intel-master.js v1
 * Aggregates and de-duplicates signals from all specialist agents.
 * Produces a ranked, de-duplicated signal list with confidence-weighted
 * composite scores and a "master conviction" score per asset.
 *
 * Sources polled:
 *   GII_AGENT_SATINTEL   — satellite intelligence (FIRMS/Sentinel/GDACS/USGS)
 *   GII_AGENT_MACROSTRESS — macro financial stress (BIS/OECD/Eurostat/EIA)
 *   GII_AGENT_CRISISRANK  — crisis ranking (ICG/OCHA/GDACS)
 *   GII_AGENT_FORECAST    — prediction market divergence (Manifold)
 *
 * Plus existing agents via window.__IC.signals (if exposed).
 *
 * Logic:
 *   1. Collect all signals from all agents.
 *   2. Group by (asset + bias) pair.
 *   3. Within each group, score = mean(conf) boosted by sqrt(count).
 *   4. Emit a MASTER signal per group when score crosses threshold.
 *   5. Expose per-asset conviction table for the dashboard.
 *
 * Exposes: window.GII_INTEL_MASTER
 */
(function () {
  'use strict';

  var POLL_INTERVAL = 60000; // 1 min — runs after other agents have polled
  var MAX_MASTER    = 15;
  var SCORE_THRESH  = 0.45;
  var MIN_SOURCES   = 2;    // need at least 2 different agents agreeing

  // How much to boost confidence when multiple agents agree
  // score = mean_conf * (1 + MULTI_BOOST * (count - 1))
  var MULTI_BOOST   = 0.08;

  // Canonical asset order for conviction table
  var ASSETS = ['WTI', 'BRENT', 'GLD', 'SPY', 'TSM', 'LMT', 'VIX', 'DXY', 'GAS', 'WHT'];

  var _masterSignals   = [];
  var _convictionTable = {}; // asset → {longScore, shortScore, topReason}
  var _status = {
    lastPoll:      null,
    agentsPolled:  0,
    signalsIn:     0,
    masterOut:     0,
    highConviction:0,
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushMaster(sig) {
    sig.timestamp = Date.now();
    _masterSignals.unshift(sig);
    if (_masterSignals.length > MAX_MASTER) _masterSignals.length = MAX_MASTER;
  }

  // Collect signals from all specialist agents
  function _gatherSignals() {
    var all = [];
    var agentRefs = [
      { key: 'GII_AGENT_SATINTEL',    name: 'satintel' },
      { key: 'GII_AGENT_MACROSTRESS', name: 'macrostress' },
      { key: 'GII_AGENT_CRISISRANK',  name: 'crisisrank' },
      { key: 'GII_AGENT_FORECAST',    name: 'forecast' },
    ];

    agentRefs.forEach(function (ref) {
      var agent = window[ref.key];
      if (!agent || typeof agent.signals !== 'function') return;
      var sigs = agent.signals();
      sigs.forEach(function (s) {
        all.push(Object.assign({}, s, { _agentName: ref.name }));
      });
    });

    // Also include signals from IC aggregator if it exposes them
    if (window.__IC && typeof window.__IC.getSignals === 'function') {
      window.__IC.getSignals().forEach(function (s) {
        all.push(Object.assign({}, s, { _agentName: s.source || 'ic' }));
      });
    }

    return all;
  }

  function _analyse(allSignals) {
    _status.signalsIn = allSignals.length;

    // Group by asset+bias
    var groups = {};
    allSignals.forEach(function (s) {
      if (!s.asset || !s.bias || !s.confidence) return;
      var key = s.asset + '|' + s.bias;
      if (!groups[key]) groups[key] = { asset: s.asset, bias: s.bias, sigs: [] };
      groups[key].sigs.push(s);
    });

    // Build conviction table
    _convictionTable = {};
    ASSETS.forEach(function (a) {
      _convictionTable[a] = { longScore: 0, shortScore: 0, topReason: '' };
    });

    var masterCandidates = [];

    Object.keys(groups).forEach(function (key) {
      var g      = groups[key];
      var sigs   = g.sigs;
      var count  = sigs.length;
      var meanC  = sigs.reduce(function (s, x) { return s + x.confidence; }, 0) / count;

      // Unique agent names that contributed
      var agents = sigs.map(function (s) { return s._agentName || s.source || '?'; })
                       .filter(function (v, i, a) { return a.indexOf(v) === i; });
      var agentCount = agents.length;

      // Score: mean confidence boosted by multi-agent agreement
      var score = _clamp(meanC * (1 + MULTI_BOOST * (agentCount - 1)), 0, 0.96);

      // Update conviction table
      if (_convictionTable[g.asset]) {
        if (g.bias === 'long')  _convictionTable[g.asset].longScore  = Math.max(_convictionTable[g.asset].longScore,  score);
        if (g.bias === 'short') _convictionTable[g.asset].shortScore = Math.max(_convictionTable[g.asset].shortScore, score);
      }

      if (score < SCORE_THRESH) return;

      // Best reasoning from highest-confidence signal
      sigs.sort(function (a, b) { return b.confidence - a.confidence; });
      var topReason = sigs[0].reasoning || '';

      if (_convictionTable[g.asset]) {
        _convictionTable[g.asset].topReason = topReason;
      }

      masterCandidates.push({
        asset:       g.asset,
        bias:        g.bias,
        score:       score,
        agentCount:  agentCount,
        agents:      agents,
        count:       count,
        topReason:   topReason,
        region:      sigs[0].region || 'GLOBAL',
        evidenceKeys: sigs.reduce(function (a, s) {
          return a.concat(s.evidenceKeys || []);
        }, []).filter(function (v, i, arr) { return arr.indexOf(v) === i; }),
      });
    });

    // Sort by score desc
    masterCandidates.sort(function (a, b) { return b.score - a.score; });

    // Emit master signals for top candidates with multi-agent agreement
    masterCandidates.forEach(function (c) {
      if (c.agentCount < MIN_SOURCES && c.score < 0.65) return;

      var isHigh = c.score >= 0.72 && c.agentCount >= 2;
      if (isHigh) _status.highConviction++;

      _pushMaster({
        source:      isHigh ? 'MASTER-HIGH' : 'master',
        asset:       c.asset,
        bias:        c.bias,
        confidence:  c.score,
        reasoning:   (isHigh ? '[HIGH CONVICTION] ' : '') +
                     c.asset + ' ' + c.bias.toUpperCase() + ' confirmed by ' +
                     c.agentCount + ' agents (' + c.agents.join('+') + '): ' +
                     c.topReason.substring(0, 80),
        region:      c.region,
        evidenceKeys: ['master', 'multi-agent'].concat(c.evidenceKeys).slice(0, 10),
      });
      _status.masterOut++;
    });
  }

  function poll() {
    _status.lastPoll       = Date.now();
    _status.masterOut      = 0;
    _status.highConviction = 0;
    _masterSignals = [];

    var all = _gatherSignals();
    _status.agentsPolled = 4; // fixed count of specialist agents
    _analyse(all);
  }

  window.GII_INTEL_MASTER = {
    poll:       poll,
    signals:    function () { return _masterSignals.slice(); },
    status:     function () { return Object.assign({}, _status); },
    accuracy:   function () { return Object.assign({}, _accuracy); },
    conviction: function () { return Object.assign({}, _convictionTable); },
  };

  window.addEventListener('load', function () {
    // Start after all specialist agents have had their first poll (they start at 8.5–16s)
    setTimeout(function () { poll(); setInterval(poll, POLL_INTERVAL); }, 22000);
  });

})();
