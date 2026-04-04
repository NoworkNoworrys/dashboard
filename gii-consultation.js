/* GII Consultation System — gii-consultation.js v1
 *
 * Before any signal becomes a trade, actively asks ALL 44 domain agents
 * for their opinion. Genuine multi-agent consensus — not temporal coincidence.
 *
 * Parts:
 *   1. Entry consultation  — evaluate(asset, dir) → verdict + conf adjustment
 *   2. Early signal tracking — which agents are early + right → dynamic weights
 *   3. Exit consultation   — checkThesisHealth(entry, recheck, pnlPct) → action
 *   4. Confidence calibration — actual vs stated confidence per agent/band
 *
 * Exposes: window.GII_CONSULTATION
 * Load order: after gii-scalper-brain.js, before agents that consume it
 */
(function () {
  'use strict';

  var TRACK_KEY = 'gii_consultation_track_v1';
  var CALIB_KEY = 'gii_consultation_calib_v1';

  // ── Local helpers (mirrors EE — available before EE loads) ───────────────

  function _norm(asset) {
    return String(asset || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // ── Sector map (subset of EE_SECTOR_MAP) ─────────────────────────────────

  var SECTOR_MAP = {
    'WTI':'energy',   'BRENT':'energy', 'GAS':'energy',   'XLE':'energy',
    'XAU':'precious', 'GLD':'precious', 'SLV':'precious', 'PAXG':'precious', 'GOLD':'precious',
    'XAR':'defense',  'LMT':'defense',  'RTX':'defense',  'NOC':'defense',
    'BTC':'crypto',   'ETH':'crypto',   'SOL':'crypto',   'BNB':'crypto',
    'ADA':'crypto',   'DOGE':'crypto',  'AVAX':'crypto',  'LINK':'crypto',
    'TSLA':'equity',  'AAPL':'equity',  'AMZN':'equity',  'META':'equity',
    'MSFT':'equity',  'GOOGL':'equity', 'SPY':'equity',   'QQQ':'equity',
    'VXX':'equity',   'VIX':'equity',   'NVDA':'equity',  'HOOD':'equity',
    'SMH':'semis',    'TSM':'semis',
    'EURUSD':'forex', 'GBPUSD':'forex', 'USDJPY':'forex', 'USDCHF':'forex',
    'AUDUSD':'forex', 'USDCAD':'forex', 'NZDUSD':'forex'
  };

  // Maps assets to geopolitical region for fallback matching
  var ASSET_REGION_MAP = {
    'WTI':'MIDDLE_EAST', 'BRENT':'MIDDLE_EAST', 'GAS':'EASTERN_EUROPE',
    'GLD':'GLOBAL',  'PAXG':'GLOBAL',  'SLV':'GLOBAL',  'GOLD':'GLOBAL',
    'TSM':'TAIWAN',  'SMH':'TAIWAN',
    'LMT':'GLOBAL',  'RTX':'GLOBAL',   'XAR':'GLOBAL',
    'FXI':'CHINA',
    'VXX':'GLOBAL',  'VIX':'GLOBAL'
  };

  // ── Agent registry ────────────────────────────────────────────────────────
  // tier A: has custom .consult(asset, dir) method added directly
  // tier B: queried via .signals() array matching
  // weight: base vote multiplier before dynamic adjustment

  var AGENT_REGISTRY = [
    // Tier A — custom .consult() (8 agents, modified files)
    { name: 'GII_AGENT_MACRO',      tier: 'A', weight: 0.9 },
    { name: 'GII_SCALPER_BRAIN',    tier: 'A', weight: 0.8 },
    { name: 'GII_AGENT_REGIME',     tier: 'A', weight: 0.9 },
    { name: 'MacroRegime',          tier: 'A', weight: 0.7 },
    { name: 'GII_AGENT_RISK',       tier: 'A', weight: 0.7 },
    { name: 'GII_AGENT_LIQUIDITY',  tier: 'A', weight: 0.6 },
    { name: 'GII_AGENT_EXIT',       tier: 'A', weight: 0.7 },
    { name: 'ECON_CALENDAR',        tier: 'A', weight: 0.7 },
    // Tier B — .signals() matching (36 agents, no file changes needed)
    { name: 'GII_AGENT_TECHNICALS',      tier: 'B', weight: 1.2 },
    { name: 'GII_AGENT_ENERGY',          tier: 'B', weight: 1.1 },
    { name: 'GII_AGENT_CONFLICT',        tier: 'B', weight: 1.1 },
    { name: 'GII_AGENT_SANCTIONS',       tier: 'B', weight: 1.0 },
    { name: 'GII_AGENT_MARITIME',        tier: 'B', weight: 1.0 },
    { name: 'GII_AGENT_CHOKEPOINT',      tier: 'B', weight: 0.9 },
    { name: 'GII_AGENT_ESCALATION',      tier: 'B', weight: 0.9 },
    { name: 'GII_AGENT_DEESCALATION',    tier: 'B', weight: 0.8 },
    { name: 'GII_AGENT_NARRATIVE',       tier: 'B', weight: 0.8 },
    { name: 'GII_AGENT_SCENARIO',        tier: 'B', weight: 0.8 },
    { name: 'GII_AGENT_CRISISRANK',      tier: 'B', weight: 0.7 },
    { name: 'GII_AGENT_SATINTEL',        tier: 'B', weight: 0.7 },
    { name: 'GII_AGENT_SATELLITE',       tier: 'B', weight: 0.7 },
    { name: 'GII_AGENT_HISTORICAL',      tier: 'B', weight: 0.7 },
    { name: 'GII_AGENT_MACROSTRESS',     tier: 'B', weight: 0.7 },
    { name: 'GII_AGENT_MACRO_EVENTS',    tier: 'B', weight: 0.8 },
    { name: 'GII_AGENT_MACRO_CROSS',     tier: 'B', weight: 0.7 },
    { name: 'FOREX_FUNDAMENTALS',        tier: 'B', weight: 0.7 },
    { name: 'GII_AGENT_SOCIAL',          tier: 'B', weight: 0.6 },
    { name: 'GII_AGENT_MARKETSTRUCTURE', tier: 'B', weight: 0.9 },
    { name: 'GII_AGENT_SCALPER',         tier: 'B', weight: 0.8 },
    { name: 'GII_AGENT_SCALPER_SESSION', tier: 'B', weight: 0.7 },
    { name: 'GII_SCRAPER_MANAGER',       tier: 'B', weight: 0.7 },
    { name: 'GII_AGENT_SMARTMONEY',      tier: 'B', weight: 1.0 },
    { name: 'GII_AGENT_MARKET_OBSERVER', tier: 'B', weight: 0.7 },
    { name: 'GII_AGENT_MOMENTUM',        tier: 'B', weight: 0.7 },
    { name: 'GII_AGENT_TA_SCANNER',      tier: 'B', weight: 0.7 },
    { name: 'GII_AGENT_OPENING_BIAS',    tier: 'B', weight: 0.6 },
    { name: 'GII_AGENT_CRYPTO_SIGNALS',  tier: 'B', weight: 0.7 },
    { name: 'FUNDING_RATES',             tier: 'B', weight: 0.8 },
    { name: 'GII_AGENT_ONCHAIN',         tier: 'B', weight: 0.7 },
    { name: 'GII_AGENT_CORRELATION',     tier: 'B', weight: 0.7 },
    { name: 'GII_AGENT_POLYMARKET',      tier: 'B', weight: 1.0 },
    { name: 'GII_AGENT_FORECAST',        tier: 'B', weight: 0.8 },
    { name: 'GII_SENTIMENT_NEWS',        tier: 'B', weight: 0.8 },
    { name: 'UW_INTELLIGENCE',           tier: 'B', weight: 1.0 },
    { name: 'GII_AGENT_PORTFOLIO',       tier: 'B', weight: 0.6 }
  ];

  // ── Persistence ───────────────────────────────────────────────────────────

  var _trackRecords = {};  // agentName → {wins/losses/accuracy/leadTime}
  var _calibration  = {};  // agentName → {band → {stated, actual, count}}
  var _snapshots    = {};  // tradeId  → consultation snapshot at entry

  function _loadState() {
    try { var t = localStorage.getItem(TRACK_KEY); if (t) _trackRecords = JSON.parse(t); } catch (e) { _trackRecords = {}; }
    try { var c = localStorage.getItem(CALIB_KEY); if (c) _calibration  = JSON.parse(c); } catch (e) { _calibration  = {}; }
  }

  function _saveState() {
    try { localStorage.setItem(TRACK_KEY, JSON.stringify(_trackRecords)); } catch (e) {}
    try { localStorage.setItem(CALIB_KEY, JSON.stringify(_calibration));  } catch (e) {}
  }

  // ── Dynamic weight from track record ─────────────────────────────────────

  function _dynamicWeight(agentName, baseWeight) {
    var track = _trackRecords[agentName];
    if (!track || track.totalVotes < 10) return baseWeight;

    var accuracy = track.earlyAccuracy || 0.5;
    var accMult;
    if      (accuracy >= 0.80) accMult = 1.30;
    else if (accuracy >= 0.60) accMult = 1.00 + (accuracy - 0.60) * 1.50;
    else if (accuracy >= 0.40) accMult = 0.70 + (accuracy - 0.40) * 1.50;
    else                       accMult = 0.50;

    // Lead time bonus: early + accurate gets extra credit (up to +0.25)
    var leadBonus = (accuracy >= 0.60 && track.avgLeadMinutes > 5)
      ? Math.min(0.25, track.avgLeadMinutes / 60)
      : 0;

    // Blend gradually: 10–30 votes transitions from static to fully dynamic
    var dynFrac = Math.min(1.0, (track.totalVotes - 10) / 20);
    var blended = (1 - dynFrac) * 1.0 + dynFrac * (accMult + leadBonus);

    return baseWeight * Math.min(2.0, blended);
  }

  // ── Calibrated weight ─────────────────────────────────────────────────────

  function _calibrateWeight(agentName, statedConf, rawWeight) {
    var cal = _calibration[agentName];
    if (!cal) return rawWeight;
    var band = (Math.floor(statedConf * 10) * 10) + '-' + (Math.floor(statedConf * 10) * 10 + 10);
    var entry = cal[band];
    if (!entry || entry.count < 20) return rawWeight;
    var ratio = (entry.actual / 100) / Math.max(0.01, entry.stated / 100);
    // Blend calibration in gradually between 20–50 data points
    var blend = Math.min(1.0, (entry.count - 20) / 30);
    var adjusted = (1 - blend) + blend * ratio;
    return rawWeight * Math.max(0.6, Math.min(1.4, adjusted));
  }

  // ── Signal matching for Tier B agents ────────────────────────────────────

  function _matchSignals(agentName, signals, asset, dir) {
    if (!signals || !signals.length) return { vote: 'abstain', weight: 0, reason: 'no signals', ts: null };

    var normAsset = _norm(asset);
    var dirLower  = (dir || '').toLowerCase();

    // 1. Exact asset match
    var matches = signals.filter(function (s) { return _norm(s.asset) === normAsset; });

    // 2. Region fallback (geo agents)
    if (!matches.length) {
      var region = ASSET_REGION_MAP[normAsset];
      if (region) {
        matches = signals.filter(function (s) {
          return s.region && s.region.toUpperCase() === region;
        });
      }
    }

    if (!matches.length) return { vote: 'abstain', weight: 0, reason: 'no view on ' + asset, ts: null };

    // Pick highest-confidence match (not just most-recent) for best signal quality
    var best = matches.reduce(function (a, b) {
      var ca = a.confidence || a.conf || 0;
      var cb = b.confidence || b.conf || 0;
      return cb > ca ? b : a;
    });
    var sigDir = ((best.bias || best.dir || '')).toLowerCase();
    var conf   = best.confidence || best.conf || 0;
    if (conf > 1) conf /= 100;

    var rawW = Math.min(1.0, conf > 0 ? conf : 0.5);
    var weight = _calibrateWeight(agentName, conf, rawW);
    var sigTs  = best.timestamp || best.ts || best._ts || null;
    var reason = best.reasoning || best.reason || '';

    if (sigDir === dirLower) {
      return { vote: 'support', weight: weight, reason: reason, ts: sigTs };
    }
    if (sigDir && sigDir !== dirLower && sigDir !== 'neutral' && sigDir !== 'watch') {
      return { vote: 'oppose', weight: weight, reason: reason, ts: sigTs };
    }
    return { vote: 'abstain', weight: 0.1, reason: 'neutral', ts: sigTs };
  }

  // ── Query one agent ───────────────────────────────────────────────────────

  function _queryAgent(entry, asset, dir) {
    var agentRef = window[entry.name];
    if (!agentRef) return { vote: 'abstain', weight: 0, reason: 'not loaded', ts: null };

    try {
      if (entry.tier === 'A' && typeof agentRef.consult === 'function') {
        var r = agentRef.consult(asset, dir);
        return r || { vote: 'abstain', weight: 0, reason: 'no result', ts: null };
      }
      if (typeof agentRef.signals === 'function') {
        return _matchSignals(entry.name, agentRef.signals(), asset, dir);
      }
    } catch (e) {
      return { vote: 'abstain', weight: 0, reason: 'err:' + (e.message || '?'), ts: null };
    }
    return { vote: 'abstain', weight: 0, reason: 'no interface', ts: null };
  }

  // ── PART 1: Entry evaluation ──────────────────────────────────────────────

  function evaluate(asset, dir) {
    var normAsset    = _norm(asset);
    var dirUpper     = (dir || 'LONG').toUpperCase();
    var supportScore = 0;
    var opposeScore  = 0;
    var voterCount   = 0;
    var opinions     = [];

    for (var i = 0; i < AGENT_REGISTRY.length; i++) {
      var entry  = AGENT_REGISTRY[i];
      var result = _queryAgent(entry, normAsset, dirUpper);
      var baseW  = _dynamicWeight(entry.name, entry.weight);
      var effW   = +(result.weight * baseW).toFixed(3);

      opinions.push({
        agent:  entry.name,
        vote:   result.vote || 'abstain',
        weight: effW,
        reason: result.reason || '',
        ts:     result.ts || null
      });

      if (result.vote === 'support') { supportScore += effW; voterCount++; }
      else if (result.vote === 'oppose')  { opposeScore  += effW; voterCount++; }
    }

    var netScore  = +(supportScore - opposeScore).toFixed(2);
    var verdict, confAdjust;

    if (voterCount < 3) {
      verdict = 'MIXED'; confAdjust = 0;          // too few opinions — don't adjust
    } else if (netScore >= 3.0) {
      verdict = 'STRONG_CONSENSUS'; confAdjust = 6;
    } else if (netScore >= 1.5) {
      verdict = 'APPROVED';         confAdjust = 3;
    } else if (netScore >= 0.5) {
      verdict = 'LEAN_APPROVE';     confAdjust = 1;
    } else if (netScore >= -0.5) {
      verdict = 'MIXED';            confAdjust = 0;
    } else if (netScore >= -1.5) {
      verdict = 'CAUTION';          confAdjust = -4;
    } else {
      verdict = 'BLOCKED';          confAdjust = 0;
    }

    var supporters = opinions.filter(function (o) { return o.vote === 'support'; })
      .sort(function (a, b) { return b.weight - a.weight; }).slice(0, 3)
      .map(function (o) { return o.agent.replace(/^GII_AGENT_/, ''); }).join(', ');
    var opposers = opinions.filter(function (o) { return o.vote === 'oppose'; })
      .sort(function (a, b) { return b.weight - a.weight; }).slice(0, 3)
      .map(function (o) { return o.agent.replace(/^GII_AGENT_/, ''); }).join(', ');
    var summary = verdict + ' net=' + netScore +
      (supporters ? ' for:' + supporters : '') +
      (opposers   ? ' against:' + opposers : '') +
      ' (' + voterCount + ' voters)';

    return {
      verdict:      verdict,
      netScore:     netScore,
      confAdjust:   confAdjust,
      voterCount:   voterCount,
      supportScore: +supportScore.toFixed(2),
      opposeScore:  +opposeScore.toFixed(2),
      opinions:     opinions,
      summary:      summary,
      ts:           Date.now()
    };
  }

  // ── PART 3: Thesis health check (exit consultation) ───────────────────────

  function checkThesisHealth(entryResult, recheckResult, pnlPct) {
    if (!entryResult || !recheckResult) return 'NO_ACTION';

    var entryVotes   = {};
    var recheckVotes = {};
    // Handle both full evaluate result (opinions[]) and snapshot (votes dict keyed by agent name)
    var entryOps = entryResult.opinions ||
      Object.keys(entryResult.votes || {}).map(function (a) {
        return Object.assign({ agent: a }, entryResult.votes[a]);
      });
    entryOps.forEach(function (o) { entryVotes[o.agent]   = o.vote; });
    (recheckResult.opinions || []).forEach(function (o) { recheckVotes[o.agent] = o.vote; });

    // Count thesis flips: supported at entry, now opposing
    var flips = 0;
    Object.keys(entryVotes).forEach(function (a) {
      if (entryVotes[a] === 'support' && recheckVotes[a] === 'oppose') flips++;
    });

    var scoreDrop = (entryResult.netScore || 0) - (recheckResult.netScore || 0);
    var safePnl   = (pnlPct || 0) > 1.5;  // in profit — don't force-close

    // 3+ original supporters reversed → thesis dead
    if (flips >= 3)
      return safePnl ? 'TIGHTEN_STOP' : 'FORCE_CLOSE';

    // Consensus completely reversed (positive → strongly negative)
    if (recheckResult.netScore < -1.5 && entryResult.netScore > 0)
      return safePnl ? 'TIGHTEN_STOP' : 'FORCE_CLOSE';

    // 2 flips + big score drop
    if (flips >= 2 && scoreDrop > 3.0)
      return safePnl ? 'TIGHTEN_STOP' : 'FORCE_CLOSE';

    // Score eroded into negative territory
    if (scoreDrop > 2.0 && recheckResult.netScore < -0.5)
      return 'TIGHTEN_STOP';

    // Moderate drop while in profit — protect gains
    if (scoreDrop > 1.5 && (pnlPct || 0) > 0)
      return 'TIGHTEN_STOP';

    return 'NO_ACTION';
  }

  // ── PART 2: Snapshot management ──────────────────────────────────────────

  function snapshotTrade(tradeId, asset, dir, consultResult) {
    if (!tradeId || !consultResult) return;
    var votes = {};
    (consultResult.opinions || []).forEach(function (o) {
      votes[o.agent] = { vote: o.vote, weight: o.weight, ts: o.ts };
    });
    _snapshots[tradeId] = {
      tradeId: tradeId, asset: asset, dir: dir,
      openTs: Date.now(), netScore: consultResult.netScore, votes: votes
    };
    // Prune snapshots older than 48h
    var cutoff = Date.now() - 172800000;
    Object.keys(_snapshots).forEach(function (id) {
      if (_snapshots[id].openTs < cutoff) delete _snapshots[id];
    });
  }

  function getSnapshot(tradeId) { return _snapshots[tradeId] || null; }

  // ── PART 2 + 4: Outcome recording ────────────────────────────────────────

  function recordOutcome(trade) {
    var snap = _snapshots[trade.trade_id];
    if (!snap) return;

    var win = trade.close_reason === 'TAKE_PROFIT' ||
              trade.close_reason === 'TRAILING_STOP' ||
              (trade.pnl_usd != null && trade.pnl_usd > 0);
    var openTs = snap.openTs;

    Object.keys(snap.votes).forEach(function (agentName) {
      var v = snap.votes[agentName];
      if (v.vote === 'abstain') return;

      var correct = (v.vote === 'support' && win) || (v.vote === 'oppose' && !win);
      var leadMs  = (v.ts && v.ts < openTs) ? (openTs - v.ts) : 0;

      // ── Track record update ──
      if (!_trackRecords[agentName]) {
        _trackRecords[agentName] = {
          earlySupport_wins: 0, earlySupport_losses: 0,
          earlyOppose_wins:  0, earlyOppose_losses:  0,
          totalLeadMs: 0, totalVotes: 0, earlyAccuracy: 0.5, avgLeadMinutes: 0
        };
      }
      var t = _trackRecords[agentName];
      if (v.vote === 'support') { if (win) t.earlySupport_wins++; else t.earlySupport_losses++; }
      else                     { if (win) t.earlyOppose_losses++; else t.earlyOppose_wins++;  }
      t.totalVotes++;
      t.totalLeadMs += leadMs;
      var totalCorrect  = t.earlySupport_wins + t.earlyOppose_wins;
      t.earlyAccuracy   = totalCorrect / t.totalVotes;
      t.avgLeadMinutes  = t.totalLeadMs / t.totalVotes / 60000;

      // ── Calibration update ──
      // v.weight is effective weight (result.weight * dynamicBaseWeight), which can exceed 1.0.
      // Clamp to [0, 1] so band keys ("60-70" etc.) stay consistent with _calibrateWeight lookups.
      var conf = Math.min(1.0, v.weight);
      if (conf > 0.01) {
        if (!_calibration[agentName]) _calibration[agentName] = {};
        var band = (Math.floor(conf * 10) * 10) + '-' + (Math.floor(conf * 10) * 10 + 10);
        if (!_calibration[agentName][band])
          _calibration[agentName][band] = { stated: 0, actual: 0, count: 0 };
        var cb = _calibration[agentName][band];
        cb.count++;
        cb.stated = ((cb.stated * (cb.count - 1)) + conf * 100) / cb.count;
        cb.actual = ((cb.actual * (cb.count - 1)) + (win ? 100 : 0)) / cb.count;
      }
    });

    delete _snapshots[trade.trade_id];
    _saveState();
  }

  // ── Status / analytics ────────────────────────────────────────────────────

  function status() {
    var leaders = Object.keys(_trackRecords)
      .filter(function (n) { return _trackRecords[n].totalVotes >= 10; })
      .sort(function (a, b) {
        return (_trackRecords[b].earlyAccuracy || 0) - (_trackRecords[a].earlyAccuracy || 0);
      })
      .slice(0, 10)
      .map(function (n) {
        var t = _trackRecords[n];
        return {
          agent:    n.replace(/^GII_AGENT_/, ''),
          accuracy: Math.round(t.earlyAccuracy * 100) + '%',
          leadMin:  +t.avgLeadMinutes.toFixed(1),
          votes:    t.totalVotes,
          dynWeight: +_dynamicWeight(n,
            ((AGENT_REGISTRY.find(function (r) { return r.name === n; }) || {}).weight || 0.7)
          ).toFixed(2)
        };
      });

    return {
      agentsRegistered: AGENT_REGISTRY.length,
      pendingSnapshots: Object.keys(_snapshots).length,
      trackedAgents:    Object.keys(_trackRecords).length,
      topAgentsByAccuracy: leaders
    };
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  _loadState();

  // ── Public API ────────────────────────────────────────────────────────────
  window.GII_CONSULTATION = {
    evaluate:          evaluate,
    checkThesisHealth: checkThesisHealth,
    snapshotTrade:     snapshotTrade,
    getSnapshot:       getSnapshot,
    recordOutcome:     recordOutcome,
    status:            status,
    trackRecords:      function () { return Object.assign({}, _trackRecords); },
    calibration:       function () { return Object.assign({}, _calibration);  }
  };

  console.log('[GII-CONSULTATION] Online — ' + AGENT_REGISTRY.length + ' agents registered (8 Tier-A, 36 Tier-B)');

})();
