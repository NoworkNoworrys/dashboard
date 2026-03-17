/* ══════════════════════════════════════════════════════════════════════════════
   GII-ROUTING — Instrument Router & Leverage Optimiser
   ══════════════════════════════════════════════════════════════════════════════
   Called by EE.onSignals() before every signal is processed. For each signal it:

   1. ROUTE: checks if the asset has a better HL perpetual equivalent.
      e.g.  GLD (SPDR ETF, Yahoo price, no leverage)
            → XAU (HL GOLD perp, real-time price, lower fees)

   2. LEVERAGE: if routing to HL, calculates whether tightening the stop to
      achieve N× leverage improves capital efficiency for this signal's
      confidence level and estimated hold duration.

   Leverage mechanics:
     The EE sizes positions by risk (riskAmt / slDist = units). Halving the
     stop distance doubles units for the same dollar risk — this IS leverage:
     same $ at risk, 2× notional, 2× profit if right, same loss if wrong.
     Fee cost scales with notional, so over-leveraging at low confidence is
     detrimental. The agent picks the leverage where net EV is maximised.

   Key trade-off:
     Higher leverage → more units → more $ profit if win (same $ loss if stopped)
     Higher leverage → more notional → more fees + more funding drag
     Minimum viable stop (by sector) prevents noise-induced stopouts

   EV formula (per unit of risked capital):
     net_EV = W×(R×SL_pct) − (1−W)×SL_pct − roundTripFees − fundingCost
     Where: W = win probability ≈ conf/100, R = TP ratio, SL_pct = stop %

   Public API: window.GII_ROUTING
     .route(signal)   → modified signal (or original if no improvement found)
     .preview(asset, conf, stopPct, tpRatio) → dry-run without modifying anything
     .decisions()     → last 50 routing decisions with full EV tables
     .status()        → summary stats
   ══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Instrument map: traditional asset → HL perp equivalent ────────────────
     Only included when HL is strictly better (real-time price + lower fees).
     Assets already on HL (WTI, BRENT, BTC, ETH, SOL, most equities) are
     included so the routing agent documents the decision even when no remap
     is needed.
     GLD → XAU: the key remap. GLD is the SPDR ETF (~$275). HL trades spot
     GOLD (~$3000). We remap to XAU (EE name for HL's GOLD ticker) so the
     EE opens the trade at the correct spot price via HL.                    */
  var INSTRUMENT_MAP = {
    /* Precious metals — key remaps */
    'GLD':    { hlAsset: 'XAU',    sector: 'precious', maxLev: 5 },
    'SLV':    { hlAsset: 'SILVER', sector: 'precious', maxLev: 5 },
    /* Already on HL — remap only improves prices/fees */
    'XAU':    { hlAsset: 'XAU',    sector: 'precious', maxLev: 5 },
    'GOLD':   { hlAsset: 'GOLD',   sector: 'precious', maxLev: 5 },
    'SILVER': { hlAsset: 'SILVER', sector: 'precious', maxLev: 5 },
    /* Energy */
    'WTI':    { hlAsset: 'WTI',    sector: 'energy',   maxLev: 5 },
    'BRENT':  { hlAsset: 'BRENT',  sector: 'energy',   maxLev: 5 },
    /* Crypto */
    'BTC':    { hlAsset: 'BTC',    sector: 'crypto',   maxLev: 3 },
    'ETH':    { hlAsset: 'ETH',    sector: 'crypto',   maxLev: 3 },
    'SOL':    { hlAsset: 'SOL',    sector: 'crypto',   maxLev: 2 },
    /* US equities with HL perps */
    'SPY':    { hlAsset: 'SPY',    sector: 'equity',   maxLev: 3 },
    'QQQ':    { hlAsset: 'QQQ',    sector: 'equity',   maxLev: 3 },
    'NVDA':   { hlAsset: 'NVDA',   sector: 'equity',   maxLev: 3 },
    'TSM':    { hlAsset: 'TSM',    sector: 'equity',   maxLev: 3 },
    'AAPL':   { hlAsset: 'AAPL',   sector: 'equity',   maxLev: 2 },
    'TSLA':   { hlAsset: 'TSLA',   sector: 'equity',   maxLev: 2 },
    'LMT':    { hlAsset: 'LMT',    sector: 'equity',   maxLev: 3 },
    'RTX':    { hlAsset: 'RTX',    sector: 'equity',   maxLev: 3 },
    'NOC':    { hlAsset: 'NOC',    sector: 'equity',   maxLev: 3 },
    'XLE':    { hlAsset: 'XLE',    sector: 'equity',   maxLev: 3 },
    'GDX':    { hlAsset: 'GDX',    sector: 'equity',   maxLev: 2 },
    'SMH':    { hlAsset: 'SMH',    sector: 'equity',   maxLev: 3 },
    'FXI':    { hlAsset: 'FXI',    sector: 'equity',   maxLev: 2 },
    'XOM':    { hlAsset: 'XOM',    sector: 'equity',   maxLev: 2 }
  };

  /* ── Fee structures for EV comparison ──────────────────────────────────────
     HL costs: 0.05% taker (market/SL), 0.02% maker (limit/TP). We model
     commission as the taker rate (conservative; most entries/exits are market).
     Traditional costs: per-sector CFD/stock estimates.                       */
  var HL_COSTS = {
    precious: { commission: 0.0005, spread: 0.0002, funding8h: 0.00005 },
    energy:   { commission: 0.0005, spread: 0.0003, funding8h: 0.00005 },
    crypto:   { commission: 0.0005, spread: 0.0002, funding8h: 0.0001  },
    equity:   { commission: 0.0005, spread: 0.0002, funding8h: 0       }
  };

  var TRAD_COSTS = {
    precious: { commission: 0.0007, spread: 0.0002, funding8h: 0       },
    energy:   { commission: 0.0007, spread: 0.0004, funding8h: 0       },
    crypto:   { commission: 0.0010, spread: 0.0008, funding8h: 0.0001  },
    equity:   { commission: 0.0005, spread: 0.0001, funding8h: 0       }
  };

  /* ── Minimum viable stop % by sector ───────────────────────────────────────
     Stops tighter than this will be hit by normal intraday noise, not signal.
     Based on typical 1-day ATR as a fraction of price.                       */
  var MIN_SL_PCT = {
    precious: 0.50,   // gold: typical daily range 0.5–1%
    energy:   0.80,   // oil: can swing 1–2% intraday
    crypto:   2.00,   // BTC/ETH: 2–5% intraday swings normal
    equity:   0.40    // large-cap stocks: tighter spreads
  };

  /* ── Max leverage by confidence band ───────────────────────────────────────
     Conservative caps — real HL allows up to 50× for crypto but that's
     reckless for a news-driven signal bot.                                   */
  var MAX_LEV_BY_CONF = [
    { minConf: 80, maxLev: 3 },
    { minConf: 70, maxLev: 2 },
    { minConf:  0, maxLev: 1 }   // below 70% confidence: never leverage
  ];

  /* ── State ─────────────────────────────────────────────────────────────── */
  var _decisions = [];
  var _stats = { total: 0, hlRouted: 0, leveraged: 0, remapped: 0 };

  /* ════════════════════════════════════════════════════════════════════════════
     HELPERS
     ════════════════════════════════════════════════════════════════════════════ */

  /* Normalise asset ticker (matches EE's normaliseAsset) */
  function _norm(asset) {
    return String(asset || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ').trim().split(' ')[0];
  }

  /* Estimate hold duration (hours) from signal characteristics */
  function _estimateHoldHours(sig) {
    var conf = sig.conf || 50;
    // High confidence → sharp move expected soon → shorter hold
    // Lower confidence → needs more time to play out
    if (conf >= 80) return 4;
    if (conf >= 70) return 8;
    if (conf >= 55) return 16;
    return 24;
  }

  /* Net EV as a fraction of entry price
     slPct:      stop distance as decimal (e.g. 0.02 for 2%)
     tpRatio:    reward:risk ratio (e.g. 2.0)
     costs:      { commission, spread, funding8h }
     holdHours:  estimated position hold duration                             */
  function _calcEV(winProb, tpRatio, slPct, costs, holdHours) {
    var W          = winProb;
    var tpPct      = slPct * tpRatio;
    var roundTrip  = costs.commission * 2 + costs.spread * 2;
    var funding    = Math.ceil(holdHours / 8) * costs.funding8h;
    return W * tpPct - (1 - W) * slPct - roundTrip - funding;
  }

  /* Find the maximum leverage that keeps the adjusted stop above MIN_SL_PCT,
     capped by sector's maxLev and the confidence band cap.                  */
  function _maxViableLeverage(sector, baseSLPct, conf, mapEntry) {
    var minStop      = MIN_SL_PCT[sector]  || 0.5;
    var maxByNoise   = Math.max(1, Math.floor(baseSLPct / minStop));
    var maxBySector  = mapEntry.maxLev     || 2;
    var maxByConf    = 1;
    for (var i = 0; i < MAX_LEV_BY_CONF.length; i++) {
      if (conf >= MAX_LEV_BY_CONF[i].minConf) {
        maxByConf = MAX_LEV_BY_CONF[i].maxLev;
        break;
      }
    }
    return Math.min(maxByNoise, maxBySector, maxByConf);
  }

  /* Build EV comparison table for HL at each leverage level */
  function _buildEvTable(conf, tpRatio, baseSLPct, sector, maxLev, holdHours) {
    var W        = conf / 100;
    var hlCosts  = HL_COSTS[sector]   || HL_COSTS.equity;
    var tradCosts= TRAD_COSTS[sector] || TRAD_COSTS.equity;
    var minStop  = MIN_SL_PCT[sector] || 0.5;
    var rows     = [];

    /* Traditional route (1×, non-HL) */
    var tradEV = _calcEV(W, tpRatio, baseSLPct / 100, tradCosts, holdHours);
    rows.push({
      route:   'TRAD 1×',
      lev:     1,
      slPct:   baseSLPct,
      netEV:   +(tradEV * 100).toFixed(4),
      note:    'Yahoo/backend price, CFD fees'
    });

    /* HL at each leverage level */
    [1, 2, 3, 5].forEach(function (lev) {
      if (lev > maxLev) return;
      var adjSLPct = baseSLPct / lev;
      if (adjSLPct < minStop) {
        rows.push({ route: 'HL ' + lev + '×', lev: lev, slPct: +adjSLPct.toFixed(2), netEV: null, note: 'stop < ' + minStop + '% min — too tight' });
        return;
      }
      var ev = _calcEV(W, tpRatio, adjSLPct / 100, hlCosts, holdHours);
      /* Absolute dollar EV is the same regardless of leverage (risk-based sizing).
         We compare net EV percentage per unit stop to pick the most fee-efficient. */
      rows.push({
        route:  'HL ' + lev + '×',
        lev:    lev,
        slPct:  +adjSLPct.toFixed(2),
        netEV:  +(ev * 100).toFixed(4),
        note:   lev > 1 ? 'tighter stop, ' + lev + '× notional' : 'HL fees only'
      });
    });

    return rows;
  }

  /* ════════════════════════════════════════════════════════════════════════════
     CORE ROUTING LOGIC
     ════════════════════════════════════════════════════════════════════════════ */

  function route(sig) {
    if (!sig || !sig.asset) return sig;

    var asset    = _norm(sig.asset);
    var mapEntry = INSTRUMENT_MAP[asset];

    /* Not a remappable/HL asset — pass through unchanged */
    if (!mapEntry) return sig;

    _stats.total++;

    var hlAsset   = mapEntry.hlAsset;
    var sector    = mapEntry.sector;
    var conf      = sig.conf   || 50;
    var tpRatio   = sig.tpRatio  || 2.0;
    var baseSLPct = sig.stopPct  || 2.0;   // % (e.g. 2.0 = 2%)
    var holdHours = _estimateHoldHours(sig);

    /* ── HL availability check ─────────────────────────────────────────────── */
    var hlAvailable = window.HLFeed &&
                      typeof HLFeed.covers === 'function' &&
                      HLFeed.covers(hlAsset);

    /* ── EV table ──────────────────────────────────────────────────────────── */
    var maxLev  = _maxViableLeverage(sector, baseSLPct, conf, mapEntry);
    var evTable = _buildEvTable(conf, tpRatio, baseSLPct, sector, maxLev, holdHours);

    /* ── Pick best HL row ──────────────────────────────────────────────────── */
    var bestHLRow = null;
    evTable.forEach(function (row) {
      if (row.route === 'TRAD 1×') return;
      if (row.netEV === null)      return;   // too tight
      if (!bestHLRow || row.netEV > bestHLRow.netEV) bestHLRow = row;
    });

    var tradRow = evTable[0];

    /* ── Decision ──────────────────────────────────────────────────────────── */
    var useHL      = hlAvailable && bestHLRow !== null;
    var remapAsset = useHL && (hlAsset !== asset);   // GLD→XAU is a remap; WTI→WTI is not
    var finalLev   = useHL ? bestHLRow.lev : 1;
    var finalSLPct = useHL ? bestHLRow.slPct : baseSLPct;

    var decision = {
      ts:          Date.now(),
      original:    asset,
      routed_to:   useHL ? hlAsset : asset,
      leverage:    finalLev,
      hl_used:     useHL,
      asset_remap: remapAsset,
      hold_est_h:  holdHours,
      trad_ev:     tradRow  ? tradRow.netEV  : null,
      hl_best_ev:  bestHLRow ? bestHLRow.netEV : null,
      final_sl_pct: finalSLPct,
      ev_table:    evTable
    };
    _decisions.unshift(decision);
    if (_decisions.length > 50) _decisions.pop();
    if (useHL)      _stats.hlRouted++;
    if (finalLev > 1) _stats.leveraged++;
    if (remapAsset)   _stats.remapped++;

    /* ── If no improvement, return original ────────────────────────────────── */
    if (!useHL) return sig;

    /* ── Build routing note for EE activity log ─────────────────────────────── */
    var parts = [];
    if (remapAsset) parts.push(asset + '→' + hlAsset + ' (HL perp, real-time price)');
    if (finalLev > 1) parts.push(finalLev + '× lev (SL ' + baseSLPct + '%→' + finalSLPct + '%)');
    parts.push('EV: TRAD ' + (tradRow ? tradRow.netEV + '%' : 'n/a') +
               ' vs HL ' + (bestHLRow ? bestHLRow.netEV + '%' : 'n/a'));
    parts.push('hold~' + holdHours + 'h');
    var routingNote = 'GII-ROUTING: ' + parts.join(' | ');

    /* ── Return modified signal ─────────────────────────────────────────────── */
    var routed = Object.assign({}, sig);

    /* Remap asset name (e.g. GLD → XAU) — preserve original in metadata */
    if (remapAsset) {
      routed.asset        = hlAsset;
      routed.original_asset = sig.asset;   // keep for display
    }

    /* Apply tighter stop if leveraged */
    if (finalLev > 1) {
      routed.stopPct  = finalSLPct;
      routed.leverage = finalLev;
    }

    /* Append routing note to signal reason */
    routed.reason = (sig.reason ? sig.reason + ' | ' : '') + routingNote;

    return routed;
  }

  /* ════════════════════════════════════════════════════════════════════════════
     PUBLIC API
     ════════════════════════════════════════════════════════════════════════════ */
  window.GII_ROUTING = {

    route: route,

    /* Dry-run: see what the router would do for a hypothetical signal */
    preview: function (asset, conf, stopPct, tpRatio) {
      var fakeSig = { asset: asset, conf: conf || 70, stopPct: stopPct || 2.0, tpRatio: tpRatio || 2.0 };
      var result  = route(fakeSig);
      /* Pop the decision off the history (this is just a preview) */
      _decisions.shift();
      _stats.total--;
      if (result.asset !== fakeSig.asset) { _stats.remapped--; _stats.hlRouted--; }
      if (result.leverage > 1) _stats.leveraged--;
      return result;
    },

    /* Last N routing decisions — each includes full EV table */
    decisions: function () { return _decisions.slice(); },

    status: function () {
      return {
        totalDecisions:  _stats.total,
        hlRouted:        _stats.hlRouted,
        leveraged:       _stats.leveraged,
        remapped:        _stats.remapped,
        hlAvailable:     !!(window.HLFeed && HLFeed.status && HLFeed.status().connected),
        lastDecision:    _decisions[0] || null
      };
    }
  };

  if (typeof console !== 'undefined') {
    console.log('[GII-ROUTING] Loaded — ' + Object.keys(INSTRUMENT_MAP).length +
                ' instruments mapped. GII_ROUTING.preview("GLD", 75) to test.');
  }

}());
