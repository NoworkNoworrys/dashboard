/* ═══════════════════════════════════════════════════════════════════════════
   SENTIMENT VELOCITY TRACKER v1
   ═══════════════════════════════════════════════════════════════════════════
   Measures how fast news is accumulating on a topic/region.
   A story that generates 8 articles in 30 minutes is far more significant
   than 8 articles spread over 24 hours.

   How it works:
   - Every ingest() call hits SentimentVelocity.record(region)
   - Maintains a sliding 24h timestamp log per region (max 200 entries each)
   - Current rate  = events in the last 60 minutes
   - Baseline rate = average events/hour over the prior 23 hours
   - Acceleration  = current_rate / max(baseline_rate, 0.5)
   - Score 0-1:  acceleration 1.5× → 0.2 … 10× → 1.0

   The score is written to evt.socialV (clamped to existing value if higher),
   so S4 in scoreEvent() naturally rewards rapidly-building stories.

   Also fires a 'velocity-spike' CustomEvent when a region hits 3× baseline,
   letting the EE / MacroRegime layer react in near-real-time.

   Exposed as window.SentimentVelocity
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var WINDOW_MS      = 60 * 60 * 1000;    // 1-hour current window
  var BASELINE_MS    = 24 * 60 * 60 * 1000; // 24h for baseline
  var MAX_ENTRIES    = 400;               // max timestamps per region
  var PRUNE_INTERVAL = 10 * 60 * 1000;   // prune old entries every 10 min

  /* ── State ───────────────────────────────────────────────────────────── */
  var _log = {};          // region → [ts, ts, ...]
  var _spikeLog = [];     // last 20 velocity spikes for dashboard

  /* ── Record an ingested event ─────────────────────────────────────────── */
  function record(region) {
    var r = region || 'GLOBAL';
    if (!_log[r]) _log[r] = [];
    _log[r].push(Date.now());
    if (_log[r].length > MAX_ENTRIES) _log[r].shift();
  }

  /* ── Compute velocity score (0-1) for a region ────────────────────────── */
  function score(region) {
    var r   = region || 'GLOBAL';
    var now = Date.now();
    var ts  = _log[r] || [];
    if (ts.length < 2) return 0;

    /* Current rate: events in the last hour */
    var cutCurrent   = now - WINDOW_MS;
    var currentCount = ts.filter(function (t) { return t >= cutCurrent; }).length;

    /* Baseline rate: events per hour averaged over the 23 hours BEFORE the last hour */
    var cutBaseline  = now - BASELINE_MS;
    var baselineEvents = ts.filter(function (t) { return t >= cutBaseline && t < cutCurrent; }).length;
    var baselineRate   = baselineEvents / 23;  // events per hour across 23 prior hours

    /* Floor baseline at 0.5 events/hour so cold-start doesn't over-fire */
    var effectiveBaseline = Math.max(baselineRate, 0.5);
    var acceleration      = currentCount / effectiveBaseline;

    /* Map acceleration → 0-1 score */
    var s;
    if      (acceleration >= 10) s = 1.0;
    else if (acceleration >=  7) s = 0.9;
    else if (acceleration >=  5) s = 0.8;
    else if (acceleration >=  3) s = 0.6;
    else if (acceleration >=  2) s = 0.4;
    else if (acceleration >= 1.5) s = 0.2;
    else                          s = 0.0;

    return s;
  }

  /* ── Compute full stats for a region (for display / console) ─────────── */
  function stats(region) {
    var r   = region || 'GLOBAL';
    var now = Date.now();
    var ts  = _log[r] || [];

    var cutCurrent = now - WINDOW_MS;
    var cutBaseline = now - BASELINE_MS;
    var currentCount   = ts.filter(function (t) { return t >= cutCurrent; }).length;
    var baselineEvents = ts.filter(function (t) { return t >= cutBaseline && t < cutCurrent; }).length;
    var baselineRate   = baselineEvents / 23;
    var accel          = currentCount / Math.max(baselineRate, 0.5);

    return {
      region:        r,
      currentRate:   currentCount,          // events in last 1h
      baselineRate:  +baselineRate.toFixed(2), // avg events/hr (prior 23h)
      acceleration:  +accel.toFixed(2),
      score:         score(r),
      totalTracked:  ts.length
    };
  }

  /* ── Check all regions and fire events for spikes ────────────────────── */
  function _checkSpikes() {
    Object.keys(_log).forEach(function (r) {
      var st = stats(r);
      if (st.acceleration >= 3 && st.currentRate >= 3) {
        /* Avoid re-firing for the same region within 15 min */
        var last = _spikeLog.filter(function (s) { return s.region === r; })[0];
        if (last && (Date.now() - last.ts) < 15 * 60 * 1000) return;

        console.log('[SentimentVelocity] SPIKE ' + r + ': ' + st.currentRate +
          ' events/hr (' + st.acceleration.toFixed(1) + '× baseline, score ' + st.score + ')');

        _spikeLog.unshift({ region: r, acceleration: st.acceleration,
          currentRate: st.currentRate, score: st.score, ts: Date.now() });
        if (_spikeLog.length > 20) _spikeLog.pop();

        try {
          window.dispatchEvent(new CustomEvent('velocity-spike', {
            detail: { region: r, acceleration: st.acceleration,
                      currentRate: st.currentRate, score: st.score }
          }));
        } catch (e) {}
      }
    });
  }

  /* ── Prune old timestamps ─────────────────────────────────────────────── */
  function _prune() {
    var cutoff = Date.now() - BASELINE_MS - WINDOW_MS;
    Object.keys(_log).forEach(function (r) {
      _log[r] = _log[r].filter(function (t) { return t >= cutoff; });
    });
  }

  /* ── Background maintenance ───────────────────────────────────────────── */
  setInterval(function () {
    _prune();
    _checkSpikes();
  }, PRUNE_INTERVAL);

  /* ── Public API ───────────────────────────────────────────────────────── */
  window.SentimentVelocity = {
    record:    record,
    score:     score,
    stats:     stats,

    /* Return recent spikes for dashboard display */
    recentSpikes: function () { return _spikeLog.slice(); },

    /* Score all active regions, sorted by acceleration */
    allStats: function () {
      return Object.keys(_log)
        .map(stats)
        .filter(function (s) { return s.currentRate > 0; })
        .sort(function (a, b) { return b.acceleration - a.acceleration; });
    },

    /* Human-readable console summary */
    status: function () {
      var rows = window.SentimentVelocity.allStats();
      if (!rows.length) return '[SentimentVelocity] No data yet';
      return '[SentimentVelocity]\n' + rows.map(function (r) {
        return '  ' + r.region + ': ' + r.currentRate + '/hr (' +
          r.acceleration.toFixed(1) + '×, score ' + r.score + ')';
      }).join('\n');
    }
  };

  console.log('[SentimentVelocity] Loaded — narrative acceleration tracker active');

})();
