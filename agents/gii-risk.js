/* GII Risk Agent — gii-risk.js v1
 *
 * Monitors systemic risk conditions that break trade theses regardless of geopolitics.
 * Three pillars:
 *   1. Portfolio stress   — % of open EE trades simultaneously in drawdown
 *   2. Crisis keywords    — financial/systemic crisis language in IC events
 *   3. Balance sheet risk — rapid equity/crypto drawdown across multiple assets
 *
 * When systemic risk is elevated, ALL risk-asset longs become suspect regardless
 * of how good the geopolitical thesis looks. This agent provides that early warning.
 *
 * Exposes: window.GII_AGENT_RISK
 */
(function () {
  'use strict';

  /* ── CONFIG ─────────────────────────────────────────────────────────────── */
  var POLL_MS            = 75 * 1000;
  var INIT_DELAY_MS      = 11 * 1000;
  var SCAN_WINDOW_MS     = 4 * 60 * 60 * 1000;  // 4h lookback for crisis keywords
  var STRESS_THRESHOLD   = 0.40;                 // 40% of open trades in drawdown → stress
  var CRISIS_SCORE_WARN  = 6;                    // keyword score for ELEVATED
  var CRISIS_SCORE_HIGH  = 12;                   // keyword score for HIGH
  var CRISIS_SCORE_CRIT  = 18;                   // keyword score for CRITICAL
  var MAX_SIGNALS        = 12;

  /* Financial / systemic crisis keywords → severity weight */
  var CRISIS_KEYWORDS = {
    /* Banking */
    'bank run':            5,
    'bank failure':        5,
    'bank collapse':       5,
    'bank bailout':        3,
    'bank rescue':         3,
    'fdic':                3,
    'deposit freeze':      5,
    /* Credit */
    'credit crisis':       5,
    'credit crunch':       4,
    'credit event':        4,
    'credit freeze':       5,
    'repo market':         3,
    /* Liquidity */
    'liquidity crisis':    5,
    'liquidity crunch':    4,
    'liquidity freeze':    5,
    'funding crisis':      4,
    /* Margin / leverage */
    'margin call':         4,
    'forced selling':      4,
    'forced liquidation':  5,
    'deleveraging':        3,
    'fire sale':           4,
    /* Contagion / systemic */
    'contagion':           4,
    'systemic risk':       4,
    'systemic crisis':     5,
    'financial contagion': 5,
    /* Default / debt */
    'sovereign default':   5,
    'debt default':        4,
    'debt crisis':         4,
    'bond market collapse':5,
    'yield curve':         2,
    /* Market crash */
    'flash crash':         5,
    'market crash':        5,
    'circuit breaker':     4,
    'trading halt':        3,
    'black monday':        5,
    'black swan':          4,
    /* Currency */
    'currency crisis':     4,
    'currency collapse':   5,
    'hyperinflation':      4,
    'currency devaluation':3,
    /* IMF / central bank emergency */
    'imf intervention':    4,
    'emergency rate':      4,
    'emergency meeting':   3,
    'central bank emergency': 4,
    'quantitative tightening': 2
  };

  /* Risk assets that get SHORT signals when systemic stress detected */
  var RISK_ASSETS = ['BTC', 'ETH', 'SPY', 'QQQ', 'TSLA', 'NVDA', 'SMH', 'TSM', 'FXI', 'WTI', 'BRENT'];

  /* ── STATE ──────────────────────────────────────────────────────────────── */
  var _signals = [];
  var _status  = {
    lastPoll:           0,
    riskLevel:          'NORMAL',   // NORMAL | ELEVATED | HIGH | CRITICAL
    portfolioStressPct: 0,
    crisisScore:        0,
    triggers:           [],
    signalCount:        0
  };
  var _accuracy = {};

  /* ── PILLAR 1: PORTFOLIO STRESS ─────────────────────────────────────────── */
  function _portfolioStressCheck() {
    if (!window.EE || typeof EE.getOpenTrades !== 'function') return null;
    var open = EE.getOpenTrades();
    if (open.length < 3) return null;  // need minimum trades for meaningful signal

    /* Use EE.unrealisedPnl() if available for accurate P&L */
    var unrealised = (typeof EE.unrealisedPnl === 'function') ? EE.unrealisedPnl() : [];
    var pnlMap = {};
    unrealised.forEach(function (u) { pnlMap[u.trade_id] = u.pnlPct; });

    /* Only count trades with confirmed negative P&L as stressed.
       Audit fix: removed the stop-distance proxy (dist < 0.5% flagged as
       "near-stopped"). That logic is backwards — a tight stop means disciplined
       risk management, not distress. Without live price data we cannot know
       if a trade is losing, so we exclude it from the stress count rather than
       guessing wrong and generating false portfolio stress alerts. */
    var inDrawdown = open.filter(function (t) {
      var pnl = pnlMap[t.trade_id];
      return pnl != null && pnl < -1.0;
    });

    var stressPct = inDrawdown.length / open.length;
    _status.portfolioStressPct = Math.round(stressPct * 100);

    if (stressPct >= STRESS_THRESHOLD) {
      return {
        level:          stressPct >= 0.70 ? 'HIGH' : 'ELEVATED',
        stressPct:      stressPct,
        affectedAssets: inDrawdown.map(function (t) { return t.asset; }),
        detail:         Math.round(stressPct * 100) + '% of ' + open.length + ' open trades in drawdown >1%'
      };
    }
    return null;
  }

  /* ── PILLAR 2: CRISIS KEYWORD SCAN ─────────────────────────────────────── */
  function _crisisKeywordCheck() {
    if (!window.__IC || !__IC.events) return null;

    var cutoff = Date.now() - SCAN_WINDOW_MS;
    var recent = __IC.events.filter(function (e) { return e.ts >= cutoff; });

    var totalScore = 0;
    var matched    = [];

    recent.forEach(function (evt) {
      var text = (evt.title + ' ' + (evt.desc || '')).toLowerCase();
      Object.keys(CRISIS_KEYWORDS).forEach(function (kw) {
        if (text.indexOf(kw) !== -1 && matched.indexOf(kw) === -1) {
          totalScore += CRISIS_KEYWORDS[kw];
          matched.push(kw);
        }
      });
    });

    _status.crisisScore = totalScore;

    if (totalScore >= CRISIS_SCORE_WARN) {
      var level = totalScore >= CRISIS_SCORE_CRIT ? 'CRITICAL' :
                  totalScore >= CRISIS_SCORE_HIGH  ? 'HIGH' : 'ELEVATED';
      return {
        level:   level,
        score:   totalScore,
        matched: matched.slice(0, 5),
        detail:  'Crisis keywords detected: ' + matched.slice(0, 4).join(', ')
      };
    }
    return null;
  }

  /* ── MAIN POLL ──────────────────────────────────────────────────────────── */
  function _poll() {
    _status.lastPoll = Date.now();
    _status.triggers = [];
    var newSignals   = [];
    var levelRank    = { NORMAL: 0, ELEVATED: 1, HIGH: 2, CRITICAL: 3 };
    var maxLevel     = 'NORMAL';

    function _upgradeLevel(lvl) {
      if (levelRank[lvl] > levelRank[maxLevel]) maxLevel = lvl;
    }

    /* Pillar 1: portfolio stress */
    var stress = _portfolioStressCheck();
    if (stress) {
      _status.triggers.push('portfolio-stress: ' + stress.detail);
      _upgradeLevel(stress.level);

      var stressConf = Math.min(0.85, 0.55 + stress.stressPct * 0.40);
      stress.affectedAssets.forEach(function (asset) {
        newSignals.push({
          source:       'risk',
          asset:        asset,
          bias:         'short',
          confidence:   stressConf,
          reasoning:    'Portfolio stress: ' + stress.detail,
          timestamp:    Date.now(),
          region:       'GLOBAL',
          evidenceKeys: ['portfolio-stress', 'drawdown'],
          riskLevel:    stress.level
        });
      });
    }

    /* Pillar 2: financial crisis keywords */
    var crisis = _crisisKeywordCheck();
    if (crisis) {
      _status.triggers.push('crisis-keywords (' + crisis.score + 'pts): ' + crisis.matched.slice(0, 3).join(', '));
      _upgradeLevel(crisis.level);

      var crisisConf = Math.min(0.88, 0.50 + crisis.score * 0.02);
      RISK_ASSETS.forEach(function (asset) {
        /* Don't duplicate an asset already flagged by stress check */
        if (!newSignals.some(function (s) { return s.asset === asset; })) {
          newSignals.push({
            source:       'risk',
            asset:        asset,
            bias:         'short',
            confidence:   crisisConf,
            reasoning:    'Systemic risk: ' + crisis.detail,
            timestamp:    Date.now(),
            region:       'GLOBAL',
            evidenceKeys: ['systemic-risk'].concat(crisis.matched.slice(0, 2)),
            riskLevel:    crisis.level
          });
        }
      });
    }

    _status.riskLevel   = maxLevel;
    _status.signalCount = newSignals.length;
    _signals = newSignals.slice(0, MAX_SIGNALS);

    if (maxLevel !== 'NORMAL') {
      console.warn('[GII-RISK] ⚠ Risk level: ' + maxLevel + ' | ' + _status.triggers.join(' | '));
    }
  }

  /* ── PUBLIC API ─────────────────────────────────────────────────────────── */
  window.GII_AGENT_RISK = {
    poll:     _poll,
    signals:  function () { return _signals.slice(); },
    status:   function () { return Object.assign({}, _status); },
    accuracy: function () { return _accuracy; },

    // Consultation: systemic risk level affects all trades
    consult: function (asset, dir) {
      var s  = _status;
      var ts = s.lastPoll;
      if (!s.riskLevel || s.riskLevel === 'NORMAL') return { vote: 'abstain', weight: 0, reason: 'risk normal', ts: ts };
      var norm   = String(asset || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      var sec    = (window.EE_SECTOR_MAP || {})[norm] || '';
      var isSafe = sec === 'precious' || norm === 'VXX' || norm === 'VIX';
      var dirUp  = (dir || '').toUpperCase();
      var wt = s.riskLevel === 'CRITICAL' ? 0.85 : s.riskLevel === 'HIGH' ? 0.70 : 0.50;
      if (isSafe && dirUp === 'LONG')
        return { vote: 'support', weight: +(wt * 0.7).toFixed(2), reason: 'systemic risk ' + s.riskLevel + ' — safe haven long OK', ts: ts };
      return { vote: 'oppose', weight: wt, reason: 'systemic risk ' + s.riskLevel + ' — reduce exposure', ts: ts };
    }
  };

  /* ── INIT ───────────────────────────────────────────────────────────────── */
  window.addEventListener('load', function () {
    setTimeout(function () {
      _poll();
      setInterval(_poll, POLL_MS);
      console.log('[GII-RISK] Systemic risk monitor online — portfolio stress + crisis keyword scanning');
    }, INIT_DELAY_MS);
  });

})();
