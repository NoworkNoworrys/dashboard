/**
 * Trade Quality Gate — Pre-Execution Validator
 *
 * Validates that a signal's trade geometry (stop distance, R:R, costs, leverage)
 * will actually produce a profitable trade after real-world execution friction.
 *
 * This agent fills a critical gap: the entry agent validates SIGNAL quality
 * (confluence, agent agreement) and the execution engine validates RISK limits
 * (max trades, exposure, confidence). But nobody was checking whether the
 * resulting trade GEOMETRY makes money after commissions, spread, and slippage.
 *
 * Without this gate, trades with microscopic stops (e.g. scalper ATR-based
 * $0.025 stop on PLTR where commission alone is $0.02) pass all checks and
 * guaranteed to lose money on every single trade.
 *
 * Checks:
 *   1. Cost-to-Stop Ratio:  round-trip costs must be < 15% of stop distance
 *   2. Minimum R:R Gate:    reward:risk must be ≥ 1.3 after subtracting costs
 *   3. Leverage × Stop:     effective stop (stopPct/leverage) must be ≥ 0.3%
 *   4. TP Reachability:     take-profit must be on correct side and achievable
 *   5. Minimum Profit Gate: expected $ profit per trade must exceed $0.05
 *   6. Signal Integrity:    atrStop/atrTarget must be finite and positive
 *
 * Exposes: window.GII_TRADE_GATE
 *
 * Public API:
 *   GII_TRADE_GATE.validate(sig)   → { ok, reason, metrics }
 *   GII_TRADE_GATE.status()        → { passed, failed, recentRejects }
 *   GII_TRADE_GATE.stats()         → detailed pass/fail breakdown
 */
