/* Correlation Agent — correlation-agent.js v1
 *
 * Monitors correlated asset pairs and signals when the lagging asset has
 * diverged significantly from its lead, expecting mean reversion / catch-up.
 *
 * Logic:
 *   Every 5 minutes, record prices for all lead+lag assets (max 24 samples = 2h).
 *   Calculate the 1-hour return for both assets in each pair.
 *   Divergence = lead_return - lag_return.
 *   If |divergence| >= pair.minDivPct and lag is available (HLFeed), emit a signal:
 *     - Lead UP, lag lagging → lag LONG  (catch-up expected)
 *     - Lead DOWN, lag didn't fall as much → lag SHORT (delayed sell-off expected)
 *
 * Scoring:
 *   Base confidence from pair definition.
 *   +0.05 if divergence is 2× the minimum threshold.
 *   +0.03 if any GII agent has a matching view on the lead asset.
 *
 * Cooldown: 4 hours per pair (keyed by pair name).
 *
 * Exposes: window.GII_AGENT_CORRELATION
 */
(function () {
  'use strict';

  // ── constants ────────────────────────────────────────────────────────────────

  var POLL_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
  var INIT_DELAY_MS    = 25000;            // 25 seconds — let feeds warm up first
  var MAX_SAMPLES      = 24;              // max price samples per asset (24 × 5min = 2h)
  var RETURN_WINDOW_MS = 60 * 60 * 1000;  // 1-hour return window
  var COOLDOWN_MS      = 2 * 60 * 60 * 1000; // 2-hour cooldown per pair
  var MAX_SIGNALS      = 40;              // cap the _signals array length

  // GII agent registry to check for view alignment on the lead asset
  var GII_AGENTS = [
    'GII_AGENT_ENERGY', 'GII_AGENT_MACRO', 'GII_AGENT_SATINTEL',
    'GII_AGENT_CRISISRANK', 'GII_AGENT_FORECAST', 'GII_AGENT_MACROSTRESS',
    'GII_INTEL_MASTER', 'GII_AGENT_SCALPER', 'GII_AGENT_CONFLICT',
    'GII_AGENT_MARITIME', 'GII_AGENT_TECHNICALS', 'GII_AGENT_MARKET_OBSERVER'
  ];

  // Correlated pairs to monitor.
  // lead     : asset whose move should be followed
  // lag      : asset expected to catch up
  // name     : human-readable label (also used as cooldown key)
  // sector   : used in signal metadata
  // minDivPct: minimum divergence (%) to trigger a signal
  // conf     : base confidence score
  var PAIRS = [
    { lead:'GLD',      lag:'GDX',    name:'Gold/Miners',    sector:'metals', minDivPct:1.2, conf:0.74 },
    { lead:'GLD',      lag:'SLV',    name:'Gold/Silver',    sector:'metals', minDivPct:1.5, conf:0.70 },
    { lead:'BTC',      lag:'ETH',    name:'BTC/ETH',        sector:'crypto', minDivPct:2.0, conf:0.72 },
    { lead:'BTC',      lag:'SOL',    name:'BTC/SOL',        sector:'crypto', minDivPct:2.5, conf:0.68 },
    { lead:'BTC',      lag:'XRP',    name:'BTC/XRP',        sector:'crypto', minDivPct:2.5, conf:0.67 },
    { lead:'SPY',      lag:'QQQ',    name:'SPY/QQQ',        sector:'equity', minDivPct:0.8, conf:0.68 },
    { lead:'BRENTOIL', lag:'XLE',    name:'Oil/Energy ETF', sector:'energy', minDivPct:1.5, conf:0.71 },
    { lead:'BRENTOIL', lag:'WTI',    name:'Brent/WTI',      sector:'energy', minDivPct:0.8, conf:0.73 },
    { lead:'GLD',      lag:'SILVER', name:'Gold/Silver2',   sector:'metals', minDivPct:1.5, conf:0.70 },
    { lead:'ETH',      lag:'SOL',    name:'ETH/SOL',        sector:'crypto', minDivPct:2.0, conf:0.67 }
  ];

  // ── private state ────────────────────────────────────────────────────────────

  var _priceHistory = {};  // asset → [{ price, ts }]
  var _signals      = [];  // active/recent signals emitted this session
  var _cooldowns    = {};  // pairName → timestamp of last signal
  var _scanCount    = 0;
  var _signalCount  = 0;
  var _lastPoll     = 0;
  var _online       = false;

  // ── price history helpers ────────────────────────────────────────────────────

  // Record a price sample for an asset, capping to MAX_SAMPLES
  function _record(asset, price) {
    if (!_priceHistory[asset]) _priceHistory[asset] = [];
    _priceHistory[asset].push({ price: price, ts: Date.now() });
    if (_priceHistory[asset].length > MAX_SAMPLES) _priceHistory[asset].shift();
  }

  // Calculate % return over the last RETURN_WINDOW_MS.
  // Returns null if there aren't at least 2 samples.
  function _calcReturn(asset) {
    var h = _priceHistory[asset];
    if (!h || h.length < 2) return null;

    var cutoff = Date.now() - RETURN_WINDOW_MS;
    // Find the oldest sample still within the window — fall back to oldest overall
    var baseline = h[0];
    for (var i = 0; i < h.length; i++) {
      if (h[i].ts >= cutoff) { baseline = h[i]; break; }
    }

    var latest = h[h.length - 1];
    if (!baseline.price) return null;
    return (latest.price - baseline.price) / baseline.price * 100;
  }

  // ── GII alignment check ──────────────────────────────────────────────────────

  // Returns true if any GII agent has a signal on the lead asset whose direction
  // matches the expected lag direction (both LONG or both SHORT).
  function _giiMatchesLead(leadAsset, lagBias) {
    var biasUp = lagBias === 'LONG';
    for (var i = 0; i < GII_AGENTS.length; i++) {
      var ag = window[GII_AGENTS[i]];
      if (!ag || typeof ag.signals !== 'function') continue;
      var sigs;
      try { sigs = ag.signals(); } catch (e) { continue; }
      for (var j = 0; j < sigs.length; j++) {
        var s = sigs[j];
        if ((s.asset || '').toUpperCase() !== leadAsset.toUpperCase()) continue;
        var sd = (s.bias || s.direction || '').toUpperCase();
        // Lead going up aligns with lag LONG; lead going down aligns with lag SHORT
        if (biasUp && (sd === 'LONG' || sd === 'BUY')) return true;
        if (!biasUp && (sd === 'SHORT' || sd === 'SELL')) return true;
      }
    }
    return false;
  }

  // ── cooldown helpers ─────────────────────────────────────────────────────────

  function _onCooldown(pairName) {
    var last = _cooldowns[pairName];
    return last && (Date.now() - last) < COOLDOWN_MS;
  }

  function _setCooldown(pairName) {
    _cooldowns[pairName] = Date.now();
  }

  // ── signal helpers ───────────────────────────────────────────────────────────

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  // ── main scan ────────────────────────────────────────────────────────────────

  function _scan() {
    _scanCount++;
    _lastPoll = Date.now();
    _online   = true;

    if (!window.HLFeed) {
      // HLFeed not loaded yet — skip silently, will retry next interval
      return;
    }

    var newSignals = [];

    for (var i = 0; i < PAIRS.length; i++) {
      var pair = PAIRS[i];

      // ── 1. Availability check: both assets must be live ──────────────────────
      var leadAvail = (typeof HLFeed.isAvailable === 'function')
                      ? HLFeed.isAvailable(pair.lead) : false;
      var lagAvail  = (typeof HLFeed.isAvailable === 'function')
                      ? HLFeed.isAvailable(pair.lag)  : false;

      if (!leadAvail || !lagAvail) continue;

      // ── 2. Get current prices ─────────────────────────────────────────────────
      var leadData = (typeof HLFeed.getPrice === 'function')
                     ? HLFeed.getPrice(pair.lead) : null;
      var lagData  = (typeof HLFeed.getPrice === 'function')
                     ? HLFeed.getPrice(pair.lag)  : null;

      // Skip if either feed is missing or has no price
      if (!leadData || !leadData.price) continue;
      if (!lagData  || !lagData.price)  continue;

      // ── 3. Record samples ─────────────────────────────────────────────────────
      _record(pair.lead, leadData.price);
      _record(pair.lag,  lagData.price);

      // ── 4. Calculate 1-hour returns ───────────────────────────────────────────
      var leadRet = _calcReturn(pair.lead);
      var lagRet  = _calcReturn(pair.lag);

      // Need at least a couple of samples before we can calculate returns
      if (leadRet === null || lagRet === null) continue;

      // ── 5. Divergence ─────────────────────────────────────────────────────────
      // Positive divergence: lead went up more (or down less) than lag
      var divergence = leadRet - lagRet;
      var absDivPct  = Math.abs(divergence);

      if (absDivPct < pair.minDivPct) continue;

      // ── 6. Cooldown check ─────────────────────────────────────────────────────
      if (_onCooldown(pair.name)) continue;

      // ── 7. Determine signal bias ──────────────────────────────────────────────
      // divergence > 0 → lead went up, lag lagging → lag should LONG (catch-up)
      // divergence < 0 → lead went down, lag lagging (didn't fall) → lag SHORT
      var bias = (divergence > 0) ? 'LONG' : 'SHORT';

      // ── 8. Confidence scoring ─────────────────────────────────────────────────
      var conf = pair.conf;

      // Bonus if divergence is at least 2× the minimum threshold
      if (absDivPct >= pair.minDivPct * 2) conf += 0.05;

      // Bonus if any GII agent has a matching view on the lead asset
      if (_giiMatchesLead(pair.lead, bias)) conf += 0.03;

      // Cap confidence at 0.95
      conf = Math.min(0.95, Math.round(conf * 100) / 100);

      // ── 9. Reasoning string ───────────────────────────────────────────────────
      var leadDir  = leadRet >= 0 ? 'up' : 'down';
      var lagLabel = Math.abs(lagRet).toFixed(1) + '%';
      var leadLabel= Math.abs(leadRet).toFixed(1) + '%';
      var divLabel = absDivPct.toFixed(1) + '%';

      var reasoning = pair.lead + ' ' + leadDir + ' ' + leadLabel +
                      ' \u00b7 ' + pair.lag + ' lagging by ' + divLabel +
                      ' \u2014 correlation catch-up expected';

      // ── 10. Build and store signal ────────────────────────────────────────────
      var sig = {
        source       : 'correlation',
        asset        : pair.lag,
        bias         : bias,
        confidence   : conf,
        reasoning    : reasoning,
        region       : 'GLOBAL',
        sector       : pair.sector,
        evidenceKeys : ['correlation', pair.sector],
        pairName     : pair.name,
        leadAsset    : pair.lead,
        leadReturn   : Math.round(leadRet * 100) / 100,
        lagReturn    : Math.round(lagRet  * 100) / 100,
        divergencePct: Math.round(absDivPct * 100) / 100,
        timestamp    : Date.now()
      };

      newSignals.push(sig);
      _pushSignal(sig);
      _setCooldown(pair.name);
      _signalCount++;

      console.log('[CORR] Signal: ' + pair.name + ' → ' + pair.lag + ' ' + bias +
                  ' (div ' + divLabel + ', conf ' + conf + ')');
    }

    // ── Forward to EE ─────────────────────────────────────────────────────────
    if (newSignals.length && window.EE && typeof EE.onSignals === 'function') {
      try {
        EE.onSignals(newSignals);
      } catch (e) {
        console.warn('[CORR] EE.onSignals() error: ' + (e.message || String(e)));
      }
    }

    console.log('[CORR] Scan #' + _scanCount + ': ' +
                _activePairCount() + ' pairs with data, ' +
                newSignals.length + ' signals this scan, ' +
                _signalCount + ' total');
  }

  // ── helpers for status ───────────────────────────────────────────────────────

  // Count pairs where both assets have enough price history to compute a return
  function _activePairCount() {
    var count = 0;
    for (var i = 0; i < PAIRS.length; i++) {
      var p = PAIRS[i];
      var lh = _priceHistory[p.lead];
      var gh = _priceHistory[p.lag];
      if (lh && lh.length >= 2 && gh && gh.length >= 2) count++;
    }
    return count;
  }

  // ── init ─────────────────────────────────────────────────────────────────────

  function _init() {
    console.log('[CORR] Correlation agent initialising — first scan in ' +
                (INIT_DELAY_MS / 1000) + 's');

    setTimeout(function () {
      _scan();
      setInterval(_scan, POLL_INTERVAL_MS);
    }, INIT_DELAY_MS);
  }

  // ── public API ────────────────────────────────────────────────────────────────

  window.GII_AGENT_CORRELATION = {

    // Current active signals (most recent first)
    signals: function () {
      return _signals.slice();
    },

    // Agent status summary
    status: function () {
      var cooldownInfo = {};
      for (var i = 0; i < PAIRS.length; i++) {
        var p = PAIRS[i];
        if (_cooldowns[p.name]) {
          var remaining = Math.max(0, COOLDOWN_MS - (Date.now() - _cooldowns[p.name]));
          if (remaining > 0) cooldownInfo[p.name] = Math.round(remaining / 60000) + 'min';
        }
      }

      return {
        lastPoll    : _lastPoll || null,
        online      : _online,
        pairsActive : _activePairCount(),
        signalCount : _signalCount,
        scanCount   : _scanCount,
        cooldowns   : cooldownInfo,
        note        : _scanCount
          ? (_activePairCount() + '/' + PAIRS.length + ' pairs active · ' +
             _signalCount + ' signals total')
          : 'warming up — first scan in ~' + (INIT_DELAY_MS / 1000) + 's'
      };
    },

    // Force an immediate scan (bypasses the timer)
    scan: function () {
      _scan();
    }
  };

  window.addEventListener('load', _init);

})();
