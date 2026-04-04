/**
 * Execution Quality Agent
 *
 * Tracks slippage, fill rates, fill times, and venue performance across
 * all trades. Over time, learns which venues perform better for which
 * assets and conditions, and provides sizing/routing hints to the
 * execution engine.
 *
 * Reads: EE trade history (closed + open trades)
 * Exposes: window.GII_EXEC_QUALITY
 *
 * Public API:
 *   GII_EXEC_QUALITY.status()                → overall stats
 *   GII_EXEC_QUALITY.venueStats(venue)       → per-venue performance
 *   GII_EXEC_QUALITY.assetStats(asset)       → per-asset execution quality
 *   GII_EXEC_QUALITY.recommend(asset, venue) → { preferredVenue, reason }
 *   GII_EXEC_QUALITY.record(trade)           → record a completed trade
 */
(function () {
  'use strict';

  var MAX_RECORDS = 500;  // rolling window of recent trades

  /* ── State ──────────────────────────────────────────────────────────────── */
  var _records = [];  // [{ asset, venue, slippagePct, fillTimeMs, filled, ts, pnl }]
  var _venueCache  = {};  // venue → computed stats
  var _assetCache  = {};  // asset → computed stats
  var _dirty = true;

  /* ── Record a trade execution ──────────────────────────────────────────── */
  function record(trade) {
    if (!trade || !trade.asset) return;

    var entry = {
      asset:        trade.asset,
      venue:        (trade.venue || trade.broker || 'unknown').toUpperCase(),
      slippagePct:  _calcSlippage(trade),
      fillTimeMs:   _calcFillTime(trade),
      filled:       trade.status !== 'REJECTED' && trade.status !== 'FAILED',
      rejected:     trade.status === 'REJECTED',
      ts:           trade.closeTs || trade.openTs || Date.now(),
      pnl:          trade.pnl_usd || trade.pnl || 0,
      dir:          trade.dir || 'LONG',
      size:         trade.riskAmt || trade.size || 0
    };

    _records.push(entry);
    if (_records.length > MAX_RECORDS) _records.shift();
    _dirty = true;
  }

  function _calcSlippage(trade) {
    // Slippage = difference between intended entry price and actual fill price
    var intended = trade.entryTarget || trade.signalPrice || 0;
    var actual   = trade.entryPrice || trade.fillPrice || trade.entry || 0;
    if (!intended || !actual || intended === 0) return 0;
    // Positive = unfavourable slippage (paid more for longs, received less for shorts)
    var dir = (trade.dir || 'LONG').toUpperCase();
    if (dir === 'LONG') {
      return +((actual - intended) / intended * 100).toFixed(4);
    } else {
      return +((intended - actual) / intended * 100).toFixed(4);
    }
  }

  function _calcFillTime(trade) {
    var signalTs = trade.signalTs || trade.ts || 0;
    var fillTs   = trade.fillTs || trade.openTs || 0;
    if (!signalTs || !fillTs) return 0;
    return Math.max(0, fillTs - signalTs);
  }

  /* ── Rebuild caches ────────────────────────────────────────────────────── */
  function _rebuild() {
    if (!_dirty) return;
    _venueCache = {};
    _assetCache = {};

    _records.forEach(function (r) {
      // Venue stats
      if (!_venueCache[r.venue]) _venueCache[r.venue] = _emptyBucket();
      _addToBucket(_venueCache[r.venue], r);

      // Asset stats
      if (!_assetCache[r.asset]) _assetCache[r.asset] = _emptyBucket();
      _addToBucket(_assetCache[r.asset], r);
    });

    // Compute averages
    Object.keys(_venueCache).forEach(function (k) { _finaliseBucket(_venueCache[k]); });
    Object.keys(_assetCache).forEach(function (k) { _finaliseBucket(_assetCache[k]); });

    _dirty = false;
  }

  function _emptyBucket() {
    return {
      total: 0, filled: 0, rejected: 0,
      slippageSum: 0, fillTimeSum: 0, filledCount: 0,
      pnlSum: 0, winCount: 0,
      // computed
      fillRate: 0, avgSlippage: 0, avgFillTimeMs: 0,
      winRate: 0, avgPnl: 0
    };
  }

  function _addToBucket(bucket, r) {
    bucket.total++;
    if (r.filled) {
      bucket.filled++;
      bucket.filledCount++;
      bucket.slippageSum += r.slippagePct;
      bucket.fillTimeSum += r.fillTimeMs;
      bucket.pnlSum += r.pnl;
      if (r.pnl > 0) bucket.winCount++;
    }
    if (r.rejected) bucket.rejected++;
  }

  function _finaliseBucket(b) {
    b.fillRate      = b.total > 0 ? +(b.filled / b.total * 100).toFixed(1) : 0;
    b.avgSlippage   = b.filledCount > 0 ? +(b.slippageSum / b.filledCount).toFixed(4) : 0;
    b.avgFillTimeMs = b.filledCount > 0 ? Math.round(b.fillTimeSum / b.filledCount) : 0;
    b.winRate       = b.filledCount > 0 ? +(b.winCount / b.filledCount * 100).toFixed(1) : 0;
    b.avgPnl        = b.filledCount > 0 ? +(b.pnlSum / b.filledCount).toFixed(2) : 0;
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */

  function status() {
    _rebuild();
    return {
      totalRecords: _records.length,
      venues:       Object.keys(_venueCache).map(function (v) {
        return { venue: v, stats: _venueCache[v] };
      }),
      assets:       Object.keys(_assetCache).length,
      alerts:       _getAlerts()
    };
  }

  function venueStats(venue) {
    _rebuild();
    var v = (venue || '').toUpperCase();
    return _venueCache[v] || null;
  }

  function assetStats(asset) {
    _rebuild();
    return _assetCache[asset] || null;
  }

  function recommend(asset, currentVenue) {
    _rebuild();
    var venues = Object.keys(_venueCache);
    if (venues.length < 2) return { preferredVenue: currentVenue, reason: 'insufficient data' };

    // Find venue with best fill rate + lowest slippage for this asset
    var assetRecords = _records.filter(function (r) { return r.asset === asset; });
    if (assetRecords.length < 5) return { preferredVenue: currentVenue, reason: 'insufficient asset data' };

    // Group by venue for this asset
    var venuePerf = {};
    assetRecords.forEach(function (r) {
      if (!venuePerf[r.venue]) venuePerf[r.venue] = { fills: 0, total: 0, slipSum: 0 };
      venuePerf[r.venue].total++;
      if (r.filled) {
        venuePerf[r.venue].fills++;
        venuePerf[r.venue].slipSum += r.slippagePct;
      }
    });

    var best = currentVenue;
    var bestScore = -Infinity;
    Object.keys(venuePerf).forEach(function (v) {
      var p = venuePerf[v];
      if (p.total < 3) return;  // need minimum sample
      var fillRate = p.fills / p.total;
      var avgSlip  = p.fills > 0 ? p.slipSum / p.fills : 0;
      // Score: fill rate matters most, slippage is secondary penalty
      var score = fillRate * 100 - Math.abs(avgSlip) * 10;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    });

    if (best !== currentVenue) {
      return {
        preferredVenue: best,
        reason: best + ' has better fill rate / lower slippage for ' + asset
      };
    }
    return { preferredVenue: currentVenue, reason: 'current venue is optimal' };
  }

  function _getAlerts() {
    var alerts = [];
    Object.keys(_venueCache).forEach(function (v) {
      var s = _venueCache[v];
      if (s.total >= 10 && s.fillRate < 70) {
        alerts.push({ venue: v, type: 'LOW_FILL_RATE', detail: 'fill rate ' + s.fillRate + '% over ' + s.total + ' trades' });
      }
      if (s.filledCount >= 10 && Math.abs(s.avgSlippage) > 0.5) {
        alerts.push({ venue: v, type: 'HIGH_SLIPPAGE', detail: 'avg slippage ' + s.avgSlippage + '% over ' + s.filledCount + ' fills' });
      }
    });
    return alerts;
  }

  /* ── Auto-ingest from EE on load ───────────────────────────────────────── */
  var _initialized = false;
  window.addEventListener('load', function () {
    if (_initialized) return;
    _initialized = true;

    // Ingest historical trades from EE if available
    setTimeout(function () {
      if (window.EE && typeof EE.closedTrades === 'function') {
        try {
          var closed = EE.closedTrades();
          if (Array.isArray(closed)) {
            closed.forEach(function (t) { record(t); });
            console.log('[EXEC-QUALITY] Ingested ' + closed.length + ' historical trades');
          }
        } catch (e) {
          console.warn('[EXEC-QUALITY] Could not ingest history: ' + (e.message || e));
        }
      }
    }, 15000);  // wait for EE to load
  });

  window.GII_EXEC_QUALITY = {
    status:    status,
    venueStats: venueStats,
    assetStats: assetStats,
    recommend: recommend,
    record:    record
  };

  console.log('[EXEC-QUALITY] Execution Quality agent loaded');
})();