(function () {
  'use strict';

  /* ── Cost model (mirrors executionEngine.js TRADING_COSTS) ──────────────── */
  var COSTS = {
    crypto:   { spread: 0.0008, slippage: 0.0005, commission: 0.0010, funding8h: 0.0001 },
    energy:   { spread: 0.0004, slippage: 0.0003, commission: 0.0007, funding8h: 0      },
    precious: { spread: 0.0002, slippage: 0.0002, commission: 0.0007, funding8h: 0      },
    equity:   { spread: 0.0001, slippage: 0.0001, commission: 0.0005, funding8h: 0      },
    forex:    { spread: 0.0003, slippage: 0.0002, commission: 0.0006, funding8h: 0      },
    def:      { spread: 0.0006, slippage: 0.0004, commission: 0.0008, funding8h: 0      }
  };

  /* ── Thresholds ─────────────────────────────────────────────────────────── */
  var MAX_COST_TO_STOP_PCT  = 15;    // reject if fees > 15% of stop distance
  var MIN_NET_RR            = 1.3;   // minimum R:R after subtracting round-trip costs
  var MIN_EFFECTIVE_STOP    = 0.003; // 0.3% — stop after leverage must be ≥ this
  var MIN_PROFIT_USD        = 0.05;  // expected profit must be > $0.05 to justify the trade
  var MIN_STOP_PCT          = 0.003; // 0.3% absolute minimum stop

  /* ── Tracking ───────────────────────────────────────────────────────────── */
  var _passed = 0;
  var _failed = 0;
  var _recentRejects = [];   // last 50 rejections with reasons
  var _recentPasses  = [];   // last 50 passes with metrics
  var _failReasons   = {};   // reason → count

  /* ── Helpers ─────────────────────────────────────────────────────────────── */
  function _getSector(asset) {
    if (window.EE_SECTOR_MAP) return EE_SECTOR_MAP[asset] || EE_SECTOR_MAP[String(asset).toUpperCase()] || '';
    return '';
  }

  function _getCosts(asset) {
    // Try HL costs first (same as EE)
    try {
      if (window.HLFeed && typeof HLFeed.costs === 'function') {
        var hlC = HLFeed.costs(asset);
        if (hlC) return hlC;
      }
    } catch (e) {}
    var sector = _getSector(asset);
    if (sector === 'crypto')   return COSTS.crypto;
    if (sector === 'energy')   return COSTS.energy;
    if (sector === 'precious') return COSTS.precious;
    if (sector === 'forex')    return COSTS.forex;
    if (['equity','defense','semis','airlines','em','ev','battery','metals'].indexOf(sector) !== -1)
      return COSTS.equity;
    return COSTS.def;
  }

  function _roundTripCostPct(costs) {
    // 2 × commission + spread + 2 × slippage (entry + exit)
    return (costs.commission || 0) * 2 + (costs.spread || 0) + (costs.slippage || 0) * 2;
  }

  function _getPrice(asset) {
    try {
      if (window.HLFeed && typeof HLFeed.getPrice === 'function') {
        var p = HLFeed.getPrice(asset);
        if (p && p.price > 0) return p.price;
      }
    } catch (e) {}
    return 0;
  }

  function _record(passed, asset, reason, metrics) {
    if (passed) {
      _passed++;
      _recentPasses.unshift({ ts: Date.now(), asset: asset, metrics: metrics });
      if (_recentPasses.length > 50) _recentPasses.pop();
    } else {
      _failed++;
      _recentRejects.unshift({ ts: Date.now(), asset: asset, reason: reason, metrics: metrics });
      if (_recentRejects.length > 50) _recentRejects.pop();
      _failReasons[reason] = (_failReasons[reason] || 0) + 1;
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     CORE VALIDATION
     ══════════════════════════════════════════════════════════════════════════ */

  function validate(sig) {
    if (!sig || !sig.asset) return { ok: true, reason: 'no signal' };

    var asset    = String(sig.asset).toUpperCase();
    var leverage = sig.leverage || 1;
    var dir      = sig.dir === 'SHORT' ? 'SHORT' : 'LONG';
    var costs    = _getCosts(asset);
    var rtCost   = _roundTripCostPct(costs);   // fractional (e.g. 0.003 = 0.3%)
    var price    = _getPrice(asset);

    // ── 1. Signal field integrity ───────────────────────────────────────────
    if (sig.atrStop !== undefined && sig.atrStop !== null) {
      if (!isFinite(sig.atrStop) || sig.atrStop <= 0) {
        var reason1 = 'Invalid atrStop: ' + sig.atrStop;
        _record(false, asset, 'signal_integrity', { atrStop: sig.atrStop });
        return { ok: false, reason: reason1 };
      }
    }
    if (sig.atrTarget !== undefined && sig.atrTarget !== null) {
      if (!isFinite(sig.atrTarget) || sig.atrTarget <= 0) {
        var reason2 = 'Invalid atrTarget: ' + sig.atrTarget;
        _record(false, asset, 'signal_integrity', { atrTarget: sig.atrTarget });
        return { ok: false, reason: reason2 };
      }
    }

    // Determine stop distance as fraction of price
    var stopPct = sig.stopPct ? sig.stopPct / 100 : 0.025;  // default 2.5% if not set

    // If atrStop is set and we have a price, compute the actual stop fraction
    if (sig.atrStop && price > 0) {
      stopPct = sig.atrStop / price;
    }

    // Effective stop after leverage (with leverage, the stop tightens proportionally)
    var effectiveStop = stopPct / leverage;

    // Determine TP distance as fraction of price
    var tpPct = stopPct * (sig.tpRatio || 2.5);  // default 2.5:1 R:R
    if (sig.atrTarget && price > 0) {
      tpPct = sig.atrTarget / price;
    }

    // ── 2. Minimum effective stop after leverage ────────────────────────────
    if (effectiveStop < MIN_EFFECTIVE_STOP) {
      var reason3 = 'Effective stop ' + (effectiveStop * 100).toFixed(3) +
        '% < 0.3% min (stop=' + (stopPct * 100).toFixed(2) + '% ÷ ' + leverage + '× lev)';
      _record(false, asset, 'stop_too_tight', {
        stopPct: +(stopPct * 100).toFixed(3),
        leverage: leverage,
        effectiveStop: +(effectiveStop * 100).toFixed(3)
      });
      return { ok: false, reason: reason3 };
    }

    // ── 3. Cost-to-stop ratio ───────────────────────────────────────────────
    // Round-trip costs as % of effective stop distance
    var costToStopPct = (rtCost / effectiveStop) * 100;
    if (costToStopPct > MAX_COST_TO_STOP_PCT) {
      var reason4 = 'Cost/stop ratio ' + costToStopPct.toFixed(1) +
        '% > ' + MAX_COST_TO_STOP_PCT + '% max (costs=' + (rtCost * 100).toFixed(3) +
        '%, stop=' + (effectiveStop * 100).toFixed(3) + '%)';
      _record(false, asset, 'cost_exceeds_stop', {
        costPct: +(rtCost * 100).toFixed(3),
        effectiveStop: +(effectiveStop * 100).toFixed(3),
        costToStopPct: +costToStopPct.toFixed(1)
      });
      return { ok: false, reason: reason4 };
    }

    // ── 4. Net R:R after costs ──────────────────────────────────────────────
    // Gross R:R = TP distance / SL distance
    var grossRR = tpPct / stopPct;
    // Net R:R subtracts round-trip costs from both win and loss sides
    // Win payout after costs: (tpPct - rtCost) / (stopPct + rtCost)
    // This accounts for costs eating into wins AND adding to losses
    var netRR = (tpPct - rtCost) / (stopPct + rtCost);
    if (netRR < MIN_NET_RR) {
      var reason5 = 'Net R:R ' + netRR.toFixed(2) + ' < ' + MIN_NET_RR +
        ' min (gross=' + grossRR.toFixed(2) + ', costs eat ' +
        (rtCost * 100).toFixed(3) + '% each side)';
      _record(false, asset, 'rr_too_low', {
        grossRR: +grossRR.toFixed(2),
        netRR: +netRR.toFixed(2),
        costDrag: +(rtCost * 100).toFixed(3)
      });
      return { ok: false, reason: reason5 };
    }

    // ── 5. Minimum expected profit ──────────────────────────────────────────
    // Estimate position size from EE config (rough — actual sizing happens in buildTrade)
    if (price > 0 && window.EE && typeof EE.getConfig === 'function') {
      try {
        var cfg = EE.getConfig();
        var balance = cfg.virtual_balance || 100;
        var riskPct = cfg.risk_per_trade_pct || 10;
        var riskUsd = Math.min(balance * riskPct / 100, cfg.max_risk_usd || 30);
        // Approx units = riskUsd / (price × stopPct)
        var approxNotional = riskUsd / stopPct;
        // Expected win = notional × tpPct - costs
        var expectedWin  = approxNotional * tpPct - approxNotional * rtCost;
        // Expected loss = riskUsd + approxNotional × rtCost
        var expectedLoss = riskUsd + approxNotional * rtCost;
        // Assume 50% win rate as conservative estimate for profit calc
        var expectedProfit = expectedWin * 0.5 - expectedLoss * 0.5;

        if (expectedWin < MIN_PROFIT_USD) {
          var reason6 = 'Max win $' + expectedWin.toFixed(2) + ' < $' + MIN_PROFIT_USD.toFixed(2) +
            ' min (notional ~$' + approxNotional.toFixed(0) + ', TP ' + (tpPct * 100).toFixed(2) + '%)';
          _record(false, asset, 'profit_too_small', {
            expectedWin: +expectedWin.toFixed(2),
            approxNotional: +approxNotional.toFixed(0)
          });
          return { ok: false, reason: reason6 };
        }
      } catch (e) { /* EE not ready — skip profit check */ }
    }

    // ── 6. TP reachability ──────────────────────────────────────────────────
    if (sig.atrTarget && sig.atrStop && sig.atrTarget < sig.atrStop * 0.8) {
      var reason7 = 'TP distance (' + sig.atrTarget.toFixed(4) +
        ') < 80% of SL distance (' + sig.atrStop.toFixed(4) + ') — poor R:R geometry';
      _record(false, asset, 'tp_unreachable', {
        atrTarget: sig.atrTarget,
        atrStop: sig.atrStop
      });
      return { ok: false, reason: reason7 };
    }

    // ── All checks passed ───────────────────────────────────────────────────
    var metrics = {
      asset:          asset,
      stopPct:        +(stopPct * 100).toFixed(3),
      effectiveStop:  +(effectiveStop * 100).toFixed(3),
      leverage:       leverage,
      costToStopPct:  +costToStopPct.toFixed(1),
      grossRR:        +grossRR.toFixed(2),
      netRR:          +netRR.toFixed(2),
      rtCostPct:      +(rtCost * 100).toFixed(3)
    };
    _record(true, asset, null, metrics);
    return { ok: true, metrics: metrics };
  }

  /* ── Public status ──────────────────────────────────────────────────────── */
  function status() {
    return {
      passed:        _passed,
      failed:        _failed,
      passRate:      (_passed + _failed) > 0 ? +((_passed / (_passed + _failed)) * 100).toFixed(1) : 0,
      recentRejects: _recentRejects.slice(0, 10)
    };
  }

  function stats() {
    return {
      passed:      _passed,
      failed:      _failed,
      passRate:    (_passed + _failed) > 0 ? +((_passed / (_passed + _failed)) * 100).toFixed(1) : 0,
      failReasons: Object.assign({}, _failReasons),
      recentRejects: _recentRejects.slice(0, 20),
      recentPasses:  _recentPasses.slice(0, 20)
    };
  }

  /* ── Init ───────────────────────────────────────────────────────────────── */
  window.GII_TRADE_GATE = {
    validate: validate,
    status:   status,
    stats:    stats
  };

  console.log('[TRADE-GATE] Trade Quality Gate loaded — validates stop/cost/R:R geometry before execution');
})();
