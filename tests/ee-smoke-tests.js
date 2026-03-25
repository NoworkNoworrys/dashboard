/* ═══════════════════════════════════════════════════════════════════════════
   EE Smoke Tests — browser-based sanity checks for the Execution Engine
   ═══════════════════════════════════════════════════════════════════════════
   Run from the dashboard browser console:
     EETests.run()        — run all tests, print results
     EETests.run('risk')  — run only the group matching 'risk'

   Tests work through the public EE + AlpacaBroker APIs only.
   No mocking, no test framework needed — pure vanilla JS.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var _pass = 0, _fail = 0;

  function assert(name, condition, detail) {
    if (condition) {
      console.log('%c PASS %c ' + name + (detail !== undefined ? ' (' + detail + ')' : ''),
        'background:#1a5c2e;color:#00ff88;padding:1px 4px;border-radius:2px', '');
      _pass++;
    } else {
      console.error('%c FAIL %c ' + name + (detail !== undefined ? ': ' + detail : ''),
        'background:#5c1a1a;color:#ff4444;padding:1px 4px;border-radius:2px', '');
      _fail++;
    }
  }

  /* ── Helpers ── */
  function goodSig(overrides) {
    return Object.assign({ asset: 'BTC', dir: 'LONG', conf: 85, srcCount: 3, region: 'global', reason: 'TEST' }, overrides || {});
  }

  /* ── Test groups ── */
  var GROUPS = {

    /* ─── 1. EE loaded and public API intact ─── */
    'EE API': function () {
      assert('window.EE exists',              typeof window.EE === 'object');
      assert('EE.onSignals is function',      typeof EE.onSignals === 'function');
      assert('EE.canExecute is function',     typeof EE.canExecute === 'function');
      assert('EE.getOpenTrades is function',  typeof EE.getOpenTrades === 'function');
      assert('EE.getAllTrades is function',   typeof EE.getAllTrades === 'function');
      assert('EE.getConfig is function',      typeof EE.getConfig === 'function');
      assert('EE.reconcileAlpaca is func',    typeof EE.reconcileAlpaca === 'function');
      assert('EE.fillLatencyStats is func',   typeof EE.fillLatencyStats === 'function');
    },

    /* ─── 2. Config defaults are sane ─── */
    'Config sanity': function () {
      var cfg = EE.getConfig();
      assert('virtual_balance > 0',        cfg.virtual_balance > 0,          cfg.virtual_balance);
      assert('min_confidence >= 50',        cfg.min_confidence >= 50,         cfg.min_confidence);
      assert('max_open_trades >= 1',        cfg.max_open_trades >= 1,         cfg.max_open_trades);
      assert('max_per_region >= 1',         cfg.max_per_region >= 1,          cfg.max_per_region);
      assert('max_per_sector >= 1',         cfg.max_per_sector >= 1,          cfg.max_per_sector);
      assert('risk_per_trade_pct 0.1-10',   cfg.risk_per_trade_pct >= 0.1 && cfg.risk_per_trade_pct <= 10, cfg.risk_per_trade_pct);
      assert('stop_loss_pct > 0',           cfg.stop_loss_pct > 0,            cfg.stop_loss_pct);
      assert('take_profit_ratio > 0',       cfg.take_profit_ratio > 0,        cfg.take_profit_ratio);
      assert('daily_loss_limit_pct > 0',    cfg.daily_loss_limit_pct > 0,     cfg.daily_loss_limit_pct);
      assert('cooldown_ms > 0',             cfg.cooldown_ms > 0,              cfg.cooldown_ms);
    },

    /* ─── 3. canExecute rejects bad signals ─── */
    'Signal validation': function () {
      var r;

      r = EE.canExecute(goodSig({ dir: 'WATCH' }));
      assert('WATCH rejected',              !r.ok, r.reason);

      r = EE.canExecute(goodSig({ conf: 5 }));
      assert('Low conf (5) rejected',       !r.ok, r.reason);

      r = EE.canExecute(goodSig({ conf: 49 }));
      assert('Conf below threshold rejected', !r.ok, r.reason);

      r = EE.canExecute(goodSig({ srcCount: undefined }));
      assert('Missing srcCount rejected',   !r.ok, r.reason);

      r = EE.canExecute(goodSig({ srcCount: 1 }));
      assert('srcCount=1 rejected',         !r.ok, r.reason);

      // Scalper/GII signals bypass srcCount requirement
      r = EE.canExecute(goodSig({ srcCount: 1, reason: 'GII: test' }));
      // Note: may still fail for other reasons (EE disabled etc) — just check srcCount isn't the reason
      if (!r.ok) {
        assert('GII signal not blocked for srcCount', r.reason.indexOf('srcCount') === -1, r.reason);
      } else {
        assert('GII signal passes srcCount check', true);
      }
    },

    /* ─── 4. AlpacaBroker loaded and covers correct assets ─── */
    'Alpaca broker': function () {
      assert('AlpacaBroker exists',         typeof window.AlpacaBroker === 'object');
      assert('covers() is function',        typeof AlpacaBroker.covers === 'function');
      assert('NVDA → Alpaca',               AlpacaBroker.covers('NVDA'));
      assert('LMT → Alpaca',                AlpacaBroker.covers('LMT'));
      assert('RTX → Alpaca',                AlpacaBroker.covers('RTX'));
      assert('PLTR → Alpaca',               AlpacaBroker.covers('PLTR'));
      assert('BTC not → Alpaca',            !AlpacaBroker.covers('BTC'));
      assert('ETH not → Alpaca',            !AlpacaBroker.covers('ETH'));
      assert('SOL not → Alpaca',            !AlpacaBroker.covers('SOL'));
      assert('assetInfo NVDA has sector',   AlpacaBroker.assetInfo('NVDA') && AlpacaBroker.assetInfo('NVDA').sector === 'semis');
      assert('assetInfo LMT has sector',    AlpacaBroker.assetInfo('LMT')  && AlpacaBroker.assetInfo('LMT').sector  === 'defense');
    },

    /* ─── 5. Alpaca connection ─── */
    'Alpaca connection': function () {
      var s = AlpacaBroker.status();
      assert('Connected',                   s.connected,            s.note);
      assert('Paper mode',                  s.paper,                'live mode active — expected paper');
      assert('Equity > 0',                  s.equity > 0,           '$' + s.equity);
      assert('Buying power > 0',            s.buyingPow > 0,        '$' + s.buyingPow);
      assert('46 assets covered',           s.assetCount === 46,    s.assetCount);
    },

    /* ─── 6. Trade data access ─── */
    'Trade data': function () {
      var open   = EE.getOpenTrades();
      var all    = EE.getAllTrades();
      var closed = all.filter(function(t){ return t.status !== 'OPEN'; });
      assert('getOpenTrades returns array',  Array.isArray(open));
      assert('getAllTrades returns array',   Array.isArray(all));
      assert('open <= total',               open.length <= all.length, open.length + ' / ' + all.length);
      assert('closed count correct',        closed.length === all.length - open.length);
      if (open.length) {
        var t = open[0];
        assert('Open trade has trade_id',   !!t.trade_id);
        assert('Open trade has asset',      !!t.asset);
        assert('Open trade has entry_price',typeof t.entry_price === 'number');
        assert('Open trade has direction',  t.direction === 'LONG' || t.direction === 'SHORT');
      }
    },

    /* ─── 7. Fill latency stats ─── */
    'Fill latency': function () {
      var stats = EE.fillLatencyStats();
      assert('fillLatencyStats returns object', typeof stats === 'object');
      assert('count is number',                 typeof stats.count === 'number');
      if (stats.count > 0) {
        assert('avgS > 0',  stats.avgS > 0,  stats.avgS + 's');
        assert('maxMs >= minMs', stats.maxMs >= stats.minMs);
        assert('samples is array', Array.isArray(stats.samples));
      } else {
        assert('No fills yet — count=0 is valid', true);
      }
    },

    /* ─── 8. Risk management functions present ─── */
    'Risk controls': function () {
      assert('memStats is function',          typeof EE.memStats === 'function');
      assert('unrealisedPnl is function',     typeof EE.unrealisedPnl === 'function');
      assert('softReset is function',         typeof EE.softReset === 'function');
      assert('toggleAuto is function',        typeof EE.toggleAuto === 'function');
      var mem = EE.memStats();
      assert('memStats.trades is number',     typeof mem.trades === 'number');
      assert('memStats.priceCache is number', typeof mem.priceCache === 'number');
      var pnl = EE.unrealisedPnl();
      assert('unrealisedPnl returns array',   Array.isArray(pnl));
    }
  };

  /* ── Runner ── */
  window.EETests = {
    run: function (filter) {
      _pass = 0; _fail = 0;
      var label = filter ? 'EE Smoke Tests [filter: ' + filter + ']' : 'EE Smoke Tests';
      console.group('%c ' + label, 'font-size:13px;font-weight:bold;color:#00e5ff');
      Object.keys(GROUPS).forEach(function (name) {
        if (filter && name.toLowerCase().indexOf(filter.toLowerCase()) === -1) return;
        console.group('%c ' + name, 'color:#aaa;font-style:italic');
        try { GROUPS[name](); } catch (e) { console.error('Test group threw:', e); _fail++; }
        console.groupEnd();
      });
      var total = _pass + _fail;
      var colour = _fail > 0 ? 'color:#ff4444;font-weight:bold' : 'color:#00ff88;font-weight:bold';
      console.log('%c ' + _pass + '/' + total + ' passed' + (_fail ? ' — ' + _fail + ' FAILED' : ' ✓'), colour);
      console.groupEnd();
      return { pass: _pass, fail: _fail, total: total };
    }
  };

  console.log('[EETests] Smoke tests ready — run %cEETests.run()%c in the console',
    'color:#00e5ff;font-family:monospace', '');

})();
