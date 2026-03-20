/**
 * ic-risk-engine.js  v1
 * IC Edge Monitor & Dynamic Capital Allocator
 *
 * Tracks IC-specific trade metrics over rolling windows and dynamically
 * adjusts per-trade risk multiplier and total exposure limits based on
 * observed (not assumed) edge.  Self-contained — reads directly from
 * localStorage; no dependency on other agents being loaded first.
 *
 * Integration:
 *   executionEngine.js  → calls ICRiskEngine.getICRiskMultiplier(asset)
 *                          and ICRiskEngine.isAtMaxICExposure(balance, openUSD)
 *   gii-exit.js         → calls ICRiskEngine.onICTradeClosed() after every IC close
 *
 * Console inspection:
 *   ICRiskEngine.getStatus()    → full snapshot (metrics, multiplier, log)
 *   ICRiskEngine.recalculate()  → force recalc now
 *   ICRiskEngine._cfg           → live-tune thresholds without reload
 *
 * Exposes window.ICRiskEngine
 */
(function (window) {
  'use strict';

  /* ── CONFIG ─────────────────────────────────────────────────────────────── */
  var CFG = {
    /* Rolling windows (closed IC trades) */
    WINDOW_MIN:       10,   // minimum trades before scaling activates
    WINDOW_PRIMARY:   20,   // fast signal — last N IC trades
    WINDOW_SECONDARY: 60,   // trend context — last N IC trades

    /* Scale-UP criteria (both must hold, checked on PRIMARY window) */
    SCALE_UP_EXPECTANCY: 0,      // expectancy strictly > 0
    SCALE_UP_TP_RATE:    0.15,   // TP hit rate ≥ 15 %
    SCALE_UP_STEP:       0.10,   // +10 % per confirmed window

    /* Scale-DOWN criteria (either triggers, checked on PRIMARY window) */
    SCALE_DOWN_EXPECTANCY: 0,    // expectancy < 0
    SCALE_DOWN_TP_RATE:    0.10, // TP hit rate < 10 %
    SCALE_DOWN_STEP:       0.15, // −15 % per deteriorated window (faster retreat)

    /* Hard limits on the multiplier */
    MULT_MAX:  3.00,
    MULT_MIN:  0.25,
    MULT_INIT: 1.00,

    /* Portfolio-level IC exposure cap */
    MAX_IC_EXPOSURE_PCT: 0.15,   // max 15 % of virtual_balance in open IC positions

    /* Per-asset bonus — applied only when that asset has independently
       demonstrated positive expectancy (≥ ASSET_MIN_TRADES) */
    ASSET_BONUS: {
      'TSLA': 1.50,   // audit: +$9.17 expectancy, 3/3 wins hit TP
      'VXX':  1.20,   // audit: +$1.98 expectancy, 27:1 R:R
    },
    ASSET_MIN_TRADES: 3,

    /* Periodic safety-net recalc interval */
    RECALC_INTERVAL_MS: 5 * 60 * 1000,   // 5 min

    /* localStorage keys */
    TRADES_KEY: 'geodash_ee_trades_v1',
    MULT_KEY:   'ic_risk_mult',
  };

  /* ── STATE ──────────────────────────────────────────────────────────────── */
  var _mult       = CFG.MULT_INIT;
  var _metrics    = {
    primary:    null,
    secondary:  null,
    byAsset:    {},
    drawdown:   0,
    tradeCount: 0,
    lastCalc:   0,
  };
  var _scalingLog = [];   // capped at 200 entries

  /* ── HELPERS ─────────────────────────────────────────────────────────────── */
  function _loadICTrades() {
    try {
      var raw = localStorage.getItem(CFG.TRADES_KEY);
      if (!raw) return [];
      var all = JSON.parse(raw);
      return (all || []).filter(function (t) {
        return (t.source === 'ic') && (t.status === 'CLOSED');
      });
    } catch (e) {
      return [];
    }
  }

  function _computeMetrics(trades) {
    var empty = {
      count: 0, wr: 0, avgWin: 0, avgLoss: 0,
      expectancy: 0, tpHitRate: 0, totalPnL: 0, rotations: 0,
    };
    if (!trades || !trades.length) return empty;

    var wins = [], losses = [], tpHits = 0, rotations = 0;
    trades.forEach(function (t) {
      var pnl = parseFloat(t.pnl_usd || 0);
      if (pnl > 0) {
        wins.push(pnl);
        if ((t.close_reason || '').indexOf('TAKE_PROFIT') !== -1) tpHits++;
      } else {
        losses.push(pnl);
      }
      if ((t.close_reason || '').toLowerCase().indexOf('rotat') !== -1) rotations++;
    });

    var n      = trades.length;
    var wr     = wins.length / n;
    var sumW   = wins.reduce(function (a, b)   { return a + b; }, 0);
    var sumL   = losses.reduce(function (a, b) { return a + b; }, 0);
    var avgWin = wins.length   ? sumW / wins.length   : 0;
    var avgLoss = losses.length ? sumL / losses.length : 0;

    return {
      count:      n,
      wr:         wr,
      avgWin:     avgWin,
      avgLoss:    avgLoss,
      expectancy: (wr * avgWin) + ((1 - wr) * avgLoss),
      tpHitRate:  tpHits / n,
      totalPnL:   sumW + sumL,
      rotations:  rotations,
    };
  }

  function _computeByAsset(trades) {
    var byAsset = {};
    trades.forEach(function (t) {
      var a = t.asset || 'UNKNOWN';
      if (!byAsset[a]) byAsset[a] = [];
      byAsset[a].push(t);
    });
    var result = {};
    Object.keys(byAsset).forEach(function (a) {
      result[a] = _computeMetrics(byAsset[a]);
    });
    return result;
  }

  function _computeDrawdown(trades) {
    var peak = 0, maxDD = 0, running = 0;
    trades.forEach(function (t) {
      running += parseFloat(t.pnl_usd || 0);
      if (running > peak) peak = running;
      var dd = peak - running;
      if (dd > maxDD) maxDD = dd;
    });
    return maxDD;
  }

  /* ── SCALING LOGIC ──────────────────────────────────────────────────────── */
  function _applyScalingRules(primary) {
    var oldMult = _mult;
    var reason;

    if (primary.count < CFG.WINDOW_MIN) {
      reason = 'HOLD (insufficient data: ' + primary.count + '/' + CFG.WINDOW_MIN + ' min)';
      _appendLog(oldMult, _mult, reason, primary);
      return;
    }

    var edgeUp   = primary.expectancy > CFG.SCALE_UP_EXPECTANCY && primary.tpHitRate >= CFG.SCALE_UP_TP_RATE;
    var edgeDown = primary.expectancy < CFG.SCALE_DOWN_EXPECTANCY || primary.tpHitRate < CFG.SCALE_DOWN_TP_RATE;

    if (edgeUp) {
      _mult  = Math.min(CFG.MULT_MAX, _mult + CFG.SCALE_UP_STEP);
      reason = 'SCALE UP  (E=' + primary.expectancy.toFixed(2) + ', TP=' + (primary.tpHitRate * 100).toFixed(1) + '%)';
    } else if (edgeDown) {
      _mult  = Math.max(CFG.MULT_MIN, _mult - CFG.SCALE_DOWN_STEP);
      reason = 'SCALE DOWN (E=' + primary.expectancy.toFixed(2) + ', TP=' + (primary.tpHitRate * 100).toFixed(1) + '%)';
    } else {
      reason = 'HOLD (E=' + primary.expectancy.toFixed(2) + ', TP=' + (primary.tpHitRate * 100).toFixed(1) + '% — borderline)';
    }

    _appendLog(oldMult, _mult, reason, primary);

    if (oldMult !== _mult) {
      var msg = '[IC-RISK] ' + reason + ' → mult: ' + oldMult.toFixed(2) + 'x → ' + _mult.toFixed(2) + 'x';
      console.log(msg);
      if (window.GIILog) try { window.GIILog('IC-RISK', msg); } catch (e) {}
    }
  }

  function _appendLog(oldMult, newMult, reason, m) {
    _scalingLog.unshift({
      ts:      new Date().toISOString(),
      oldMult: +oldMult.toFixed(3),
      newMult: +newMult.toFixed(3),
      reason:  reason,
      snap: {
        count:      m.count,
        wr:         Math.round(m.wr * 1000) / 10,
        expectancy: Math.round(m.expectancy * 100) / 100,
        tpHitRate:  Math.round(m.tpHitRate  * 1000) / 10,
        avgWin:     Math.round(m.avgWin  * 100) / 100,
        avgLoss:    Math.round(m.avgLoss * 100) / 100,
        rotations:  m.rotations,
      },
    });
    if (_scalingLog.length > 200) _scalingLog.pop();

    /* Persist multiplier so a page reload resumes at current calibration */
    try { localStorage.setItem(CFG.MULT_KEY, JSON.stringify(_mult)); } catch (e) {}
  }

  /* ── RECALCULATE ─────────────────────────────────────────────────────────── */
  function recalculate() {
    var all        = _loadICTrades();
    var primary    = all.slice(-CFG.WINDOW_PRIMARY);
    var secondary  = all.slice(-CFG.WINDOW_SECONDARY);

    _metrics.primary    = _computeMetrics(primary);
    _metrics.secondary  = _computeMetrics(secondary);
    _metrics.byAsset    = _computeByAsset(secondary);
    _metrics.drawdown   = _computeDrawdown(all);
    _metrics.tradeCount = all.length;
    _metrics.lastCalc   = Date.now();

    _applyScalingRules(_metrics.primary);
  }

  /* ── PUBLIC API ──────────────────────────────────────────────────────────── */

  /**
   * getICRiskMultiplier(asset)
   * Returns the effective risk multiplier for an IC trade on `asset`.
   * Per-asset bonus applied only when that asset has proven independent edge.
   */
  function getICRiskMultiplier(asset) {
    var base  = _mult;
    var bonus = asset && CFG.ASSET_BONUS[asset];
    if (bonus) {
      var am = _metrics.byAsset && _metrics.byAsset[asset];
      if (am && am.count >= CFG.ASSET_MIN_TRADES && am.expectancy > 0) {
        base = Math.min(CFG.MULT_MAX, base * bonus);
      }
    }
    return +base.toFixed(4);
  }

  /**
   * isAtMaxICExposure(accountSize, openICExposureUSD)
   * True if total open IC position notional already ≥ 15 % of account.
   */
  function isAtMaxICExposure(accountSize, openICExposureUSD) {
    if (!accountSize || accountSize <= 0) return false;
    return (openICExposureUSD / accountSize) >= CFG.MAX_IC_EXPOSURE_PCT;
  }

  /**
   * onICTradeClosed()
   * Called by gii-exit.js immediately after any IC trade is force-closed.
   * Triggers a rolling-window recalc so the multiplier updates in near real-time.
   */
  function onICTradeClosed() {
    recalculate();
  }

  /**
   * getStatus()
   * Full human-readable snapshot for console inspection or a dashboard panel.
   *
   * Usage:  console.table(ICRiskEngine.getStatus())
   */
  function getStatus() {
    var p = _metrics.primary   || {};
    var s = _metrics.secondary || {};

    var fmt = function (v, prefix, dp) {
      return (v !== undefined && v !== null && isFinite(v))
        ? (prefix || '') + v.toFixed(dp !== undefined ? dp : 2)
        : '—';
    };
    var pct = function (v) { return isFinite(v) ? Math.round(v * 1000) / 10 + '%' : '—'; };

    return {
      /* ── Multiplier ─────────────────────────────────────── */
      multiplier:        +_mult.toFixed(3),
      multiplierDisplay: Math.round(_mult * 100) + '% of base risk',

      /* ── Config ─────────────────────────────────────────── */
      config: {
        maxICExposure:  (CFG.MAX_IC_EXPOSURE_PCT * 100) + '% of account',
        primaryWindow:  CFG.WINDOW_PRIMARY + ' trades',
        minWindow:      CFG.WINDOW_MIN    + ' trades',
        multRange:      CFG.MULT_MIN + 'x – ' + CFG.MULT_MAX + 'x',
        scaleUpAt:      'E>0 AND TP≥' + (CFG.SCALE_UP_TP_RATE   * 100) + '%  →+' + (CFG.SCALE_UP_STEP   * 100) + '%',
        scaleDownAt:    'E<0 OR  TP<' + (CFG.SCALE_DOWN_TP_RATE * 100) + '%  →−' + (CFG.SCALE_DOWN_STEP * 100) + '%',
        assetBonus:     CFG.ASSET_BONUS,
      },

      /* ── Primary window (last 20 IC trades) ─────────────── */
      primary: {
        trades:     p.count      || 0,
        winRate:    pct(p.wr),
        avgWin:     fmt(p.avgWin,  '$'),
        avgLoss:    fmt(p.avgLoss, '$'),
        expectancy: fmt(p.expectancy, '$'),
        tpHitRate:  pct(p.tpHitRate),
        totalPnL:   fmt(p.totalPnL, '$'),
        rotations:  p.rotations || 0,
      },

      /* ── Secondary window (last 60 IC trades) ────────────── */
      secondary: {
        trades:     s.count      || 0,
        winRate:    pct(s.wr),
        expectancy: fmt(s.expectancy, '$'),
        tpHitRate:  pct(s.tpHitRate),
        totalPnL:   fmt(s.totalPnL, '$'),
      },

      /* ── Per-asset breakdown ─────────────────────────────── */
      byAsset: (function () {
        var out = {};
        Object.keys(_metrics.byAsset || {}).forEach(function (a) {
          var m = _metrics.byAsset[a];
          out[a] = {
            trades:     m.count,
            wr:         pct(m.wr),
            expectancy: fmt(m.expectancy, '$'),
            tpHitRate:  pct(m.tpHitRate),
            bonus:      CFG.ASSET_BONUS[a]
              ? (m.count >= CFG.ASSET_MIN_TRADES && m.expectancy > 0
                ? CFG.ASSET_BONUS[a] + 'x ACTIVE'
                : CFG.ASSET_BONUS[a] + 'x (awaiting ' + CFG.ASSET_MIN_TRADES + ' trades w/ E>0)')
              : 'none',
          };
        });
        return out;
      })(),

      /* ── Portfolio-level ─────────────────────────────────── */
      icDrawdown: fmt(_metrics.drawdown, '$'),
      totalICTrades: _metrics.tradeCount,
      lastCalc: _metrics.lastCalc ? new Date(_metrics.lastCalc).toISOString() : 'never',

      /* ── Recent scaling decisions ────────────────────────── */
      recentLog: _scalingLog.slice(0, 10),
    };
  }

  /* ── INIT ───────────────────────────────────────────────────────────────── */
  function init() {
    /* Restore persisted multiplier from previous session */
    try {
      var saved = localStorage.getItem(CFG.MULT_KEY);
      if (saved !== null) {
        var v = parseFloat(saved);
        if (isFinite(v) && v >= CFG.MULT_MIN && v <= CFG.MULT_MAX) {
          _mult = v;
          console.log('[IC-RISK-ENGINE] Restored multiplier: ' + _mult.toFixed(2) + 'x');
        }
      }
    } catch (e) {}

    recalculate();
    setInterval(recalculate, CFG.RECALC_INTERVAL_MS);

    console.log(
      '[IC-RISK-ENGINE] v1 ready | mult=' + _mult.toFixed(2) + 'x' +
      ' | IC trades=' + _metrics.tradeCount +
      ' | primary E=' + ((_metrics.primary && _metrics.primary.expectancy) || 0).toFixed(2)
    );
  }

  /* ── EXPORT ─────────────────────────────────────────────────────────────── */
  window.ICRiskEngine = {
    VERSION:             1,
    init:                init,
    recalculate:         recalculate,
    getICRiskMultiplier: getICRiskMultiplier,
    isAtMaxICExposure:   isAtMaxICExposure,
    onICTradeClosed:     onICTradeClosed,
    getStatus:           getStatus,
    _cfg:                CFG,   /* live-tune: ICRiskEngine._cfg.MULT_MAX = 4.0 */
    _log:                _scalingLog,
  };

})(window);
