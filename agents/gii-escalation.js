/* GII Escalation Ladder Agent — gii-escalation.js v1
 * Tracks geopolitical conflicts on a 0–10 escalation ladder per region.
 * Detects level transitions and estimates up/down probabilities.
 *
 * Escalation levels:
 *   0  — Stable / normal diplomatic relations
 *   1  — Political tension (rhetoric, diplomatic incidents)
 *   2  — Economic pressure / sanctions
 *   3  — Hybrid conflict (cyber, proxy, covert)
 *   4  — Military posturing (exercises, mobilisation, threats)
 *   5  — Limited strikes (targeted airstrikes, missile/drone attacks)
 *   6  — Regional conflict escalation (ground offensive, ongoing fighting)
 *   7  — Strategic infrastructure attacks (pipelines, power grids, ports)
 *   8  — Full regional war
 *   9  — Global economic shock
 *   10 — Great power conflict
 *
 * Reads: window.__IC.events, window.__IC.regionStates
 * Exposes: window.GII_AGENT_ESCALATION
 */
(function () {
  'use strict';

  var MAX_SIGNALS   = 20;
  var POLL_INTERVAL = 85000;
  var STORAGE_KEY   = 'gii_escalation_v1';
  var MAX_LEVEL_JUMP = 2;  // ladder can only move ±2 levels per cycle (prevents wild swings)

  // ── Monitored regions ─────────────────────────────────────────────────────

  var MONITORED_REGIONS = [
    'UKRAINE', 'IRAN', 'TAIWAN', 'MIDDLE EAST', 'NORTH KOREA',
    'RED SEA', 'SOUTH CHINA SEA', 'RUSSIA', 'ISRAEL', 'GLOBAL'
  ];

  // ── Level definitions ─────────────────────────────────────────────────────

  var LEVEL_DEFS = [
    { level: 0,  label: 'Stable',                   threshold: 0, keywords: [] },
    { level: 1,  label: 'Political Tension',         threshold: 2, keywords: [
      'diplomatic incident', 'expel ambassador', 'recall ambassador', 'summon ambassador',
      'diplomatic protest', 'political crisis', 'diplomatic row', 'harsh rhetoric',
      'political standoff', 'state department warning', 'foreign ministry condemns',
      'verbal confrontation', 'diplomatic tensions', 'protests erupt'
    ]},
    { level: 2,  label: 'Economic Pressure',         threshold: 2, keywords: [
      'sanction', 'embargo', 'trade restriction', 'economic pressure', 'asset freeze',
      'tariff threat', 'trade war', 'economic coercion', 'financial restriction',
      'export ban', 'import ban', 'technology ban', 'supply chain decoupling'
    ]},
    { level: 3,  label: 'Hybrid Conflict',           threshold: 2, keywords: [
      'cyberattack', 'cyber attack', 'sabotage', 'proxy attack', 'covert operation',
      'disinformation campaign', 'hybrid warfare', 'assassination attempt',
      'special forces', 'irregular warfare', 'covert activity', 'sabotage operation',
      'infrastructure hacking', 'state-sponsored attack'
    ]},
    { level: 4,  label: 'Military Posturing',        threshold: 2, keywords: [
      'military exercise', 'troop deployment', 'naval deployment', 'military buildup',
      'missile test', 'mobilization', 'military threat', 'forces massed',
      'troops massing', 'military readiness', 'combat readiness', 'strategic deployment',
      'warship deployment', 'carrier deployment', 'forces mobilized'
    ]},
    { level: 5,  label: 'Limited Strikes',           threshold: 1, keywords: [
      'airstrike', 'missile strike', 'drone strike', 'targeted strike', 'bombardment',
      'shelling', 'attack on military', 'limited military action', 'precision strike',
      'rocket attack', 'cross-border attack', 'retaliatory strike', 'artillery fire'
    ]},
    { level: 6,  label: 'Regional Conflict',         threshold: 1, keywords: [
      'ground invasion', 'offensive launched', 'military offensive', 'troops crossing border',
      'border incursion', 'armored attack', 'full-scale assault', 'forces enter',
      'military advance', 'territorial gains', 'frontline fighting', 'combat operations'
    ]},
    { level: 7,  label: 'Infrastructure Attacks',    threshold: 1, keywords: [
      'pipeline explosion', 'power grid attack', 'infrastructure strike',
      'critical infrastructure attack', 'refinery attack', 'port attack',
      'strategic strike', 'electricity network attack', 'water supply attack',
      'communications infrastructure attack', 'oil facility attack'
    ]},
    { level: 8,  label: 'Full Regional War',         threshold: 1, keywords: [
      'total war', 'all-out war', 'massive offensive', 'full invasion',
      'capital under attack', 'siege', 'war escalation', 'major escalation',
      'open warfare', 'battlefield advance', 'full military assault'
    ]},
    { level: 9,  label: 'Global Economic Shock',     threshold: 1, keywords: [
      'global recession', 'market crash', 'financial crisis global', 'supply chain collapse',
      'energy crisis global', 'food crisis global', 'systemic collapse', 'economic meltdown',
      'global supply shock', 'contagion spreading'
    ]},
    { level: 10, label: 'Great Power Conflict',      threshold: 1, keywords: [
      'nuclear threat', 'nato article 5', 'great power war', 'superpower conflict',
      'nuclear alert', 'nuclear escalation', 'nuclear warning', 'nuclear standoff',
      'direct military confrontation nato', 'us china military conflict', 'us russia military'
    ]}
  ];

  // ── Signal templates per escalation level ────────────────────────────────
  // confMult scales with region prior in actual signal generation

  var LEVEL_SIGNALS = {
    1:  [{ asset: 'GLD', bias: 'long',  cm: 0.55 }],
    2:  [{ asset: 'GLD', bias: 'long',  cm: 0.60 }, { asset: 'WTI', bias: 'long', cm: 0.50 }],
    3:  [{ asset: 'GLD', bias: 'long',  cm: 0.65 }, { asset: 'WTI', bias: 'long', cm: 0.55 }],
    4:  [{ asset: 'GLD', bias: 'long',  cm: 0.70 }, { asset: 'WTI', bias: 'long', cm: 0.65 },
         { asset: 'XLE', bias: 'long',  cm: 0.55 }],
    5:  [{ asset: 'GLD', bias: 'long',  cm: 0.75 }, { asset: 'WTI', bias: 'long', cm: 0.70 },
         { asset: 'XLE', bias: 'long',  cm: 0.60 }],
    6:  [{ asset: 'GLD', bias: 'long',  cm: 0.80 }, { asset: 'WTI', bias: 'long', cm: 0.75 },
         { asset: 'SPY', bias: 'short', cm: 0.65 }],
    7:  [{ asset: 'GLD', bias: 'long',  cm: 0.82 }, { asset: 'WTI', bias: 'long', cm: 0.78 },
         { asset: 'XLE', bias: 'long',  cm: 0.70 }, { asset: 'SPY', bias: 'short', cm: 0.70 }],
    8:  [{ asset: 'GLD', bias: 'long',  cm: 0.85 }, { asset: 'WTI', bias: 'long', cm: 0.80 },
         { asset: 'SPY', bias: 'short', cm: 0.75 }, { asset: 'BTC', bias: 'short', cm: 0.65 }],
    9:  [{ asset: 'GLD', bias: 'long',  cm: 0.88 }, { asset: 'SPY', bias: 'short', cm: 0.80 },
         { asset: 'BTC', bias: 'short', cm: 0.72 }, { asset: 'TLT', bias: 'long',  cm: 0.65 }],
    10: [{ asset: 'GLD', bias: 'long',  cm: 0.90 }, { asset: 'SPY', bias: 'short', cm: 0.85 },
         { asset: 'BTC', bias: 'short', cm: 0.78 }, { asset: 'TLT', bias: 'long',  cm: 0.70 }]
  };

  // Region-specific primary asset overrides
  var REGION_ASSET_OVERRIDE = {
    'TAIWAN':         'TSM',
    'SOUTH CHINA SEA':'TSM'
  };

  var _signals   = [];
  var _ladder    = {};   // { REGION: { level, prevLevel, trend, probUp, probDown, lastTransitionTs } }
  var _status = {
    lastPoll:       null,
    highestLevel:   0,
    highestRegion:  null,
    activeRegions:  [],
    escalatingNow:  [],
    deescalatingNow:[]
  };
  var _accuracy = { total: 0, correct: 0, winRate: null };

  // ── helpers ───────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  function _countKeywordMatches(text, keywords) {
    if (!text || !keywords.length) return 0;
    var t = text.toLowerCase();
    var n = 0;
    for (var i = 0; i < keywords.length; i++) {
      if (t.indexOf(keywords[i]) !== -1) n++;
    }
    return n;
  }

  var _CACHE_TTL = 86400000; // 24h

  function _save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ts: Date.now(), data: _ladder })); } catch (e) {}
  }

  function _load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.ts && (Date.now() - parsed.ts) < _CACHE_TTL) {
          _ladder = parsed.data;
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
    } catch (e) {}
  }

  // ── level detection ───────────────────────────────────────────────────────

  function _detectLevel(region, events) {
    // Score each level by keyword matches in region-relevant events
    var levelScores = {};
    LEVEL_DEFS.forEach(function (def) {
      if (!def.keywords.length) { levelScores[def.level] = 0; return; }
      var score = 0;
      events.forEach(function (e) {
        var text = (e.title || e.headline || e.text || '');
        score += _countKeywordMatches(text, def.keywords);
      });
      levelScores[def.level] = score;
    });

    // Find highest level that exceeds its threshold
    var detectedLevel = 0;
    for (var i = LEVEL_DEFS.length - 1; i >= 0; i--) {
      var def = LEVEL_DEFS[i];
      if (def.threshold === 0) continue;
      if (levelScores[def.level] >= def.threshold) {
        detectedLevel = def.level;
        break;
      }
    }
    return detectedLevel;
  }

  // ── analysis ──────────────────────────────────────────────────────────────

  function _analyseRegion(region) {
    var IC = window.__IC;
    if (!IC || !IC.events) return;

    var now    = Date.now();
    var cutoff = now - 24 * 60 * 60 * 1000;

    // Get events relevant to this region
    var regionEvents = IC.events.filter(function (e) {
      if (e.ts <= cutoff) return false;
      var r = (e.region || '').toUpperCase();
      return r === region || r.indexOf(region) !== -1 || region.indexOf(r) !== -1;
    });

    // Add high-signal global events
    var globalHighEvents = IC.events.filter(function (e) {
      return e.ts > cutoff && (!e.region || e.region === 'GLOBAL') && (e.signal || 0) >= 70;
    });

    var allRelevant = regionEvents.concat(globalHighEvents);
    var rawLevel = _detectLevel(region, allRelevant);

    // Get or init ladder state for this region
    if (!_ladder[region]) {
      _ladder[region] = { level: 0, prevLevel: 0, trend: 0, probUp: 0.15, probDown: 0.15, lastTransitionTs: null };
    }
    var state = _ladder[region];
    var prevLevel = state.level;

    // Smooth: max jump of ±MAX_LEVEL_JUMP per cycle
    var delta = rawLevel - prevLevel;
    if (delta > MAX_LEVEL_JUMP)  delta = MAX_LEVEL_JUMP;
    if (delta < -MAX_LEVEL_JUMP) delta = -MAX_LEVEL_JUMP;
    var newLevel = _clamp(prevLevel + delta, 0, 10);

    state.prevLevel = prevLevel;
    state.level     = newLevel;
    state.trend     = newLevel - prevLevel;  // +ve = escalating, -ve = de-escalating

    // Estimate probabilities using IC regionStates as prior
    var prior = 0.20;
    if (IC.regionStates && IC.regionStates[region]) {
      prior = _clamp((IC.regionStates[region].prob || 0) / 100, 0.05, 0.95);
    }
    state.probUp   = _clamp(prior + (newLevel / 20), 0.05, 0.90);
    state.probDown = _clamp((1 - prior) * 0.30, 0.05, 0.50);

    // Detect transition
    var transitioned = newLevel !== prevLevel;
    if (transitioned) state.lastTransitionTs = now;

    // ── Emit signals ──────────────────────────────────────────────────────

    if (newLevel === 0) return; // nothing to signal at level 0

    var levelDef      = LEVEL_DEFS[newLevel] || LEVEL_DEFS[LEVEL_DEFS.length - 1];
    var levelSignals  = LEVEL_SIGNALS[newLevel] || LEVEL_SIGNALS[8];
    var regionOverride = REGION_ASSET_OVERRIDE[region];

    // Scale confidence by level magnitude + prior
    var baseConf = _clamp(0.30 + newLevel * 0.055 + prior * 0.20, 0.30, 0.90);

    if (transitioned && state.trend > 0) {
      // ── ESCALATION transition signal ─────────────────────────────────
      var transConf = _clamp(baseConf * 1.15, 0.35, 0.90);
      var transLabel = '[ESCALATION L' + prevLevel + '→L' + newLevel + '] ' + region +
                       ' — ' + levelDef.label;

      levelSignals.forEach(function (tmpl) {
        var asset = (regionOverride && tmpl.bias === 'long') ? regionOverride : tmpl.asset;
        _pushSignal({
          source:       'escalation',
          asset:        asset,
          bias:         tmpl.bias,
          confidence:   _clamp(transConf * tmpl.cm, 0.28, 0.90),
          reasoning:    transLabel,
          region:       region,
          evidenceKeys: ['escalation', 'level ' + newLevel, levelDef.label.toLowerCase()]
        });
      });

    } else if (transitioned && state.trend < 0) {
      // ── DE-ESCALATION transition signal ──────────────────────────────
      var deLabel = '[DE-ESCALATION L' + prevLevel + '→L' + newLevel + '] ' + region;
      _pushSignal({
        source:       'escalation',
        asset:        regionOverride || 'SPY',
        bias:         'long',
        confidence:   _clamp(baseConf * 0.65, 0.25, 0.72),
        reasoning:    deLabel + ' — risk-off unwind, equities recovery signal',
        region:       region,
        evidenceKeys: ['de-escalation', 'level drop', 'risk-off unwind']
      });
      _pushSignal({
        source:       'escalation',
        asset:        'GLD',
        bias:         'short',
        confidence:   _clamp(baseConf * 0.55, 0.20, 0.65),
        reasoning:    deLabel + ' — safe-haven demand easing',
        region:       region,
        evidenceKeys: ['de-escalation', 'gold unwind']
      });

    } else if (!transitioned && newLevel >= 4) {
      // ── Sustained high-level signal (no transition but level is elevated) ─
      _pushSignal({
        source:       'escalation',
        asset:        regionOverride || (LEVEL_SIGNALS[newLevel][0] && LEVEL_SIGNALS[newLevel][0].asset) || 'GLD',
        bias:         'long',
        confidence:   _clamp(baseConf * 0.85, 0.28, 0.82),
        reasoning:    '[SUSTAINED L' + newLevel + '] ' + region + ' — ' + levelDef.label + ' (ongoing)',
        region:       region,
        evidenceKeys: ['escalation sustained', 'level ' + newLevel, levelDef.label.toLowerCase()]
      });
    }
  }

  // ── public poll ───────────────────────────────────────────────────────────

  function _analyseAll() {
    _signals = []; // fresh rebuild each cycle

    var highestLevel = 0;
    var highestRegion = null;
    var activeRegions = [];
    var escalating  = [];
    var deescalating = [];

    MONITORED_REGIONS.forEach(function (region) {
      _analyseRegion(region);
      var state = _ladder[region];
      if (!state) return;
      if (state.level > 0) activeRegions.push(region);
      if (state.level > highestLevel) { highestLevel = state.level; highestRegion = region; }
      if (state.trend > 0) escalating.push(region);
      if (state.trend < 0) deescalating.push(region);
    });

    _status.highestLevel    = highestLevel;
    _status.highestRegion   = highestRegion;
    _status.activeRegions   = activeRegions;
    _status.escalatingNow   = escalating;
    _status.deescalatingNow = deescalating;

    _save();
  }

  function poll() {
    _status.lastPoll = Date.now();
    _analyseAll();
  }

  // ── public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_ESCALATION = {
    poll:         poll,
    signals:      function () { return _signals.slice(); },
    status:       function () { return Object.assign({}, _status); },
    accuracy:     function () { return Object.assign({}, _accuracy); },
    ladderStatus: function () { return JSON.parse(JSON.stringify(_ladder)); }  // full ladder for UI
  };

  window.addEventListener('load', function () {
    _load(); // restore saved escalation state
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 9700);
  });

})();
