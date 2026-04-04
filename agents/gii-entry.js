/**
 * GII Entry Agent — central intelligence hub for trade entry decisions.
 *
 * Behaves like a head trader surrounded by analysts:
 *   • Receives pending signals from IC pipeline and GII core
 *   • Scores each signal against ALL other agents (confluence)
 *   • Only fires trades when multiple independent sources agree
 *   • Applies vetoes from macro, regime, and health agents
 *   • Stores a thesis fingerprint on every approved trade
 *
 * Signal flow:
 *   renderTrades()  ──┐
 *   gii-core        ──┼──► GII_AGENT_ENTRY.submit() ──► (score) ──► EE.onSignals()
 *   (any agent)     ──┘
 *
 * Exposes window.GII_AGENT_ENTRY
 */
(function () {
  'use strict';

  /* ── CONFIG ─────────────────────────────────────────────────────────────── */
  var POLL_MS       = 15 * 1000;   // process queue every 15s (was 60s — P0 latency fix)
  var INIT_DELAY_MS = 12 * 1000;   // wait for other agents to boot
  var QUEUE_TTL_MS  = 8 * 60 * 1000; // discard pending signals older than 8 min
  var QUEUE_MAX     = 200;         // hard cap on queue depth (P2 unbounded queue fix)

  /* Minimum confluence score to approve entry — source-aware tiers (Option 2) */
  var MIN_SCORE_GEO     = 4.0;   // IC geopolitical trades — threshold for OSINT-driven signals
  var MIN_SCORE_GII     = 5.0;   // GII multi-agent trades
  var MIN_SCORE_SCALPER = 2.5;   // Scalper trades — fast path, already technically vetted
  var MIN_SCORE_STANDALONE = 3.5; // Standalone agent signals (momentum, correlation, etc.)
  var MIN_SCORE_FLOW    = 3.0;   // High-quality flow data (uw-intelligence)

  /* ── AGENT CORRELATION GROUPS (P1-A) ───────────────────────────────────────
     Agents within the same group share data sources or use near-identical logic.
     During scoring, only the strongest vote within a group counts — rest are
     zeroed out to prevent false consensus from correlated inputs.              */
  var AGENT_CORR_GROUPS = [
    ['GII_AGENT_SCALPER', 'GII_AGENT_SCALPER_SESSION'],              // same strategy, different hours
    ['GII_AGENT_TECHNICALS', 'GII_AGENT_TA_SCANNER'],                // both compute TA from same feeds
    ['GII_AGENT_MOMENTUM', 'GII_AGENT_MARKET_OBSERVER'],             // both price-momentum from HLFeed
    ['GII_AGENT_ENERGY', 'GII_AGENT_CONFLICT', 'GII_AGENT_SANCTIONS'], // geopolitical cluster
  ];

  /* ── AGENT DATA SOURCE TAGS (P1-A) ────────────────────────────────────────
     Maps agents to their primary data source. Used to calculate source diversity
     multiplier — multiple agents from the same source count as thin consensus.  */
  var AGENT_DATA_SOURCES = {
    'GII_AGENT_SCALPER':          'cryptocompare',
    'GII_AGENT_SCALPER_SESSION':  'cryptocompare',
    'GII_AGENT_TECHNICALS':       'hlfeed',
    'GII_AGENT_TA_SCANNER':       'hlfeed',
    'GII_AGENT_MOMENTUM':         'hlfeed',
    'GII_AGENT_MARKET_OBSERVER':  'hlfeed',
    'GII_AGENT_CORRELATION':      'hlfeed',
    'GII_AGENT_SMARTMONEY':       'hlfeed',
    'GII_AGENT_MARKETSTRUCTURE':  'hlfeed',
    'GII_AGENT_OPTIMIZER':        'hlfeed',
    'GII_AGENT_ENERGY':           'geopolitical',
    'GII_AGENT_CONFLICT':         'geopolitical',
    'GII_AGENT_SANCTIONS':        'geopolitical',
    'GII_AGENT_MARITIME':         'geopolitical',
    'GII_AGENT_SOCIAL':           'social',
    'GII_AGENT_POLYMARKET':       'polymarket',
    'GII_AGENT_MACRO':            'macro',
    'GII_AGENT_REGIME':           'macro',
  };

  /* IC-adjacent assets: the only assets where geopolitical/OSINT catalysts
     produce moves large enough to reach 2.5R. Evidence from 315-trade audit:
     - TSLA: +$73.37 total (IC source), expectancy +$9.17, R:R 5.47
     - VXX:  +$11.90 total (IC source), expectancy +$1.98, R:R 27.3
     GII signals on XLE, BRENT, QQQ, TSM, FXI, GLD produced no positive expectancy
     — those assets absorb geopolitical catalysts too slowly for 2.5R targets.
     GII signals restricted to this list. IC signals have no asset restriction. */
  var GII_ALLOWED_ASSETS = {
    'TSLA': true, 'VXX': true, 'LMT': true, 'RTX': true,
    'NVDA': true, 'BTC': true, 'ETH': true, 'XAR': true, 'SMH': true,
    /* Safe-haven / macro assets — re-enabled now OANDA CFD prices available */
    'GLD':  true, 'XAU': true, 'SLV': true,
    'WTI':  true, 'BRENT': true, 'GAS': true,
  };

  /* Minimum number of distinct agent categories that must agree */
  var MIN_CATEGORIES = 2;   /* lowered from 3 → 2: more trades get through for xyz testing */

  /* Minimum ms between approvals for the same asset (prevents runaway re-fire
     after a trade closes and the same escalation chain immediately re-queues) */
  var APPROVED_COOLDOWN_MS = 30 * 60 * 1000;  // 30 minutes

  /* Defensive / risk asset lists — canonical source is GII.defensiveAssets() /
     GII.riskAssets(). Static fallbacks used only if GII loads after this IIFE. */
  var DEFENSIVE   = (window.GII && typeof GII.defensiveAssets === 'function')
                    ? GII.defensiveAssets()
                    : ['GLD', 'XAU', 'SLV', 'JPY', 'CHF', 'VIX', 'TLT', 'GAS'];
  var RISK_ASSETS = (window.GII && typeof GII.riskAssets === 'function')
                    ? GII.riskAssets()
                    : ['BTC', 'SPY', 'QQQ', 'TSM', 'NVDA', 'TSLA', 'SMH', 'FXI'];

  /* ── PER-ASSET VOLATILITY STOPS ─────────────────────────────────────────
   * Flat 3% stops get hit by normal noise on high-vol assets (BTC moves 3%
   * in hours on a quiet day). These stopPct / tpRatio values are attached to
   * every approved signal — EE.buildTrade() reads them instead of the flat
   * config. tpRatio 2.5 on all assets (vs default 2.0) improves expectancy. */
  var VOL_STOPS = {
    'BTC':   { stopPct: 6.0, tpRatio: 2.5 },  /* Crypto — widest */
    'ETH':   { stopPct: 7.0, tpRatio: 2.5 },
    'TSLA':  { stopPct: 5.5, tpRatio: 2.5 },  /* High-vol equities */
    'NVDA':  { stopPct: 5.0, tpRatio: 2.5 },
    'SMH':   { stopPct: 4.0, tpRatio: 2.5 },
    'TSM':   { stopPct: 4.0, tpRatio: 2.5 },
    'FXI':   { stopPct: 4.0, tpRatio: 2.5 },
    'WTI':   { stopPct: 3.5, tpRatio: 2.5 },  /* Energy */
    'BRENT': { stopPct: 3.5, tpRatio: 2.5 },
    'XLE':   { stopPct: 3.0, tpRatio: 2.5 },
    'GAS':   { stopPct: 4.5, tpRatio: 2.5 },
    'SPY':   { stopPct: 2.5, tpRatio: 2.5 },  /* Broad market */
    'QQQ':   { stopPct: 2.5, tpRatio: 2.5 },
    'GLD':   { stopPct: 2.0, tpRatio: 2.5 },  /* Safe-haven / low-vol */
    'XAU':   { stopPct: 2.0, tpRatio: 2.5 },
    'SLV':   { stopPct: 2.5, tpRatio: 2.5 },
    'TLT':   { stopPct: 1.5, tpRatio: 2.5 },
    /* Forex majors — tight stops, forex moves in small % increments */
    'EURUSD': { stopPct: 0.5, tpRatio: 2.5 },
    'GBPUSD': { stopPct: 0.6, tpRatio: 2.5 },
    'USDJPY': { stopPct: 0.5, tpRatio: 2.5 },
    'USDCHF': { stopPct: 0.5, tpRatio: 2.5 },
    'AUDUSD': { stopPct: 0.6, tpRatio: 2.5 },
    'USDCAD': { stopPct: 0.5, tpRatio: 2.5 },
    'NZDUSD': { stopPct: 0.6, tpRatio: 2.5 },
    'GBPJPY': { stopPct: 0.7, tpRatio: 2.5 },
    'EURJPY': { stopPct: 0.6, tpRatio: 2.5 },
    'EURGBP': { stopPct: 0.5, tpRatio: 2.5 },
    'EUR':    { stopPct: 0.5, tpRatio: 2.5 },
    'GBP':    { stopPct: 0.6, tpRatio: 2.5 },
    'JPY':    { stopPct: 0.5, tpRatio: 2.5 },
    'CHF':    { stopPct: 0.5, tpRatio: 2.5 },
    'AUD':    { stopPct: 0.6, tpRatio: 2.5 },
    'CAD':    { stopPct: 0.5, tpRatio: 2.5 },
    'VIX':    { stopPct: 8.0, tpRatio: 2.0 },  /* VIX is extremely volatile */
    'VXX':    { stopPct: 6.0, tpRatio: 2.0 },  /* VXX ETF — same signal, lower raw vol than VIX index */
    'SILVER': { stopPct: 2.5, tpRatio: 2.5 },  /* v54: was missing — fell through to 3% default */
    'CRUDE':  { stopPct: 3.5, tpRatio: 2.5 },  /* v54: alias for WTI */
    'OIL':    { stopPct: 3.5, tpRatio: 2.5 },  /* v54: alias for WTI */
    /* ── Crypto altcoins — wider stops needed for intraday volatility ── */
    'SOL':    { stopPct: 5.0, tpRatio: 2.5 },
    'BNB':    { stopPct: 4.5, tpRatio: 2.5 },
    'XRP':    { stopPct: 5.0, tpRatio: 2.5 },
    'ADA':    { stopPct: 5.0, tpRatio: 2.5 },
    'AVAX':   { stopPct: 5.5, tpRatio: 2.5 },
    'DOT':    { stopPct: 5.5, tpRatio: 2.5 },
    'LINK':   { stopPct: 5.5, tpRatio: 2.5 },
    'LTC':    { stopPct: 5.0, tpRatio: 2.5 },
    'BCH':    { stopPct: 5.0, tpRatio: 2.5 },
    'UNI':    { stopPct: 6.0, tpRatio: 2.5 },
    'AAVE':   { stopPct: 6.0, tpRatio: 2.5 },
    'ATOM':   { stopPct: 5.5, tpRatio: 2.5 },
    'NEAR':   { stopPct: 5.5, tpRatio: 2.5 },
    'SUI':    { stopPct: 6.0, tpRatio: 2.5 },
    'APT':    { stopPct: 6.0, tpRatio: 2.5 },
    'ARB':    { stopPct: 5.5, tpRatio: 2.5 },
    'OP':     { stopPct: 5.5, tpRatio: 2.5 },
    'TRX':    { stopPct: 5.0, tpRatio: 2.5 },
    'TON':    { stopPct: 5.5, tpRatio: 2.5 },
    'ICP':    { stopPct: 6.0, tpRatio: 2.5 },
    'SEI':    { stopPct: 6.5, tpRatio: 2.5 },
    'INJ':    { stopPct: 6.5, tpRatio: 2.5 },
    'RUNE':   { stopPct: 7.0, tpRatio: 2.5 },
    'MKR':    { stopPct: 5.5, tpRatio: 2.5 },
    'SNX':    { stopPct: 7.0, tpRatio: 2.5 },
    'CRV':    { stopPct: 7.0, tpRatio: 2.5 },
    'GMX':    { stopPct: 7.0, tpRatio: 2.5 },
    'COMP':   { stopPct: 6.0, tpRatio: 2.5 },
    /* ── Meme / high-volatility tokens ── */
    'DOGE':   { stopPct: 8.0, tpRatio: 2.5 },
    'WIF':    { stopPct: 9.0, tpRatio: 2.5 },
    'PEPE':   { stopPct: 10.0, tpRatio: 2.5 },
    'BONK':   { stopPct: 10.0, tpRatio: 2.5 },
    'TRUMP':  { stopPct: 10.0, tpRatio: 2.5 },
    'WLD':    { stopPct: 8.0, tpRatio: 2.5 },
    'HYPE':   { stopPct: 8.0, tpRatio: 2.5 },
    /* ── AI / tech tokens ── */
    'TAO':    { stopPct: 8.0, tpRatio: 2.5 },
    'RENDER': { stopPct: 7.5, tpRatio: 2.5 },
    'ONDO':   { stopPct: 7.0, tpRatio: 2.5 },
    'ENA':    { stopPct: 8.0, tpRatio: 2.5 },
    'EIGEN':  { stopPct: 7.5, tpRatio: 2.5 },
    'TIA':    { stopPct: 7.5, tpRatio: 2.5 },
    'PYTH':   { stopPct: 7.5, tpRatio: 2.5 },
    'JUP':    { stopPct: 7.0, tpRatio: 2.5 },
    /* ── Commodity / precious metals on HL ── */
    'PAXG':   { stopPct: 2.0, tpRatio: 2.5 },
    'GAS':    { stopPct: 4.5, tpRatio: 2.5 },
    'NATGAS': { stopPct: 4.5, tpRatio: 2.5 }
  };
  var VOL_STOP_DEFAULT = { stopPct: 3.0, tpRatio: 2.5 };

  /* Max trades that can be opened from a single news event (signal.reason prefix).
     Prevents one "Iran Escalation" headline from opening 10+ correlated positions. */
  var MAX_TRADES_PER_EVENT = 3;

  /* ── STATE ──────────────────────────────────────────────────────────────── */
  var _initialized  = false;
  var _queue        = [];   // pending signals awaiting scoring
  var _approved     = [];   // last 50 approved signals (audit log)
  var _rejected     = [];   // last 50 rejected signals (audit log)
  var _lastPoll     = 0;
  var _lastApproved = {};   // asset → timestamp of last approval (runaway-loop guard)
  var _stats        = { submitted: 0, approved: 0, rejected: 0, vetoed: 0, rotated: 0 };
  var _processing   = false;  // mutex guard — prevents overlapping _processQueue runs (P2)
  var _shadowLog    = [];     // shadow mode log: { asset, dir, source, wouldApprove, score, ts } (P0-C)
  var _lastProcessedAt = 0;   // health heartbeat: last successful queue processing time (P2-D)
  var _approvalWindows = [];  // rolling approval-rate windows for health monitoring (P2-D)

  /* ── QUEUE ──────────────────────────────────────────────────────────────── */
  function _submit(signals, sourceTag) {
    var now = Date.now();
    (Array.isArray(signals) ? signals : [signals]).forEach(function (s) {
      if (!s || !s.asset || !s.dir) return;
      // Reject malformed confidence values (must be 0-100 or absent for default)
      if (s.conf !== undefined && s.conf !== null && (!isFinite(s.conf) || s.conf < 0 || s.conf > 100)) {
        _stats.rejected++;
        _rejected.unshift({ asset: s.asset, dir: s.dir,
          reason: 'invalid conf ' + s.conf + ' (must be 0-100)', ts: now });
        if (_rejected.length > 50) _rejected.pop();
        return;
      }
      var _src = sourceTag || s.source || 'ic';
      var _isScalperSrc = _src === 'scalper' || _src === 'scalper-session' ||
                          (s.reason && s.reason.indexOf('SCALPER') === 0);

      /* P1-C: Dual timestamps — preserve when the agent generated the signal
         vs when entry processes it. generated_at is used by gatekeeper for
         analytical staleness; timestamp is refreshed on approval for processing freshness. */
      s.generated_at = s.timestamp || now;

      /* P0-B: FAST PATH for scalper signals — score inline, skip the queue.
         The 15s queue cycle can still introduce latency that kills 45-second
         scalper staleness windows. Scalpers get scored and emitted immediately. */
      if (_isScalperSrc) {
        _stats.submitted++;
        var item = { sig: s, source: _src, queuedAt: now };
        _scoreFastPath(item);
        return;
      }

      _stats.submitted++;
      /* P2-A: Queue cap — drop oldest if at limit to prevent unbounded growth */
      if (_queue.length >= QUEUE_MAX) {
        var dropped = _queue.shift();
        _stats.rejected++;
        _rejected.unshift({ asset: dropped.sig.asset, dir: dropped.sig.dir,
          reason: 'queue-cap-overflow (' + QUEUE_MAX + ' max)', ts: now });
        if (_rejected.length > 50) _rejected.pop();
      }
      _queue.push({
        sig:       s,
        source:    _src,
        queuedAt:  now
      });
    });
  }

  /* ── SHADOW MODE (P0-C) ────────────────────────────────────────────────────
     During phased rollout, agents call shadow() instead of submit().
     Scores the signal exactly as submit() would, but logs result without
     emitting to EE. Compare shadowLog() against actual trade outcomes to
     validate before cutover.                                                  */
  function _shadow(signals, sourceTag) {
    var now = Date.now();
    (Array.isArray(signals) ? signals : [signals]).forEach(function (s) {
      if (!s || !s.asset || !s.dir) return;
      var _src = sourceTag || s.source || 'unknown';
      var _isScalper = _src === 'scalper' || _src === 'scalper-session';
      var item = { sig: s, source: _src, queuedAt: now };
      s.generated_at = s.timestamp || now;

      var veto = _veto(item);
      var result = veto ? { score: 0, categories: 0, agentsFor: [], agentsAgainst: [] } : _scoreSignal(item);
      var minScore = _getMinScore(_src);
      var minCats  = _getMinCategories(_src);
      _shadowLog.unshift({
        asset: s.asset, dir: s.dir, source: _src,
        wouldApprove: !veto && result.score >= minScore && result.categories >= minCats,
        score: +result.score.toFixed(2),
        categories: result.categories,
        needed: minScore,
        vetoReason: veto || null,
        agentsFor: result.agentsFor,
        agentsAgainst: result.agentsAgainst,
        ts: now
      });
      if (_shadowLog.length > 200) _shadowLog.pop();
    });
  }

  /* ── SOURCE-AWARE SCORING TIERS (Option 2) ─────────────────────────────── */
  function _getMinScore(sourceTag) {
    switch (sourceTag) {
      case 'scalper':
      case 'scalper-session':    return MIN_SCORE_SCALPER;
      case 'ic':                 return MIN_SCORE_GEO;
      case 'uw-intelligence':    return MIN_SCORE_FLOW;
      case 'gii': case 'gii-core': return MIN_SCORE_GII;
      default:                   return MIN_SCORE_STANDALONE;
    }
  }

  function _getMinCategories(sourceTag) {
    switch (sourceTag) {
      case 'scalper':
      case 'scalper-session':    return 1;   // TA alone sufficient for scalps
      default:                   return MIN_CATEGORIES;
    }
  }

  /* ── CONFLUENCE SCORING ─────────────────────────────────────────────────── */

  /* Returns the dominant bias ('long'/'short') and count from an agent's signals
     filtered to assets matching or related to the target asset/region */
  function _agentBias(agentName, asset, dir, region) {
    var agent = window[agentName];
    if (!agent) return null;
    var sigs = [];
    try { sigs = agent.signals ? agent.signals() : []; } catch (e) { return null; }
    if (!sigs.length) return null;

    /* Find signals agreeing with this asset or region.
       NO direction-only fallback — that was causing false confluence:
       unrelated agents (e.g. Energy agent bearish on WTI) were falsely
       "confirming" BTC shorts just because both happened to be bearish.
       If this agent has no signals for the specific asset or region,
       it abstains from the score (returns null). */
    var relevant = sigs.filter(function (s) {
      var assetMatch  = s.asset === asset;
      var regionMatch = region && s.region === region;
      return assetMatch || regionMatch;
    });
    if (!relevant.length) return null;  // agent abstains — no relevant view

    var biasDir = dir === 'SHORT' ? 'short' : 'long';
    // Some agents (e.g. gii-smartmoney) use `s.dir` instead of `s.bias` — normalise both.
    function _sigDir(s) { return (s.bias || s.dir || '').toLowerCase(); }
    var matching = relevant.filter(function (s) { return _sigDir(s) === biasDir; });
    var opposing = relevant.filter(function (s) { var d = _sigDir(s); return d && d !== biasDir && d !== 'neutral'; });

    return {
      agrees:   matching.length > opposing.length,
      opposes:  opposing.length > matching.length,
      /* Cap strength at 1.0 — guards against any agent that emits confidence on
         0-100 scale rather than 0-1. Without the cap, score contributions from
         technical/fundamental agents would overflow by ×100 (e.g. +160 pts instead
         of +1.6) and bypass all confluence thresholds silently.               */
      strength: matching.length ? Math.min(1.0, (matching[0].confidence || 0.5)) : 0
    };
  }

  /* ── Dynamic weight helper ───────────────────────────────────────────────
     Pulls live accuracy from consultation track records so confluence weights
     reflect actual predictive power rather than arbitrary fixed numbers.
     Falls back to the provided static weight if no track data exists.       */
  function _dynAgentWeight(agentName, staticWeight) {
    if (!window.GII_CONSULTATION || typeof GII_CONSULTATION.trackRecords !== 'function') return staticWeight;
    try {
      var tracks = GII_CONSULTATION.trackRecords();
      var t = tracks[agentName];
      if (!t || t.totalVotes < 15) return staticWeight;
      // Scale: 50% accuracy = 1.0×, 70% = 1.4×, 30% = 0.6×
      var accMult = 0.6 + (t.earlyAccuracy || 0.5) * 0.8;
      return +(staticWeight * Math.max(0.3, Math.min(1.5, accMult))).toFixed(2);
    } catch (e) { return staticWeight; }
  }

  /* ── FAST PATH (P0-B) — immediate scoring for scalper signals ─────────────
     Same veto + score + emit logic as _processQueue but runs inline in
     _submit(), skipping the queue entirely. Prevents scalper signals from
     going stale during the 15s queue cycle.                                   */
  function _scoreFastPath(item) {
    var now = Date.now();
    var sig = item.sig;
    var minScore = _getMinScore(item.source);
    var minCats  = _getMinCategories(item.source);

    /* Veto check */
    var vetoReason = _veto(item);
    if (vetoReason) {
      _stats.vetoed++; _stats.rejected++;
      _rejected.unshift({ asset: sig.asset, dir: sig.dir, reason: 'FAST-VETO: ' + vetoReason, ts: now });
      if (_rejected.length > 50) _rejected.pop();
      return;
    }

    /* Confluence score */
    var result = _scoreSignal(item);
    if (result.score < minScore || result.categories < minCats) {
      _stats.rejected++;
      _rejected.unshift({
        asset: sig.asset, dir: sig.dir, score: +result.score.toFixed(2),
        categories: result.categories, needed: minScore,
        reason: 'FAST: score ' + result.score.toFixed(2) + ' < ' + minScore +
                ' | cats ' + result.categories + '/' + minCats, ts: now
      });
      if (_rejected.length > 50) _rejected.pop();
      return;
    }

    /* Enrich and emit — same logic as _processQueue approval path */
    var volStop    = VOL_STOPS[sig.asset] || VOL_STOP_DEFAULT;
    var dynStopPct = volStop.stopPct;
    try {
      if (window.GII_AGENT_UW && typeof GII_AGENT_UW.getIVRanks === 'function') {
        var _ivMap = GII_AGENT_UW.getIVRanks(), _ivRank = _ivMap[sig.asset];
        if (typeof _ivRank === 'number') {
          if      (_ivRank > 80) dynStopPct = Math.min(volStop.stopPct * 1.5, volStop.stopPct * 2.0);
          else if (_ivRank > 60) dynStopPct = volStop.stopPct * 1.2;
          else if (_ivRank < 20) dynStopPct = volStop.stopPct * 0.85;
        }
      }
    } catch (e) {}

    var enriched = Object.assign({}, sig, {
      thesis:          _buildThesis(item, result),
      confluenceScore: result.score,
      source:          item.source,
      stopPct:         sig.stopPct  || dynStopPct,
      tpRatio:         sig.tpRatio  || volStop.tpRatio,
      srcCount:        sig.srcCount !== undefined ? sig.srcCount : result.agentsFor.length,
      timestamp:       now,           // fresh timestamp for gatekeeper
      approved_at:     now
    });
    var confBoost = Math.min(5, Math.floor(result.score * 0.4));
    enriched.conf = Math.min(88, (sig.conf || 50) + confBoost);

    _stats.approved++;
    _lastApproved[sig.asset] = now;
    _approved.unshift({ asset: sig.asset, dir: sig.dir, score: +result.score.toFixed(2),
      conf: enriched.conf, agentsFor: result.agentsFor, ts: now, fastPath: true });
    if (_approved.length > 50) _approved.pop();

    if (window.EE && typeof EE.onSignals === 'function') {
      console.log('[GII-ENTRY] FAST-PATH approved: ' + sig.asset + ' ' + sig.dir +
        ' score=' + result.score.toFixed(2) + ' conf=' + enriched.conf);
      EE.onSignals([enriched]);
    }
  }

  function _scoreSignal(item) {
    var sig    = item.sig;
    var dir    = sig.dir;   // 'LONG' or 'SHORT'
    var asset  = sig.asset;
    var region = sig.region || 'GLOBAL';
    var isScalper = item.source === 'scalper' || item.source === 'scalper-session';

    /* ── Economic calendar gate ───────────────────────────────────────────
       Block all new entries when a high-impact macro event is imminent.
       Returns early so the signal is re-queued and processed after the event. */
    if (window.ECON_CALENDAR) {
      try {
        if (ECON_CALENDAR.shouldBlock()) {
          var _imm = ECON_CALENDAR.imminent();
          console.log('[GII-ENTRY] Blocked — high-impact event imminent: ' +
                      (_imm ? _imm.country + ' ' + _imm.title : '?'));
          return null;   // null = discard/re-queue
        }
      } catch (e) {}
    }

    var score      = 0;
    var categories = {};   // track distinct categories for min-category check
    var agentsFor  = [];
    var agentsAgainst = [];

    /* ── CATEGORY: Technical ─────────────────────────────────── */
    // Scalper agents — strongest technical signal
    ['GII_AGENT_SCALPER', 'GII_AGENT_SCALPER_SESSION'].forEach(function (name) {
      var b = _agentBias(name, asset, dir, region);
      if (!b) return;
      var w = _dynAgentWeight(name, 2.5);
      if (b.agrees) {
        score += w * b.strength;
        categories.technical = true;
        agentsFor.push(name.replace('GII_AGENT_', '').toLowerCase());
      } else if (b.opposes) {
        score -= w * 1.0;  // P2-C: equal-weight opposition (was 0.8×)
        agentsAgainst.push(name.replace('GII_AGENT_', '').toLowerCase());
      }
    });

    // Market structure / optimizer
    ['GII_AGENT_MARKETSTRUCTURE', 'GII_AGENT_OPTIMIZER', 'GII_AGENT_SMARTMONEY'].forEach(function (name) {
      var b = _agentBias(name, asset, dir, region);
      if (!b) return;
      var w = _dynAgentWeight(name, 1.5);
      if (b.agrees) {
        score += w * b.strength;
        categories.technical = true;
        agentsFor.push(name.replace('GII_AGENT_', '').toLowerCase());
      } else if (b.opposes) {
        score -= w * 1.0;  // P2-C: equal-weight opposition
        agentsAgainst.push(name.replace('GII_AGENT_', '').toLowerCase());
      }
    });

    /* ── CATEGORY: Fundamental / Geopolitical ────────────────── */
    var fundamentalAgents = {
      GII_AGENT_ENERGY:   2.0,
      GII_AGENT_CONFLICT: 1.5,
      GII_AGENT_SANCTIONS:1.0,
      GII_AGENT_MARITIME: 1.0,
      GII_AGENT_SOCIAL:   0.5
    };
    Object.keys(fundamentalAgents).forEach(function (name) {
      var b = _agentBias(name, asset, dir, region);
      if (!b) return;
      var w = _dynAgentWeight(name, fundamentalAgents[name]);
      if (b.agrees) {
        score += w * Math.max(0.5, b.strength);
        categories.fundamental = true;
        agentsFor.push(name.replace('GII_AGENT_', '').toLowerCase());
      } else if (b.opposes) {
        score -= w * 1.0;  // P2-C: equal-weight opposition
        agentsAgainst.push(name.replace('GII_AGENT_', '').toLowerCase());
      }
    });

    /* ── CATEGORY: COT Positioning ──────────────────────────── */
    if (window.COT_SIGNALS) {
      try {
        var cotSigs = COT_SIGNALS.signals();
        var cotMatch = cotSigs.filter(function (s) { return s.asset === asset; })[0];
        if (cotMatch) {
          /* COT is contrarian: if COT says 'long' (shorts overcrowded) and trade is LONG → agree */
          var cotBias = cotMatch.bias;
          var tradeIsLong = dir === 'LONG';
          if ((cotBias === 'long' && tradeIsLong) || (cotBias === 'short' && !tradeIsLong)) {
            var cotW = cotMatch.confidence * 2.0;
            score += cotW;
            categories.positioning = true;
            agentsFor.push('cot(' + cotMatch.cotData.positioning + ')');
          } else if ((cotBias === 'short' && tradeIsLong) || (cotBias === 'long' && !tradeIsLong)) {
            score -= cotMatch.confidence * 1.5;
            agentsAgainst.push('cot(' + cotMatch.cotData.positioning + ')');
          }
        }
      } catch (e) {}
    }

    /* ── CATEGORY: Funding Rate (crypto perp crowding) ──────── */
    if (window.FUNDING_RATES) {
      try {
        var frSigs   = FUNDING_RATES.signals();
        var frMatch  = frSigs.filter(function (s) { return s.asset === asset; })[0];
        if (frMatch) {
          var frBias = frMatch.bias;
          var tradeDir = dir === 'LONG';
          if ((frBias === 'long' && tradeDir) || (frBias === 'short' && !tradeDir)) {
            /* Funding agrees with our direction — crowding supports the move */
            var frW = frMatch.confidence * 1.5;
            score += frW;
            categories.funding = true;
            agentsFor.push('funding(' + (frMatch.fundingRate > 0 ? '+' : '') +
                           (frMatch.fundingRate * 100).toFixed(3) + '%/8h)');
          } else if ((frBias === 'short' && tradeDir) || (frBias === 'long' && !tradeDir)) {
            /* Funding opposes direction — headwind */
            score -= frMatch.confidence * 1.0;
            agentsAgainst.push('funding-headwind');
          }
        }
      } catch (e) {}
    }

    /* ── CATEGORY: Economic Event surprise ──────────────────── */
    if (window.ECON_CALENDAR && typeof ECON_CALENDAR.signals === 'function') {
      try {
        var econSigs  = ECON_CALENDAR.signals();
        var econMatch = econSigs.filter(function (s) { return s.asset === asset; })[0];
        if (econMatch) {
          var econBias = econMatch.bias;
          var econDir  = dir === 'LONG';
          /* Normalize to 0-1 for scoring weights — econ-calendar emits on 0-100 scale
             (fixed in audit) but scoring weights were calibrated for 0-1 range.
             Without this, a confidence of 80 would add 160 score points instead of 1.6,
             completely overriding all other confluence inputs.                         */
          var econConf = Math.min(1.0, (econMatch.confidence || 0) / 100);
          if ((econBias === 'long' && econDir) || (econBias === 'short' && !econDir)) {
            /* Event surprise confirms our direction — high-conviction catalyst */
            var econW = econConf * 2.0;
            score += econW;
            categories.econ_event = true;
            agentsFor.push('econ(' + econMatch.eventTitle.split(' ').slice(0, 3).join(' ') + ')');
          } else if ((econBias === 'short' && econDir) || (econBias === 'long' && !econDir)) {
            /* Event surprise opposes direction — meaningful headwind */
            score -= econConf * 1.5;
            agentsAgainst.push('econ-headwind(' + econMatch.eventTitle.split(' ').slice(0, 2).join(' ') + ')');
          }
        }
      } catch (e) {}
    }

    /* ── CATEGORY: Macro / Regime ────────────────────────────── */
    if (window.GII_AGENT_MACRO) {
      try {
        var macroSt = GII_AGENT_MACRO.status();
        var riskMode = macroSt.riskMode;
        var isLong   = dir === 'LONG';
        var isDef    = DEFENSIVE.indexOf(asset) !== -1;

        if (riskMode === 'RISK_ON'  && isLong && !isDef) { score += 2.0; categories.macro = true; agentsFor.push('macro'); }
        if (riskMode === 'RISK_OFF' && !isLong)          { score += 1.5; categories.macro = true; agentsFor.push('macro'); }
        if (riskMode === 'RISK_OFF' && isLong && isDef)  { score += 1.5; categories.macro = true; agentsFor.push('macro-defensive'); }
        if (riskMode === 'RISK_OFF' && isLong && !isDef) { score -= 1.5; agentsAgainst.push('macro'); }
      } catch (e) {}
    }

    if (window.GII_AGENT_REGIME) {
      try {
        var regSt = GII_AGENT_REGIME.status();
        if (regSt.regimeShiftActive) {
          /* Active regime shift vetoes non-defensive entries for 1h */
          score -= 3.0;
          agentsAgainst.push('regime-shift');
        }
      } catch (e) {}
    }

    /* ── CATEGORY: Bayesian Probability ─────────────────────── */
    if (window.GII) {
      try {
        var post = GII.posterior(region);
        if (post && post.posterior) {
          var p = post.posterior;
          if (p > 0.65) {
            score += 2.0 * p;
            categories.probabilistic = true;
            agentsFor.push('bayesian(' + Math.round(p * 100) + '%)');
          } else if (p < 0.30 && dir === 'LONG') {
            score -= 1.5;
            agentsAgainst.push('bayesian-low');
          }
        }
        /* IC region state */
        var IC = window.__IC;
        if (IC && IC.regionStates && IC.regionStates[region]) {
          var regionProb = IC.regionStates[region].prob || 0;
          if (regionProb > 60) {
            score += 1.5 * (regionProb / 100);
            categories.probabilistic = true;
            agentsFor.push('ic-region(' + regionProb + '%)');
          }
        }
      } catch (e) {}
    }

    /* ── CATEGORY: Polymarket edge ───────────────────────────── */
    /* Audit fix: use per-asset/region signals from Polymarket rather than
       the global avgEdge. avgEdge is an average across ALL markets — a large
       edge on a US election market was falsely boosting oil and crypto entries.
       Now we look for a Polymarket signal that matches this specific asset or region. */
    if (window.GII_AGENT_POLYMARKET) {
      try {
        var pmSigs = GII_AGENT_POLYMARKET.signals ? GII_AGENT_POLYMARKET.signals() : [];
        var pmRelevant = pmSigs.filter(function (s) {
          return s.asset === asset || (region && s.region === region);
        });
        if (pmRelevant.length) {
          var pmBest = pmRelevant.reduce(function (best, s) {
            return (s.confidence || 0) > (best.confidence || 0) ? s : best;
          }, pmRelevant[0]);
          var pmEdge = pmBest.confidence || 0;
          if (pmEdge > 0.10) {
            score += 2.0 * Math.min(1, pmEdge);
            categories.probabilistic = true;
            agentsFor.push('polymarket(' + Math.round(pmEdge * 100) + '% edge)');
          }
        } else {
          /* No asset/region match — fall back to global avgEdge but at reduced weight */
          var pmSt = GII_AGENT_POLYMARKET.status();
          if (pmSt.avgEdge > 0.15) {  // raised threshold since it's a weak signal
            score += 0.8 * Math.min(1, pmSt.avgEdge);  // 0.8× instead of 2.0× weight
            categories.probabilistic = true;
            agentsFor.push('polymarket-global(' + Math.round(pmSt.avgEdge * 100) + '%)');
          }
        }
      } catch (e) {}
    }

    /* ── GTI context bonus/penalty ───────────────────────────── */
    if (window.GII) {
      try {
        var gtiData = GII.gti();
        var gtiVal  = (gtiData && typeof gtiData.value === 'number' && isFinite(gtiData.value)) ? gtiData.value : 0;
        /* High tension (40-75): good for oil, gold, defence longs */
        var oilGoldDef = ['WTI','BRENT','GLD','XAU','LMT','RTX','XAR','NOC'].indexOf(asset) !== -1;
        if (gtiVal >= 40 && gtiVal <= 75 && oilGoldDef && dir === 'LONG') { score += 1.0; }
        /* Extreme tension (>80): only defensive assets */
        if (gtiVal > 80 && dir === 'LONG' && RISK_ASSETS.indexOf(asset) !== -1) { score -= 2.0; }
      } catch (e) {}
    }

    /* ── CATEGORY: Technical trend alignment ─────────────────── */
    /* Geopolitical entries often trade against the established technical trend
       (a crisis shock can break a trend). Rather than a hard veto, apply a
       score penalty for clear counter-trend entries so only signals with strong
       multi-agent backing (score >6.0 net) can trade against the trend.
       Uses GII_AGENT_TECHNICALS signals with confidence threshold 0.50.          */
    if (window.GII_AGENT_TECHNICALS) {
      try {
        var _techSigs = GII_AGENT_TECHNICALS.signals();
        for (var _ti = 0; _ti < _techSigs.length; _ti++) {
          if (_techSigs[_ti].asset === asset && (_techSigs[_ti].confidence || 0) >= 0.50) {
            var _techDir = _techSigs[_ti].bias === 'long' ? 'LONG' : 'SHORT';
            if (_techDir === dir) {
              score += 1.0;
              categories.technical = true;
              agentsFor.push('technicals-aligned');
            } else {
              score -= 1.5;
              agentsAgainst.push('technicals-counter');
            }
            break;
          }
        }
      } catch (e) {}
    }

    // ── TA Scanner (technicals-agent.js) — broad HL asset TA confirmation ─────
    // This agent scans all HL assets for RSI/MACD/BB signals but does NOT
    // generate standalone trades. It only adds/subtracts confluence weight here.
    if (window.GII_AGENT_TA_SCANNER && typeof GII_AGENT_TA_SCANNER.signals === 'function') {
      try {
        var _taSigs = GII_AGENT_TA_SCANNER.signals();
        for (var _tai = 0; _tai < _taSigs.length; _tai++) {
          var _taS = _taSigs[_tai];
          if (String(_taS.asset).toUpperCase() === asset && (_taS.confidence || 0) >= 55) {
            var _taDir = String(_taS.bias || _taS.dir || '').toUpperCase();
            if (_taDir === dir) {
              score += _dynAgentWeight('GII_AGENT_TA_SCANNER', 0.8);
              categories.ta_scanner = true;
              agentsFor.push('ta-scanner');
            } else if (_taDir && _taDir !== dir) {
              score -= _dynAgentWeight('GII_AGENT_TA_SCANNER', 0.8) * 1.0;  // P2-C equal-weight
              agentsAgainst.push('ta-scanner');
            }
            break;
          }
        }
      } catch (e) {}
    }

    // ── Market Observer — anomaly/structure confirmation ───────────────────────
    // Detects volume spikes, unusual moves, momentum shifts. Adds confirmation
    // weight when market structure aligns with the geo thesis.
    if (window.GII_AGENT_MARKET_OBSERVER && typeof GII_AGENT_MARKET_OBSERVER.observations === 'function') {
      try {
        var _moObs = GII_AGENT_MARKET_OBSERVER.observations();
        for (var _moi = 0; _moi < _moObs.length; _moi++) {
          var _mo = _moObs[_moi];
          if (String(_mo.asset).toUpperCase() === asset && (_mo.score || 0) >= 50) {
            var _moDir = String(_mo.direction || '').toUpperCase();
            if (_moDir === dir) {
              score += _dynAgentWeight('GII_AGENT_MARKET_OBSERVER', 0.6);
              categories.market_structure = true;
              agentsFor.push('market-observer');
            } else if (_moDir && _moDir !== dir) {
              score -= _dynAgentWeight('GII_AGENT_MARKET_OBSERVER', 0.6) * 1.0;  // P2-C equal-weight
              agentsAgainst.push('market-observer');
            }
            break;
          }
        }
      } catch (e) {}
    }

    var categoryCount = Object.keys(categories).length;

    /* ── P1-A: Agent correlation group dedup ─────────────────────────────────
       Within a correlated group, only the strongest vote counts. This prevents
       e.g. SCALPER + SCALPER_SESSION (same data) from double-counting.
       We track each agent's weighted contribution so we can subtract the excess. */
    var _agentWeights = {};  // agentName → weighted contribution to score
    agentsFor.forEach(function (a) { _agentWeights[a] = _agentWeights[a] || 0; _agentWeights[a] += 1; });

    AGENT_CORR_GROUPS.forEach(function (group) {
      var groupMembers = [];
      // Find agents in this group that voted (for or against)
      group.forEach(function (fullName) {
        var shortName = fullName.replace('GII_AGENT_', '').toLowerCase();
        if (agentsFor.indexOf(shortName) !== -1 || agentsAgainst.indexOf(shortName) !== -1) {
          groupMembers.push(shortName);
        }
      });
      if (groupMembers.length <= 1) return; // no dedup needed

      // Among agreeing members, keep strongest (first found — they're added in weight order)
      var agreeingMembers = groupMembers.filter(function (m) { return agentsFor.indexOf(m) !== -1; });
      if (agreeingMembers.length > 1) {
        // Penalise score for each extra correlated agent beyond the first
        for (var _di = 1; _di < agreeingMembers.length; _di++) {
          score -= 0.8;  // subtract approximate extra weight per correlated duplicate
        }
      }
    });

    /* ── P1-A: Source diversity multiplier ────────────────────────────────────
       If all agreeing agents use the same data source (e.g. all from HLFeed),
       that's thin consensus. Scale score by source diversity factor.
       1 source = 0.5×, 2 sources = 0.8×, 3+ sources = 1.0×                  */
    var _uniqueSources = {};
    agentsFor.forEach(function (shortName) {
      var fullName = 'GII_AGENT_' + shortName.toUpperCase();
      var src = AGENT_DATA_SOURCES[fullName] || 'unknown';
      _uniqueSources[src] = true;
    });
    var _srcCount = Object.keys(_uniqueSources).length;
    var _srcDiversityMult = _srcCount >= 3 ? 1.0 : _srcCount === 2 ? 0.8 : (_srcCount === 1 && agentsFor.length > 0) ? 0.5 : 1.0;
    if (_srcDiversityMult < 1.0 && score > 0) {
      score = +(score * _srcDiversityMult).toFixed(2);
    }

    /* ── P2-C: Coverage penalty — penalise thin agent coverage ───────────────
       If only a small fraction of consulted agents had an opinion, the consensus
       is weak regardless of whether those few agreed.                          */
    var _consultedCount = 15;  // approximate total agent slots queried above
    var _respondedCount = agentsFor.length + agentsAgainst.length;
    var _coverageRatio  = _respondedCount / _consultedCount;
    if (_coverageRatio < 0.3 && score > 0) {
      score = +(score * 0.7).toFixed(2);  // 30% penalty for thin coverage
    }

    // Net agent ratio gate: if more agents oppose than support, cap the score.
    if (agentsAgainst.length > agentsFor.length && score > 0) {
      var ratio = agentsFor.length / Math.max(1, agentsAgainst.length);
      score = +(score * ratio).toFixed(2);
    }

    return { score: score, categories: categoryCount, agentsFor: agentsFor, agentsAgainst: agentsAgainst };
  }

  /* ── VETO CHECKS ────────────────────────────────────────────────────────── */
  function _veto(item) {
    var sig   = item.sig;
    var asset = sig.asset;
    var dir   = sig.dir;
    var isDef = DEFENSIVE.indexOf(asset) !== -1;

    /* Veto 1: active regime shift — nothing enters for 60 min */
    if (window.GII_AGENT_REGIME) {
      try {
        var regSt = GII_AGENT_REGIME.status();
        if (regSt.regimeShiftActive && !isDef) return 'active-regime-shift';
      } catch (e) {}
    }

    /* Veto 2: extreme VIX + RISK_OFF → no risk-asset longs */
    if (window.GII_AGENT_MACRO) {
      try {
        var macroSt = GII_AGENT_MACRO.status();
        var vix = macroSt.vix || 0;
        if (vix > 45 && macroSt.riskMode === 'RISK_OFF' &&
            dir === 'LONG' && RISK_ASSETS.indexOf(asset) !== -1) {
          return 'vix-spike-' + vix;
        }
      } catch (e) {}
    }

    /* Veto 3: manager has multiple active errors (not just one agent loading slowly).
       Changed from errors > 0 to errors > 2: a single load-timing error (e.g. one
       agent not yet registered at startup) was blocking ALL signals permanently until
       the next 5-min manager poll cycle — far too aggressive.                       */
    if (window.GII_AGENT_MANAGER) {
      try {
        var mgr = GII_AGENT_MANAGER.status();
        if (mgr.errors > 2) return 'system-health-error';
      } catch (e) {}
    }

    /* Veto 4: asset already has open position.
       Use EE.getOpenTrades() — authoritative in-memory source.
       Previous impl read localStorage directly which can diverge from in-memory
       state after the SQLite backend loads and merges trades. */
    if (window.EE && typeof EE.getOpenTrades === 'function') {
      try {
        var hasOpen = EE.getOpenTrades().some(function (t) { return t.asset === asset; });
        if (hasOpen) return 'position-already-open';
      } catch (e) {}
    }

    /* Veto 4b: recently closed trade on this asset within last 30 min.
       Dedup guard against direct EE.onSignals() emitters (forex-fundamentals,
       crypto-signals, correlation-agent etc.) that bypass this confluence
       pipeline — prevents GII from re-entering an asset that was just worked
       by another agent. Reads the same localStorage store used by gii-manager. */
    try {
      var _allTrades  = JSON.parse(localStorage.getItem('geodash_ee_trades_v1') || '[]');
      var _thirtyAgo  = Date.now() - 30 * 60 * 1000;
      var _justClosed = _allTrades.some(function (t) {
        return t.asset === asset &&
               t.status === 'CLOSED' &&
               t.timestamp_close &&
               new Date(t.timestamp_close).getTime() > _thirtyAgo;
      });
      if (_justClosed) return 'dedup-recently-closed-30min';
    } catch (e) {
      console.warn('[GII-ENTRY] Veto 4b check failed — localStorage parse error, dedup skipped:', e.message || e);
    }

    /* Veto 5: GTI extreme (>85) blocks new risk-asset longs */
    if (window.GII) {
      try {
        var gtiData = GII.gti();
        if (gtiData && gtiData.value > 85 &&
            dir === 'LONG' && RISK_ASSETS.indexOf(asset) !== -1) {
          return 'gti-extreme-' + Math.round(gtiData.value);
        }
      } catch (e) {}
    }

    return null;
  }

  /* ── THESIS FINGERPRINT ─────────────────────────────────────────────────── */
  function _buildThesis(item, scoreResult) {
    var region = item.sig.region || 'GLOBAL';
    var thesis = {
      confluenceScore:   +scoreResult.score.toFixed(2),
      categoryCount:     scoreResult.categoryCount,
      agentsFor:         scoreResult.agentsFor,
      agentsAgainst:     scoreResult.agentsAgainst,
      source:            item.source,
      timestamp:         Date.now()
    };
    try {
      if (window.GII) {
        var post = GII.posterior(region);
        if (post) { thesis.posteriorAtEntry = +post.posterior.toFixed(3); }
        var gtiData = GII.gti();
        if (gtiData) { thesis.gtiAtEntry = +gtiData.value.toFixed(1); }
        var giiSt = GII.status();
        if (giiSt) { thesis.regimeAtEntry = giiSt.gtiLevel; }
      }
      if (window.GII_AGENT_MACRO) {
        var mSt = GII_AGENT_MACRO.status();
        thesis.riskModeAtEntry = mSt.riskMode;
        thesis.vixAtEntry      = mSt.vix;
      }
      if (window.__IC && __IC.regionStates && __IC.regionStates[region]) {
        thesis.regionProbAtEntry = __IC.regionStates[region].prob;
      }
    } catch (e) {}
    return thesis;
  }

  /* ── PROCESS QUEUE ──────────────────────────────────────────────────────── */
  function _processQueue() {
    /* P2-A: Mutex guard — prevent overlapping runs from setInterval */
    if (_processing) return;
    _processing = true;

    var now = Date.now();
    _lastProcessedAt = now;  // P2-D: health heartbeat

    try { _processQueueInner(now); }
    finally { _processing = false; }
  }

  function _processQueueInner(now) {
    /* Expire stale items — log each one so queue drops are visible in audit log */
    var _expiredItems = _queue.filter(function (item) { return (now - item.queuedAt) >= QUEUE_TTL_MS; });
    _expiredItems.forEach(function (item) {
      _stats.rejected++;
      _rejected.unshift({ asset: item.sig.asset, dir: item.sig.dir, reason: 'queue-ttl-expired', ts: now });
      if (_rejected.length > 50) _rejected.pop();
    });
    _queue = _queue.filter(function (item) { return (now - item.queuedAt) < QUEUE_TTL_MS; });

    if (!_queue.length) return;

    /* Deduplicate queue by asset: if both LONG and SHORT arrive for the same
       asset, score both and keep the one with higher confluence.
       Previous impl kept highest raw confidence regardless of direction —
       a LONG with conf=72 would beat a SHORT with conf=70 and better agent backing.
       Now we pre-score both and let the signals compete on confluence quality. */
    var byAsset = {};
    _queue.forEach(function (item) {
      var key = item.sig.asset;
      if (!byAsset[key]) {
        byAsset[key] = item;
      } else {
        /* Both directions queued — score both, keep better confluence */
        var existingScore = _scoreSignal(byAsset[key]).score;
        var newScore      = _scoreSignal(item).score;
        if (newScore > existingScore) byAsset[key] = item;
      }
    });
    _queue = [];   // consumed

    var toEmit = [];

    Object.keys(byAsset).forEach(function (key) {
      var item      = byAsset[key];
      var sig       = item.sig;
      var isScalper = item.source === 'scalper' || item.source === 'scalper-session';
      var isIC      = item.source === 'ic';
      var isGII     = !isScalper && !isIC;   // gii, gii-core, or untagged geo signals

      /* Per-asset approved cooldown — GII only. Blocks re-approval of same asset
         within 30 minutes of last GII approval. Prevents runaway escalation chains
         from re-firing immediately after a trade closes.
         IC and scalper signals are exempt — they have their own edge tracking and
         should not be throttled by a rule designed for GII loop prevention. */
      if (isGII && (now - (_lastApproved[sig.asset] || 0)) < APPROVED_COOLDOWN_MS) {
        var _coolMinsLeft = Math.ceil((APPROVED_COOLDOWN_MS - (now - (_lastApproved[sig.asset] || 0))) / 60000);
        _stats.rejected++;
        _rejected.unshift({ asset: sig.asset, dir: sig.dir,
          reason: 'gii-approved-cooldown: ' + _coolMinsLeft + 'min remaining', ts: now });
        if (_rejected.length > 50) _rejected.pop();
        return;
      }

      /* Capital allocation gate: GII signals are restricted to IC-adjacent
         high-beta assets and require a much higher confluence score.
         Audit (315 trades): GII has -$2.31 expectancy, score has no predictive value.
         IC has +$2.63 expectancy, concentrated in TSLA/VXX.
         GII signals on XLE/BRENT/TSM/QQQ etc. have produced no demonstrated edge. */
      if (isGII) {
        if (!GII_ALLOWED_ASSETS[sig.asset]) {
          _stats.rejected++;
          _rejected.unshift({ asset: sig.asset, dir: sig.dir,
            reason: 'GII asset gate: ' + sig.asset + ' not in IC-adjacent list (no demonstrated edge)', ts: now });
          if (_rejected.length > 50) _rejected.pop();
          return;
        }
      }

      var minScore = _getMinScore(item.source);
      var minCats  = _getMinCategories(item.source);

      /* Veto check first (fast) */
      var vetoReason = _veto(item);
      if (vetoReason) {
        _stats.vetoed++;
        _stats.rejected++;
        _rejected.unshift({ asset: sig.asset, dir: sig.dir, reason: 'VETO: ' + vetoReason, ts: now });
        if (_rejected.length > 50) _rejected.pop();
        return;
      }

      /* Confluence score */
      var result = _scoreSignal(item);

      if (result.score < minScore || result.categories < minCats) {
        _stats.rejected++;
        _rejected.unshift({
          asset:      sig.asset,
          dir:        sig.dir,
          score:      +result.score.toFixed(2),
          categories: result.categories,
          needed:     minScore,
          reason:     'score ' + result.score.toFixed(2) + ' < ' + minScore +
                      ' | categories ' + result.categories + '/' + minCats,
          ts:         now
        });
        if (_rejected.length > 50) _rejected.pop();
        return;
      }

      /* Per-event trade cap: no more than MAX_TRADES_PER_EVENT open trades from the
         same news event. Uses first 40 chars of sig.reason as the event key.
         Scalper signals are exempt — they use technical setups, not news events. */
      if (!isScalper && sig.reason && window.EE && typeof EE.getOpenTrades === 'function') {
        try {
          var _eventKey = (sig.reason || '').substring(0, 40).toLowerCase();
          var _openFromEvent = EE.getOpenTrades().filter(function (t) {
            return (t.reason || '').substring(0, 40).toLowerCase() === _eventKey;
          }).length;
          if (_openFromEvent >= MAX_TRADES_PER_EVENT) {
            _stats.rejected++;
            _rejected.unshift({ asset: sig.asset, dir: sig.dir,
              reason: 'event cap: ' + _openFromEvent + '/' + MAX_TRADES_PER_EVENT +
                ' trades already open for "' + sig.reason.substring(0, 35) + '"', ts: now });
            if (_rejected.length > 50) _rejected.pop();
            return;
          }
        } catch (e) {}
      }

      /* Smart region/sector rotation — if cap is full, replace weakest trade when new signal scores higher.
         Always keep the highest-conviction opportunities open rather than blocking good signals. */
      var ENTRY_SECTOR_MAP = {
        'WTI':'energy','BRENT':'energy','XLE':'energy','GAS':'energy',
        'XAU':'precious','GLD':'precious','SLV':'precious',
        'BTC':'crypto','ETH':'crypto',
        'SPY':'equity','QQQ':'equity','NVDA':'equity',
        'TSLA':'equity','SMH':'equity','TSM':'equity','FXI':'equity'
      };
      if (window.EE && typeof EE.getOpenTrades === 'function' && typeof EE.getConfig === 'function') {
        try {
          var eeOpen  = EE.getOpenTrades();
          var eeCfg   = EE.getConfig();
          var newScore = result.score;

          /* Score proxy for comparing open trades:
             uses stored confluenceScore from thesis, falls back to conf/15
             (conf=65 → 4.3, conf=95 → 6.3 — comparable to confluence range 4.5–7) */
          function _tradeScore(t) {
            return (t.thesis && t.thesis.confluenceScore) ? t.thesis.confluenceScore : (t.conf || 50) / 15;
          }

          /* Minimum score advantage required to justify rotation.
             Raised 25%→60%: rotation is a high-cost action (closes a live trade).
             The bar must be high. A new signal scoring 6.0 vs incumbent 5.0 = 20% — block.
             A new signal scoring 8.0 vs incumbent 5.0 = 60% — rotate.
             Audit data showed ROTATION_MIN_DELTA=0.25 triggered ~50 XLE rotations alone,
             destroying $150+ in incumbents before they could reach their targets. */
          var ROTATION_MIN_DELTA = 0.60;

          /* P&L protection: check if an incumbent trade is currently profitable.
             A trade that is in profit must NEVER be force-closed by rotation — it is
             actively realizing edge. Block the new signal instead.
             Uses EE price cache which is the same source as trade monitoring. */
          function _incumbentInProfit(t) {
            try {
              if (window.EE && typeof EE.getLastPrice === 'function') {
                var _lp = EE.getLastPrice(t.asset);
                if (!_lp || !t.entry_price) return false;
                return t.direction === 'LONG' ? _lp > t.entry_price : _lp < t.entry_price;
              }
            } catch (e) {}
            return false;  // can't determine — treat as not in profit (safe default)
          }

          /* Minimum trade age before it can be rotated out.
             A trade opened 20 minutes ago has not yet had time to develop.
             Geopolitical trades typically need hours to manifest — 4h minimum
             ensures the incumbent gets a genuine opportunity before eviction. */
          var ROTATION_MIN_AGE_MS = 4 * 60 * 60 * 1000;

          /* Region rotation */
          var regionTrades = eeOpen.filter(function (t) { return t.region === sig.region; });
          if (eeCfg.max_per_region && regionTrades.length >= eeCfg.max_per_region) {
            var weakestRegion = regionTrades.slice().sort(function (a, b) {
              return _tradeScore(a) - _tradeScore(b);
            })[0];
            var weakestRegionScore = weakestRegion ? _tradeScore(weakestRegion) : 0;
            if (weakestRegion && newScore > weakestRegionScore * (1 + ROTATION_MIN_DELTA)) {
              /* Score clears the bar — but only rotate if incumbent is NOT in profit AND old enough */
              var _regionAge = Date.now() - new Date(weakestRegion.timestamp_open || 0).getTime();
              if (_incumbentInProfit(weakestRegion)) {
                /* Incumbent is in profit — protect it, block incoming signal instead */
                _stats.rejected++;
                _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                  reason: 'rotation blocked: ' + weakestRegion.asset + ' incumbent in profit (score ' +
                    newScore.toFixed(2) + ' vs ' + weakestRegionScore.toFixed(2) + ')', ts: now });
                if (_rejected.length > 50) _rejected.pop();
                return;
              }
              if (_regionAge < ROTATION_MIN_AGE_MS) {
                /* Incumbent too young — protect it, block incoming signal */
                _stats.rejected++;
                _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                  reason: 'rotation blocked: ' + weakestRegion.asset + ' too young (' +
                    Math.round(_regionAge / 60000) + 'min < ' + (ROTATION_MIN_AGE_MS / 60000) + 'min min)', ts: now });
                if (_rejected.length > 50) _rejected.pop();
                return;
              }
              /* Safe to rotate — losing trade, old enough, clearly outscored */
              try { EE.forceCloseTrade(weakestRegion.trade_id,
                'GII-ENTRY:rotated-by-' + sig.asset + '(score ' + newScore.toFixed(2) + '>' + weakestRegionScore.toFixed(2) + ')'); } catch (e) {}
              _stats.rotated++;
            } else {
              /* Score difference not significant enough — keep incumbents */
              _stats.rejected++;
              _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                reason: 'region cap: ' + sig.region + ' score delta insufficient (' +
                  (weakestRegion ? weakestRegionScore.toFixed(2) : '?') + ' vs ' + newScore.toFixed(2) + ', need +60%)', ts: now });
              if (_rejected.length > 50) _rejected.pop();
              return;
            }
          }

          /* Sector rotation */
          var assetSector = ENTRY_SECTOR_MAP[sig.asset];
          if (assetSector && eeCfg.max_per_sector) {
            var sectorTrades = eeOpen.filter(function (t) {
              return ENTRY_SECTOR_MAP[t.asset] === assetSector;
            });
            if (sectorTrades.length >= eeCfg.max_per_sector) {
              var weakestSector = sectorTrades.slice().sort(function (a, b) {
                return _tradeScore(a) - _tradeScore(b);
              })[0];
              var weakestSectorScore = weakestSector ? _tradeScore(weakestSector) : 0;
              if (weakestSector && newScore > weakestSectorScore * (1 + ROTATION_MIN_DELTA)) {
                /* Score clears bar — apply same P&L + age protection as region rotation */
                var _sectorAge = Date.now() - new Date(weakestSector.timestamp_open || 0).getTime();
                if (_incumbentInProfit(weakestSector)) {
                  _stats.rejected++;
                  _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                    reason: 'sector rotation blocked: ' + weakestSector.asset + ' incumbent in profit', ts: now });
                  if (_rejected.length > 50) _rejected.pop();
                  return;
                }
                if (_sectorAge < ROTATION_MIN_AGE_MS) {
                  _stats.rejected++;
                  _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                    reason: 'sector rotation blocked: ' + weakestSector.asset + ' too young (' +
                      Math.round(_sectorAge / 60000) + 'min)', ts: now });
                  if (_rejected.length > 50) _rejected.pop();
                  return;
                }
                try { EE.forceCloseTrade(weakestSector.trade_id,
                  'GII-ENTRY:rotated-by-' + sig.asset + '(score ' + newScore.toFixed(2) + '>' + weakestSectorScore.toFixed(2) + ')'); } catch (e) {}
                _stats.rotated++;
              } else {
                _stats.rejected++;
                _rejected.unshift({ asset: sig.asset, dir: sig.dir,
                  reason: 'sector cap: ' + assetSector + ' score delta insufficient (' +
                    (weakestSector ? weakestSectorScore.toFixed(2) : '?') + ' vs ' + newScore.toFixed(2) + ', need +60%)', ts: now });
                if (_rejected.length > 50) _rejected.pop();
                return;
              }
            }
          }
        } catch (e) {}
      }

      /* Signal age decay: confidence decays within the 8-min TTL window.
         A signal queued 7 min ago has stale context vs. one queued 10 sec ago.
         Graduated decay preserves speed-of-signal advantage without hard TTL cliff.
         < 1 min: 100%, 1–2 min: 95%, 2–4 min: 85%, 4–8 min: 70% */
      var _sigAgeMin = (now - item.queuedAt) / 60000;
      var _ageMult   = _sigAgeMin < 1 ? 1.00
                     : _sigAgeMin < 2 ? 0.95
                     : _sigAgeMin < 4 ? 0.85
                     : 0.70;

      /* Approved — enrich signal with thesis fingerprint + volatility stops */
      var volStop  = VOL_STOPS[sig.asset] || VOL_STOP_DEFAULT;
      /* IV-adjusted stop: use UW IV rank as ATR proxy — high IV means wider daily
         ranges, so we need a wider stop to avoid noise-stop-outs.
         Adjustments: IV>80 → +50%, IV>60 → +20%, IV<20 → -15% (quiet market).
         Falls back to VOL_STOPS table value when UW data not available.           */
      var dynStopPct = volStop.stopPct;
      try {
        if (window.GII_AGENT_UW && typeof GII_AGENT_UW.getIVRanks === 'function') {
          var _ivMap  = GII_AGENT_UW.getIVRanks();
          var _ivRank = _ivMap[sig.asset];
          if (typeof _ivRank === 'number') {
            if      (_ivRank > 80) dynStopPct = Math.min(volStop.stopPct * 1.5, volStop.stopPct * 2.0);
            else if (_ivRank > 60) dynStopPct = volStop.stopPct * 1.2;
            else if (_ivRank < 20) dynStopPct = volStop.stopPct * 0.85;
          }
        }
      } catch (e) {}
      var enriched = Object.assign({}, sig, {
        thesis:          _buildThesis(item, result),
        confluenceScore: result.score,
        source:          item.source,
        stopPct:         sig.stopPct  || dynStopPct,
        tpRatio:         sig.tpRatio  || volStop.tpRatio,
        srcCount:        sig.srcCount !== undefined ? sig.srcCount : result.agentsFor.length,
        /* P1-C: Dual timestamps — fresh timestamp for gatekeeper staleness check,
           generated_at preserved for analytical staleness validation */
        timestamp:       now,
        approved_at:     now
      });

      /* Boost confidence by confluence (up to +5 points), capped at 88.
         Multiplier reduced 0.6→0.4 so high-scoring signals receive proportionally
         more lift than borderline passes — preserves quality differentiation.
         Audit finding: with +8 boost and 95 cap, nearly all approved trades hit 95%
         making confidence indistinguishable between winners and losers.
         Smaller boost + lower cap preserves meaningful differentiation. */
      var confBoost = Math.min(5, Math.floor(result.score * 0.4));
      /* sig.conf is used (not sig.confidence) because EE.onSignals() normalises
         .confidence → .conf (0-100 scale) before signals reach this pipeline.
         If a signal arrives via a path that skips EE normalisation, conf defaults
         to 50 — a conservative mid-range fallback rather than 0 or 100.       */
      enriched.conf = Math.min(88, (sig.conf || 50) + confBoost);

      /* Economic calendar confidence penalty: if a high-impact event is within
         2 hours (but not yet blocking), apply a 15% confidence haircut.
         The confMultiplier returns 0.85 in warn window, 1.0 when clear. */
      if (window.ECON_CALENDAR) {
        try {
          var _calMult = ECON_CALENDAR.confMultiplier();
          if (_calMult < 1.0 && _calMult > 0) {
            var _preCalConf = enriched.conf;
            enriched.conf = Math.max(40, Math.round(enriched.conf * _calMult));
            var _imEvt = ECON_CALENDAR.upcoming(2)[0];
            console.log('[GII-ENTRY] Calendar penalty ×' + _calMult + ' on ' + sig.asset +
              ': conf ' + _preCalConf + '→' + enriched.conf +
              (_imEvt ? ' (' + _imEvt.country + ' ' + _imEvt.title + ' upcoming)' : ''));
          }
        } catch (e) {}
      }

      /* Apply signal age decay: older queued signals get a confidence haircut.
         Floor: never reduce below 40% (preserves signal even at max age). */
      if (_ageMult < 1.0) {
        var _preDecay = enriched.conf;
        enriched.conf = Math.max(40, Math.round(enriched.conf * _ageMult));
        console.log('[GII-ENTRY] Age-decay ×' + _ageMult + ' on ' + sig.asset +
          ' (' + _sigAgeMin.toFixed(1) + 'min old): conf ' + _preDecay + '→' + enriched.conf);
      }

      toEmit.push(enriched);
      _lastApproved[sig.asset] = now;   // stamp 30-min cooldown on this asset
      _stats.approved++;
      _approved.unshift({
        asset: sig.asset, dir: sig.dir,
        score: +result.score.toFixed(2),
        conf:  enriched.conf,
        agentsFor: result.agentsFor,
        ts:    now
      });
      if (_approved.length > 50) _approved.pop();
    });

    if (toEmit.length && window.EE && typeof EE.onSignals === 'function') {

      /* ── P1-B: Portfolio pre-checks before emission ────────────────────────
         Defense-in-depth: dedup correlated assets within batch, enforce sector
         cap, and check aggregate exposure BEFORE signals reach the EE.         */
      try {
        var _openTrades = (typeof EE.getOpenTrades === 'function') ? EE.getOpenTrades() : [];
        var _eeCfg      = (typeof EE.getConfig === 'function') ? EE.getConfig() : {};

        /* 1. Correlation group dedup within batch — keep highest EV per corr group */
        var CORR_GROUPS = [
          ['WTI','BRENT','XLE','XOM'], ['GLD','XAU','PAXG','GOLD'],
          ['BTC','ETH','SOL'], ['LMT','RTX','NOC','XAR'],
          ['TSM','NVDA','SMH','ASML'], ['SPY','QQQ'], ['FXI','EEM'], ['DAL','UAL']
        ];
        function _getAssetCorrGroup(asset) {
          for (var _ci = 0; _ci < CORR_GROUPS.length; _ci++) {
            if (CORR_GROUPS[_ci].indexOf(asset) !== -1) return CORR_GROUPS[_ci];
          }
          return null;
        }
        var _seenCorrGroups = {};
        toEmit = toEmit.filter(function (s) {
          var group = _getAssetCorrGroup(s.asset);
          if (!group) return true;
          var groupKey = group.slice().sort().join('|');
          if (_seenCorrGroups[groupKey]) return false;
          _seenCorrGroups[groupKey] = true;
          return true;
        });

        /* 2. Sector cap check against open positions + batch */
        var _sectorMap = {
          WTI:'energy',BRENT:'energy',XLE:'energy',GAS:'energy',NATGAS:'energy',
          XAU:'precious',GLD:'precious',SLV:'precious',PAXG:'precious',
          BTC:'crypto',ETH:'crypto',SOL:'crypto',
          SPY:'equity',QQQ:'equity',NVDA:'equity',TSLA:'equity',SMH:'equity',TSM:'equity'
        };
        var _maxPerSector = _eeCfg.max_per_sector || 6;
        var _sectorCounts = {};
        _openTrades.forEach(function (t) {
          var sec = _sectorMap[t.asset] || 'other';
          _sectorCounts[sec] = (_sectorCounts[sec] || 0) + 1;
        });
        toEmit = toEmit.filter(function (s) {
          var sec = _sectorMap[s.asset] || 'other';
          if ((_sectorCounts[sec] || 0) >= _maxPerSector) return false;
          _sectorCounts[sec] = (_sectorCounts[sec] || 0) + 1;
          return true;
        });

        /* 3. Aggregate exposure estimate — entry caps at 30% (below EE's 45%) */
        var _totalRiskUsd = _openTrades.reduce(function (sum, t) {
          var sl = Math.abs((t.entry_price || 0) - (t.stop_loss || 0));
          return sum + (sl > 0 ? (t.units || 0) * sl : 0);
        }, 0);
        var _balance = _eeCfg.virtual_balance || 85;
        var _entryExpCap = _balance * 0.30;
        if (_totalRiskUsd >= _entryExpCap) {
          console.log('[GII-ENTRY] Portfolio exposure at ' + ((_totalRiskUsd / _balance) * 100).toFixed(1) +
            '% — above 30% entry cap, suppressing ' + toEmit.length + ' signals');
          toEmit = [];
        }
      } catch (e) {
        console.warn('[GII-ENTRY] Portfolio pre-check error (proceeding): ' + (e.message || e));
      }

      /* EV-based ranking: highest EV first so best opportunities fill trade slots */
      if (toEmit.length > 1) {
        toEmit.sort(function (a, b) {
          var evA = (a.conf / 100) * (a.tpRatio || 2.5);
          var evB = (b.conf / 100) * (b.tpRatio || 2.5);
          return evB - evA;
        });
        console.log('[GII-ENTRY] EV-ranked ' + toEmit.length + ' signals: ' +
          toEmit.map(function (s) {
            return s.asset + '(' + ((s.conf / 100) * (s.tpRatio || 2.5)).toFixed(2) + ')';
          }).join(', '));
      }

      /* P2-D: Health heartbeat — track approval rate per window */
      _approvalWindows.push({ ts: now, 'in': Object.keys(byAsset).length, out: toEmit.length });
      if (_approvalWindows.length > 12) _approvalWindows.shift();  // keep ~3 min of windows at 15s

      if (toEmit.length) {
        EE.onSignals(toEmit);
      }
    }
  }

  /* ── PUBLIC API ─────────────────────────────────────────────────────────── */
  window.GII_AGENT_ENTRY = {

    /* Called by all signal agents instead of EE.onSignals() directly (Option 2) */
    submit: _submit,

    /* P0-C: Shadow mode — scores signals without emitting, for phased validation */
    shadow: _shadow,

    /* P0-C: Shadow log — compare would-approve decisions against actual trade outcomes */
    shadowLog: function () { return _shadowLog.slice(); },

    /* Force a poll/process cycle right now */
    poll: _processQueue,

    signals: function () { return _approved.slice(0, 20); },

    status: function () {
      /* P2-D: Health heartbeat — check if processing is healthy */
      var _healthy = (Date.now() - _lastProcessedAt) < POLL_MS * 2.5;
      var _zeroApprovalStreak = 0;
      for (var _wi = _approvalWindows.length - 1; _wi >= 0; _wi--) {
        if (_approvalWindows[_wi]['in'] > 0 && _approvalWindows[_wi].out === 0) {
          _zeroApprovalStreak++;
        } else { break; }
      }
      return {
        mode:              'LIVE',
        degraded:          false,
        healthy:           _healthy,
        zeroApprovalStreak: _zeroApprovalStreak,
        lastProcessed:     _lastProcessedAt,
        lastPoll:          _lastPoll,
        queueDepth:        _queue.length,
        stats:             _stats,
        recentApproved:    _approved.slice(0, 5),
        recentRejected:    _rejected.slice(0, 5)
      };
    },

    accuracy: function () {
      return { total: _stats.approved, approved: _stats.approved, rejected: _stats.rejected };
    },

    /* Returns per-asset volatility stop config for any signal source */
    getStops: function (asset) {
      var key = String(asset || '').toUpperCase();
      return VOL_STOPS[key] || VOL_STOP_DEFAULT;
    }
  };

  /* Mark safe-mode stub as superseded — real entry is live */
  window._ENTRY_DEGRADED = false;

  /* ── DASHBOARD UI — Entry Intelligence Status Bar ──────────────────────── */
  function _renderEntryUI() {
    var el = document.getElementById('entryStatusBar');
    if (!el) return;

    var s = _stats;
    var mode = window._ENTRY_DEGRADED ? 'SAFE-STUB' : 'LIVE';
    var modeColor = mode === 'LIVE' ? '#00e676' : '#ff1744';

    /* Health indicator */
    var healthy = (Date.now() - _lastProcessedAt) < POLL_MS * 2.5;
    var healthIcon = healthy ? '<span style="color:#00e676">&#9679;</span>' : '<span style="color:#ff1744">&#9679;</span>';

    /* Last approved signal */
    var lastApprStr = '—';
    if (_approved.length) {
      var la = _approved[0];
      var ago = Math.round((Date.now() - la.ts) / 60000);
      lastApprStr = '<span style="color:#00e676">' + la.asset + ' ' + la.dir + '</span>' +
        ' <span style="color:var(--dim)">score=' + la.score + ' conf=' + la.conf +
        (la.fastPath ? ' [FAST]' : '') + ' ' + ago + 'm ago</span>';
    }

    /* Last rejected signal */
    var lastRejStr = '—';
    if (_rejected.length) {
      var lr = _rejected[0];
      var rejAgo = Math.round((Date.now() - lr.ts) / 60000);
      lastRejStr = '<span style="color:#ff5252">' + lr.asset + ' ' + (lr.dir || '') + '</span>' +
        ' <span style="color:var(--dim)">' + (lr.reason || '').substring(0, 55) + ' ' + rejAgo + 'm ago</span>';
    }

    /* Shadow log count */
    var shadowCount = _shadowLog.length;
    var shadowApproved = _shadowLog.filter(function (s) { return s.wouldApprove; }).length;

    /* Queue depth */
    var qd = _queue.length;

    el.innerHTML =
      '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px 14px">' +
        '<span style="color:#40c4ff;font-size:10px;font-weight:700;letter-spacing:.04em">ENTRY BRAIN</span>' +
        healthIcon +
        '<span style="font-size:9px;color:' + modeColor + ';font-weight:600">' + mode + '</span>' +
        '<span style="font-size:9px;color:var(--dim)">approved <b style="color:#00e676">' + s.approved + '</b></span>' +
        '<span style="font-size:9px;color:var(--dim)">rejected <b style="color:#ff5252">' + s.rejected + '</b></span>' +
        '<span style="font-size:9px;color:var(--dim)">vetoed <b style="color:#ffab40">' + s.vetoed + '</b></span>' +
        '<span style="font-size:9px;color:var(--dim)">queue <b>' + qd + '</b></span>' +
        (shadowCount > 0 ? '<span style="font-size:9px;color:var(--dim)">shadow <b style="color:#b388ff">' + shadowApproved + '/' + shadowCount + '</b> would-approve</span>' : '') +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:4px 18px;margin-top:4px;font-size:9px">' +
        '<span>Last approved: ' + lastApprStr + '</span>' +
        '<span>Last rejected: ' + lastRejStr + '</span>' +
      '</div>';
  }

  function _injectEntryUI() {
    if (document.getElementById('entryStatusBar')) return;
    /* Insert after gatekeeper bar if present, otherwise as second child of eeWrap */
    var eeWrap = document.getElementById('eeWrap');
    if (!eeWrap) return;
    var bar = document.createElement('div');
    bar.id = 'entryStatusBar';
    bar.style.cssText =
      'padding:6px 12px;background:rgba(64,196,255,0.05);border:1px solid rgba(64,196,255,0.18);' +
      'border-radius:6px;margin-bottom:8px;line-height:1.6;';
    var gkBar = document.getElementById('gkStatusBar');
    if (gkBar && gkBar.nextSibling) {
      eeWrap.insertBefore(bar, gkBar.nextSibling);
    } else if (gkBar) {
      eeWrap.appendChild(bar);
    } else {
      eeWrap.insertBefore(bar, eeWrap.firstChild);
    }
    _renderEntryUI();
  }

  /* ── INIT ───────────────────────────────────────────────────────────────── */
  window.addEventListener('load', function () {
    if (_initialized) return;
    _initialized = true;
    setTimeout(function () {
      _processQueue();
      setInterval(function () {
        _lastPoll = Date.now();
        _processQueue();
      }, POLL_MS);

      /* Inject and keep alive the dashboard UI panel */
      _injectEntryUI();
      setInterval(function () {
        if (!document.getElementById('entryStatusBar')) _injectEntryUI();
        _renderEntryUI();
      }, 5000);  // refresh every 5s

      console.log('[GII-ENTRY] Entry intelligence hub online');
    }, INIT_DELAY_MS);
  });

})();
