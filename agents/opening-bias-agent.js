/* Opening Bias Agent — opening-bias-agent.js v1
 *
 * Fires once per trading day at 10:00–10:15 AM ET, right after the EE's
 * 30-minute open-volatility gate lifts (09:30–10:00 is blocked by the TOD filter).
 *
 * What it does:
 *   - Reads momentum signals from GII_AGENT_MOMENTUM at market open
 *   - These signals reflect overnight + pre-market moves (1h/4h data)
 *   - Submits any clear directional bias for equity and crypto assets
 *     through GII_AGENT_ENTRY so they get full confluence scoring
 *
 * Why it matters:
 *   - The TOD gate blocks signals 09:30–10:00 ET, but strong overnight moves
 *     (e.g. SPY gapped up 1.2% on earnings news) should still produce entries
 *     right after the gate lifts — otherwise that opportunity is missed entirely.
 *   - Without this agent, momentum signals from 09:30 simply expire unused.
 *
 * Timing:
 *   - Checks every 60s whether it's within the 10:00–10:15 ET window on a weekday
 *   - Fires at most once per trading day (deduped by date)
 *   - Only submits signals with confidence ≥ 65% to avoid noise
 *
 * Exposes: window.GII_AGENT_OPENING_BIAS
 */

(function () {
  'use strict';

  var _firedDate  = null;   // 'YYYY-MM-DD' of last fire — prevents double-firing same day
  var _lastSignals = [];    // signals submitted in last cycle
  var _status = { lastFire: null, signalCount: 0, lastAssets: [] };

  /* Equity tokens that benefit from opening-bias (HL @N tokens have 24h data) */
  var EQUITY_ASSETS = ['SPY','QQQ','NVDA','TSLA','AAPL','META','MSFT','GOOGL','SMH','XLE'];
  var CRYPTO_ASSETS = ['BTC','ETH','SOL'];   // crypto is 24/7 but still gaps at equity open
  var TARGET_ASSETS = EQUITY_ASSETS.concat(CRYPTO_ASSETS);

  var REGION_MAP = {
    SPY:'NORTH_AMERICA', QQQ:'NORTH_AMERICA', NVDA:'NORTH_AMERICA',
    TSLA:'NORTH_AMERICA', AAPL:'NORTH_AMERICA', META:'NORTH_AMERICA',
    MSFT:'NORTH_AMERICA', GOOGL:'NORTH_AMERICA', SMH:'NORTH_AMERICA',
    XLE:'NORTH_AMERICA',
    BTC:'GLOBAL', ETH:'GLOBAL', SOL:'GLOBAL'
  };

  /* ── ET time helpers ───────────────────────────────────────────────────── */
  function _etMins() {
    var now = new Date();
    var mo  = now.getUTCMonth();
    var off = (mo >= 2 && mo <= 10) ? 240 : 300;   // EDT=240, EST=300
    return (now.getUTCHours() * 60 + now.getUTCMinutes() + 1440 - off) % 1440;
  }

  function _todayKey() { return new Date().toISOString().slice(0, 10); }

  function _isWeekday() { var d = new Date().getUTCDay(); return d >= 1 && d <= 5; }

  /* ── Main logic ────────────────────────────────────────────────────────── */
  function _checkAndFire() {
    if (!_isWeekday()) return;

    var mins  = _etMins();
    var today = _todayKey();

    // Only fire within the 10:00–10:15 ET window, once per day
    if (mins < 600 || mins > 615) return;   // 600=10:00, 615=10:15
    if (_firedDate === today) return;

    // Mark as fired before async work to prevent double-trigger
    _firedDate = today;

    _buildSignals();
  }

  function _buildSignals() {
    if (!window.GII_AGENT_ENTRY || typeof GII_AGENT_ENTRY.submit !== 'function') return;
    if (!window.GII_AGENT_MOMENTUM || typeof GII_AGENT_MOMENTUM.signals !== 'function') return;

    var momSigs = [];
    try { momSigs = GII_AGENT_MOMENTUM.signals(); } catch(e) { return; }
    if (!momSigs.length) return;

    // Filter to target assets with meaningful confidence
    var relevant = momSigs.filter(function(s) {
      var asset = (s.asset || '').toUpperCase();
      return TARGET_ASSETS.indexOf(asset) !== -1 && (s.confidence || 0) >= 65;
    });

    if (!relevant.length) {
      console.log('[OPENING BIAS] No qualifying momentum signals at open — skipping');
      return;
    }

    // Build opening-bias signals from momentum data
    var toSubmit = relevant.map(function(s) {
      var asset = (s.asset || '').toUpperCase();
      var dir   = (s.bias === 'short' || s.dir === 'SHORT') ? 'SHORT' : 'LONG';
      var conf  = Math.min(82, s.confidence || 65);  // cap at 82 — opening bias, not IC signal
      return {
        asset:    asset,
        dir:      dir,
        conf:     conf,
        source:   'momentum',
        srcCount: (s.srcCount || 1) + 1,  // +1 for the opening-timing confirmation
        region:   REGION_MAP[asset] || 'GLOBAL',
        reason:   'OPENING-BIAS: ' + (s.reason || asset + ' momentum at 10:00 ET open'),
        timestamp: Date.now()
      };
    });

    _lastSignals = toSubmit;
    _status.lastFire    = new Date().toISOString();
    _status.signalCount += toSubmit.length;
    _status.lastAssets   = toSubmit.map(function(s){ return s.asset + '(' + s.dir + ')'; });

    console.log('[OPENING BIAS] Firing ' + toSubmit.length + ' signal(s) at 10:00 ET open: ' +
      _status.lastAssets.join(', '));

    GII_AGENT_ENTRY.submit(toSubmit, 'opening-bias');
  }

  /* ── Public API ────────────────────────────────────────────────────────── */
  window.GII_AGENT_OPENING_BIAS = {
    status:  function () { return Object.assign({}, _status, { firedDate: _firedDate }); },
    signals: function () { return _lastSignals.slice(); },
    /* Force a fire right now (debug / manual trigger) */
    fire:    function () { _firedDate = null; _buildSignals(); }
  };

  // Poll every 60s to catch the 10:00–10:15 ET window
  setInterval(_checkAndFire, 60 * 1000);
  // Also check immediately in case page loaded during the window
  setTimeout(_checkAndFire, 5000);

  console.log('[OPENING BIAS] Loaded — fires once per day at 10:00–10:15 ET');

})();
