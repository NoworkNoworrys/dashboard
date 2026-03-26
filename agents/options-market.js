/* ═══════════════════════════════════════════════════════════════════════════
   OPTIONS MARKET AGENT v1
   ═══════════════════════════════════════════════════════════════════════════
   Reads CBOE options market data from /api/market and derives two key signals:

   1. VIX TERM STRUCTURE (contango vs backwardation)
      VIX (spot) vs VIX3M (3-month forward)
      - Contango  (VIX < VIX3M): normal market — near-term vol priced lower than future
      - Flat       (VIX ≈ VIX3M): regime uncertainty
      - Backwardation (VIX > VIX3M): STRESS — immediate fear priced above future
      Ratio = VIX / VIX3M  →  > 1.15 = severe stress, 1.05-1.15 = stress, < 0.90 = very calm

   2. PUT/CALL RATIO (PCR)
      > 1.1  = heavy put buying = hedging / fear     → RISK_OFF signal
      0.8-1.0 = neutral
      < 0.7  = call-heavy = euphoria (can be RISK_OFF contrarian signal at extremes)

   Integrates with MacroRegime: fires 'options-stress' CustomEvent with a
   risk-score contribution (-20 to +20) that MacroRegime listens to.

   Exposed as window.OptionsMarket
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var POLL_MS     = 5 * 60 * 1000;   // 5 minutes — matches macro-regime poll
  var BACKEND_URL = 'http://localhost:8765';

  /* ── State ───────────────────────────────────────────────────────────── */
  var _data = {
    vix:    null,
    vix3m:  null,
    vix9d:  null,
    pcr:    null,
    tsRatio: null,     // VIX / VIX3M
    tsSignal: 'UNKNOWN',  // CONTANGO / FLAT / BACKWARDATION / STRESS
    pcrSignal: 'UNKNOWN', // FEAR / NEUTRAL / EUPHORIA
    riskScore: 0,         // -20 to +20 (positive = risk-off)
    lastUpdate: 0
  };

  /* ── Term structure interpretation ──────────────────────────────────── */
  function _interpretTS(vix, vix3m) {
    var ratio = vix / vix3m;
    _data.tsRatio = +ratio.toFixed(3);

    var signal, score;
    if      (ratio >= 1.20) { signal = 'SEVERE_BACKWARDATION'; score = 20; }
    else if (ratio >= 1.10) { signal = 'BACKWARDATION';        score = 14; }
    else if (ratio >= 1.03) { signal = 'FLAT_STRESSED';        score =  8; }
    else if (ratio >= 0.92) { signal = 'FLAT';                 score =  0; }
    else if (ratio >= 0.82) { signal = 'CONTANGO';             score = -5; }
    else                    { signal = 'STEEP_CONTANGO';       score =-10; }

    _data.tsSignal = signal;
    return score;
  }

  /* ── Put/call ratio interpretation ──────────────────────────────────── */
  function _interpretPCR(pcr) {
    var signal, score;
    if      (pcr >= 1.30) { signal = 'EXTREME_FEAR';  score = 15; }
    else if (pcr >= 1.10) { signal = 'FEAR';           score = 10; }
    else if (pcr >= 0.90) { signal = 'ELEVATED';       score =  5; }
    else if (pcr >= 0.70) { signal = 'NEUTRAL';        score =  0; }
    else if (pcr >= 0.55) { signal = 'COMPLACENT';     score = -3; }
    else                  { signal = 'EUPHORIA';        score = -8; }  // contrarian risk

    _data.pcrSignal = signal;
    return score;
  }

  /* ── Main poll ────────────────────────────────────────────────────────── */
  function _poll() {
    fetch(BACKEND_URL + '/api/market')
      .then(function (res) { return res.json(); })
      .then(function (mkt) {
        var vix   = mkt.VIX   && mkt.VIX.price   ? parseFloat(mkt.VIX.price)   : null;
        var vix3m = mkt.VIX3M && mkt.VIX3M.price ? parseFloat(mkt.VIX3M.price) : null;
        var vix9d = mkt.VIX9D && mkt.VIX9D.price ? parseFloat(mkt.VIX9D.price) : null;
        var pcr   = mkt.PCR   && mkt.PCR.price   ? parseFloat(mkt.PCR.price)   : null;

        _data.vix   = vix;
        _data.vix3m = vix3m;
        _data.vix9d = vix9d;
        _data.pcr   = pcr;

        var totalScore = 0;
        var notes = [];

        if (vix && vix3m && vix3m > 0) {
          var tsScore = _interpretTS(vix, vix3m);
          totalScore += tsScore;
          notes.push('VIX term: ' + _data.tsSignal + ' (' + _data.tsRatio + ')');
          if (tsScore !== 0) {
            notes.push('TS contribution: ' + (tsScore > 0 ? '+' : '') + tsScore);
          }
        }

        if (pcr !== null) {
          var pcrScore = _interpretPCR(pcr);
          totalScore += pcrScore;
          notes.push('PCR: ' + pcr.toFixed(2) + ' → ' + _data.pcrSignal);
        }

        var prevScore = _data.riskScore;
        _data.riskScore  = Math.max(-20, Math.min(20, totalScore));
        _data.lastUpdate = Date.now();

        /* Log when something notable */
        if (notes.length) {
          console.log('[OptionsMarket] ' + notes.join(' | '));
        }

        /* Fire event if stress detected or significant change */
        if (_data.riskScore >= 10 || Math.abs(_data.riskScore - prevScore) >= 8) {
          try {
            window.dispatchEvent(new CustomEvent('options-stress', {
              detail: {
                riskScore: _data.riskScore,
                tsSignal:  _data.tsSignal,
                pcrSignal: _data.pcrSignal,
                tsRatio:   _data.tsRatio,
                pcr:       pcr
              }
            }));
          } catch (e) {}
        }

        _renderBadge();
      })
      .catch(function () { /* backend offline */ });
  }

  /* ── Dashboard badge ─────────────────────────────────────────────────── */
  function _renderBadge() {
    var el = document.getElementById('optionsMarketBadge');
    if (!el) return;

    var parts = [];
    if (_data.tsRatio !== null) {
      var tsColor = _data.tsSignal === 'CONTANGO' || _data.tsSignal === 'STEEP_CONTANGO'
        ? '#00ff88'
        : _data.tsSignal === 'FLAT' ? '#aaa'
        : '#ff4444';
      parts.push('<span style="color:' + tsColor + '">TS:' + _data.tsRatio + '</span>');
    }
    if (_data.pcr !== null) {
      var pcrColor = _data.pcr > 1.1 ? '#ff4444' : _data.pcr < 0.7 ? '#ffaa00' : '#aaa';
      parts.push('<span style="color:' + pcrColor + '">P/C:' + _data.pcr.toFixed(2) + '</span>');
    }

    el.innerHTML = parts.length ? parts.join(' ') : '–';
    el.title = 'VIX term: ' + (_data.tsSignal || '?') + '\n' +
               'PCR: ' + (_data.pcr !== null ? _data.pcr.toFixed(2) + ' (' + _data.pcrSignal + ')' : '?') + '\n' +
               'Risk score: ' + _data.riskScore + '/20\n' +
               'VIX9D: ' + (_data.vix9d || '?') + '  VIX3M: ' + (_data.vix3m || '?');
  }

  /* ── Public API ──────────────────────────────────────────────────────── */
  window.OptionsMarket = {
    current:    function () { return Object.assign({}, _data); },
    refresh:    function () { _poll(); },

    /* Risk-off contribution to MacroRegime (-20 to +20) */
    riskScore:  function () { return _data.riskScore; },

    status: function () {
      return '[OptionsMarket] TS:' + (_data.tsSignal || '?') +
        ' ratio=' + (_data.tsRatio || '?') +
        ' | PCR:' + (_data.pcrSignal || '?') + '=' + (_data.pcr !== null ? _data.pcr.toFixed(2) : '?') +
        ' | riskScore=' + _data.riskScore;
    }
  };

  /* ── Boot ────────────────────────────────────────────────────────────── */
  setTimeout(_poll, 5000);
  setInterval(_poll, POLL_MS);

  console.log('[OptionsMarket] Loaded — VIX term structure + PCR tracker active');

})();
