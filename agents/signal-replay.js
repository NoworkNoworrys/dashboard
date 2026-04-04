/**
 * Signal Replay / Backtester
 *
 * Replays historical closed trades against the attribution data to answer:
 *   - "What if we'd required higher confluence scores?"
 *   - "What if we'd muted agent X?"
 *   - "What if we'd required more categories?"
 *   - "What if we'd used tighter/wider stops?"
 *
 * Uses stored attribution records (with agent votes) and trade history
 * to simulate alternative outcomes without needing raw price data.
 *
 * Exposes: window.GII_REPLAY
 *
 * Public API:
 *   GII_REPLAY.run(scenario)        → { trades, winRate, pnl, avgPnl, filtered }
 *   GII_REPLAY.scenarios()          → list of built-in scenario presets
 *   GII_REPLAY.compare(scenarios[]) → side-by-side comparison
 *   GII_REPLAY.agentImpact(agent)   → simulates muting one agent
 */
(function () {
  'use strict';

  var _ATTR_KEY = 'geodash_attribution_v1';

  /* ── Load historical data ──────────────────────────────────────────────── */
  function _loadRecords() {
    try {
      return JSON.parse(localStorage.getItem(_ATTR_KEY) || '[]');
    } catch (e) { return []; }
  }

  function _loadTrades() {
    if (window.EE && typeof EE.getAllTrades === 'function') {
      return EE.getAllTrades().filter(function (t) { return t.status === 'CLOSED'; });
    }
    return [];
  }

  /* ── Core replay engine ────────────────────────────────────────────────── */

  /**
   * Run a replay scenario against historical trades.
   *
   * Scenario options:
   *   minConfluence:  number  — minimum net consultation score to take trade (default: 0)
   *   minCategories:  number  — minimum distinct agent categories (default: 0)
   *   minConfidence:  number  — minimum signal confidence % (default: 0)
   *   muteAgents:     [str]   — agents to exclude from consultation
   *   boostAgents:    [str]   — agents to give 2× weight
   *   requireAgents:  [str]   — only take trades where these agents voted 'support'
   *   excludeAssets:  [str]   — exclude these assets
   *   onlyAssets:     [str]   — only include these assets
   *   regimeFilter:   string  — only trades in this regime (RISK_ON, RISK_OFF, etc)
   *   maxHoldMin:     number  — exclude trades held longer than N minutes
   *   stopMultiplier: number  — simulate wider/tighter stops (1.0 = actual, 1.5 = 50% wider)
   */
  function run(scenario) {
    var sc = scenario || {};
    var records = _loadRecords();
    var trades  = _loadTrades();

    if (!records.length && !trades.length) {
      return { trades: 0, winRate: 0, pnl: 0, avgPnl: 0, filtered: 0, note: 'No historical data' };
    }

    // Use attribution records if available (richer data), fall back to trades
    var dataset = records.length ? records : trades.map(function (t) {
      return {
        trade_id:    t.trade_id,
        asset:       t.asset,
        direction:   t.direction,
        confidence:  t.confidence,
        source:      t.source,
        confluence:  t.confluenceScore,
        pnl_usd:     t.total_pnl_usd || t.pnl_usd || 0,
        pnl_pct:     t.pnl_pct || 0,
        win:         (t.total_pnl_usd || t.pnl_usd || 0) > 0,
        close_reason: t.close_reason,
        hold_min:    null,
        regime:      null,
        agentVotes:  {}
      };
    });

    var total    = dataset.length;
    var included = [];
    var excluded = 0;

    dataset.forEach(function (r) {
      // Asset filter
      if (sc.excludeAssets && sc.excludeAssets.indexOf(r.asset) !== -1) { excluded++; return; }
      if (sc.onlyAssets && sc.onlyAssets.indexOf(r.asset) === -1) { excluded++; return; }

      // Regime filter
      if (sc.regimeFilter && r.regime && r.regime !== sc.regimeFilter) { excluded++; return; }

      // Hold time filter
      if (sc.maxHoldMin && r.hold_min && r.hold_min > sc.maxHoldMin) { excluded++; return; }

      // Confidence filter
      if (sc.minConfidence && (r.confidence || 0) < sc.minConfidence) { excluded++; return; }

      // Confluence score filter (requires agent votes)
      if (sc.minConfluence && r.agentVotes) {
        var netScore = _simulateConsultation(r.agentVotes, sc.muteAgents, sc.boostAgents);
        if (netScore < sc.minConfluence) { excluded++; return; }
      }

      // Required agents filter
      if (sc.requireAgents && r.agentVotes) {
        var allRequired = sc.requireAgents.every(function (name) {
          var v = r.agentVotes[name];
          return v && v.vote === 'support';
        });
        if (!allRequired) { excluded++; return; }
      }

      // Simulate stop multiplier effect on P&L
      var adjPnl = r.pnl_usd || 0;
      if (sc.stopMultiplier && sc.stopMultiplier !== 1.0 && r.close_reason) {
        adjPnl = _simulateStopChange(r, sc.stopMultiplier);
      }

      included.push({
        trade_id:    r.trade_id,
        asset:       r.asset,
        direction:   r.direction,
        pnl_usd:     adjPnl,
        win:         adjPnl > 0,
        regime:      r.regime,
        source:      r.source,
        confidence:  r.confidence,
        close_reason: r.close_reason
      });
    });

    var wins = included.filter(function (t) { return t.win; }).length;
    var totalPnl = included.reduce(function (s, t) { return s + t.pnl_usd; }, 0);

    // Per-asset breakdown
    var byAsset = {};
    included.forEach(function (t) {
      if (!byAsset[t.asset]) byAsset[t.asset] = { trades: 0, wins: 0, pnl: 0 };
      byAsset[t.asset].trades++;
      if (t.win) byAsset[t.asset].wins++;
      byAsset[t.asset].pnl += t.pnl_usd;
    });
    Object.keys(byAsset).forEach(function (a) {
      byAsset[a].winRate = +(byAsset[a].wins / byAsset[a].trades * 100).toFixed(1);
      byAsset[a].pnl = +byAsset[a].pnl.toFixed(2);
    });

    return {
      trades:   included.length,
      filtered: excluded,
      winRate:  included.length > 0 ? +(wins / included.length * 100).toFixed(1) : 0,
      pnl:      +totalPnl.toFixed(2),
      avgPnl:   included.length > 0 ? +(totalPnl / included.length).toFixed(2) : 0,
      byAsset:  byAsset,
      detail:   included
    };
  }

  /* ── Simulate consultation with muted/boosted agents ───────────────────── */
  function _simulateConsultation(votes, muteList, boostList) {
    var muted   = muteList  || [];
    var boosted = boostList || [];
    var support = 0, oppose = 0;

    Object.keys(votes).forEach(function (name) {
      if (muted.indexOf(name) !== -1) return;  // skip muted
      var v = votes[name];
      var w = v.weight || 0;
      if (boosted.indexOf(name) !== -1) w *= 2;
      if (v.vote === 'support') support += w;
      else if (v.vote === 'oppose') oppose += w;
    });

    return +(support - oppose).toFixed(2);
  }

  /* ── Simulate stop/TP changes ──────────────────────────────────────────── */
  function _simulateStopChange(record, multiplier) {
    // Rough simulation: wider stops = fewer stop-outs but same TP size
    // Tighter stops = more stop-outs but same TP size
    var pnl = record.pnl_usd || 0;
    if (record.close_reason === 'STOP_LOSS' && pnl < 0) {
      // Wider stop: loss would be larger but some stops wouldn't trigger
      // Approximate: at 1.5× wider, ~30% of stop-outs would've survived
      if (multiplier > 1.0) {
        var survivalChance = Math.min(0.5, (multiplier - 1.0) * 0.6);
        // Simulate: this trade has survivalChance probability of not stopping out
        // Use trade_id hash for deterministic replay
        var hash = 0;
        var id = record.trade_id || '';
        for (var i = 0; i < id.length; i++) hash = ((hash << 5) - hash) + id.charCodeAt(i);
        if ((Math.abs(hash) % 100) / 100 < survivalChance) {
          return 0;  // survived — assume break-even (conservative estimate)
        }
        return pnl * multiplier;  // didn't survive — larger loss
      } else {
        // Tighter stop: loss is smaller
        return pnl * multiplier;
      }
    }
    return pnl;  // TP/manual closes unaffected
  }

  /* ── Built-in scenario presets ─────────────────────────────────────────── */
  function scenarios() {
    return [
      { name: 'Baseline',          desc: 'Actual results — no changes',               config: {} },
      { name: 'High Confluence',   desc: 'Only trades with netScore >= 3.0',          config: { minConfluence: 3.0 } },
      { name: 'Very High Conf',    desc: 'Only trades with confidence >= 80%',        config: { minConfidence: 80 } },
      { name: 'Non-Crypto Only',   desc: 'Exclude BTC, ETH, SOL',                    config: { excludeAssets: ['BTC', 'ETH', 'SOL'] } },
      { name: 'Equities Only',     desc: 'SPY, QQQ, TSLA, NVDA, LMT, TSM only',     config: { onlyAssets: ['SPY', 'QQQ', 'TSLA', 'NVDA', 'LMT', 'TSM'] } },
      { name: 'Commodities Only',  desc: 'WTI, BRENT, GLD, GAS, WHT only',           config: { onlyAssets: ['WTI', 'BRENT', 'GLD', 'GAS', 'WHT'] } },
      { name: 'Wider Stops (1.5×)', desc: 'Simulate 50% wider stop losses',          config: { stopMultiplier: 1.5 } },
      { name: 'Tighter Stops (0.7×)', desc: 'Simulate 30% tighter stop losses',      config: { stopMultiplier: 0.7 } },
      { name: 'Risk-On Only',      desc: 'Only trades during RISK_ON regime',         config: { regimeFilter: 'RISK_ON' } },
      { name: 'Risk-Off Only',     desc: 'Only trades during RISK_OFF regime',        config: { regimeFilter: 'RISK_OFF' } },
      { name: 'Quick Trades',      desc: 'Only trades held < 60 minutes',            config: { maxHoldMin: 60 } },
    ];
  }

  /* ── Compare multiple scenarios side by side ───────────────────────────── */
  function compare(scenarioConfigs) {
    if (!Array.isArray(scenarioConfigs)) scenarioConfigs = scenarios().map(function (s) { return s.config; });
    var presets = scenarios();
    return scenarioConfigs.map(function (sc, i) {
      var result = run(sc);
      var preset = presets[i];
      return {
        name:     preset ? preset.name : 'Custom ' + (i + 1),
        desc:     preset ? preset.desc : '',
        trades:   result.trades,
        filtered: result.filtered,
        winRate:  result.winRate,
        pnl:      result.pnl,
        avgPnl:   result.avgPnl
      };
    });
  }

  /* ── Simulate muting a single agent ────────────────────────────────────── */
  function agentImpact(agentName) {
    var baseline = run({});
    var muted    = run({ muteAgents: [agentName] });
    var required = run({ requireAgents: [agentName] });

    return {
      agent:    agentName,
      baseline: { trades: baseline.trades, winRate: baseline.winRate, pnl: baseline.pnl },
      muted:    { trades: muted.trades,    winRate: muted.winRate,    pnl: muted.pnl,
                  desc: 'Results if ' + agentName + ' was excluded from consultation' },
      required: { trades: required.trades, winRate: required.winRate, pnl: required.pnl,
                  desc: 'Results if ' + agentName + ' support was required for every trade' },
      impact:   {
        pnlDelta:     +(muted.pnl - baseline.pnl).toFixed(2),
        winRateDelta: +(muted.winRate - baseline.winRate).toFixed(1),
        verdict:      muted.pnl > baseline.pnl
          ? 'NEGATIVE — removing this agent improves P&L by $' + (muted.pnl - baseline.pnl).toFixed(2)
          : 'POSITIVE — this agent contributes $' + (baseline.pnl - muted.pnl).toFixed(2) + ' to total P&L'
      }
    };
  }

  /* ── Init ───────────────────────────────────────────────────────────────── */
  window.GII_REPLAY = {
    run:         run,
    scenarios:   scenarios,
    compare:     compare,
    agentImpact: agentImpact
  };

  console.log('[SIGNAL-REPLAY] Signal replay / backtester loaded');
})();
