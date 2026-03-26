/* ═══════════════════════════════════════════════════════════════════════════
   SOURCE CREDIBILITY MODULE v1
   ═══════════════════════════════════════════════════════════════════════════
   Maps RSS/data source tags to credibility weights (0.0 – 1.5).

   Why this matters:
   - Previously S3 score = srcCount × 4  (treats all sources equally)
   - Now      S3 score = srcWeight × 7   (Reuters single-source > Reddit × 3)
   - High-credibility sources can push events through IC even without corroboration
   - Low-credibility sources need corroboration to overcome noise floor

   Weight scale:
     1.5   Official gov/military/central-bank sources
     1.2   Major wire services (Reuters, Bloomberg, AP)
     1.0   Tier-1 newspaper / verified financial press
     0.8   Tier-2 regional / specialised outlets
     0.6   State media (bias risk — credible but agenda-driven)
     0.4   Social media, Telegram, unverified feeds
     0.3   Forums, Reddit, anonymous sources

   Exposed as window.SourceCredibility
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Weight table ─────────────────────────────────────────────────────── */
  var WEIGHTS = {
    /* Official / government / central bank */
    'state_dept':     1.5,
    'pentagon':       1.5,
    'whitehouse':     1.5,
    'mod':            1.5,   // ministry of defence
    'fed':            1.4,
    'ecb':            1.4,
    'boe':            1.4,
    'boj':            1.4,
    'treasury':       1.4,
    'sec':            1.3,
    'imf':            1.3,
    'worldbank':      1.3,
    'un':             1.3,
    'nato':           1.3,
    'interpol':       1.2,
    'iaea':           1.3,

    /* Wire services */
    'reuters':        1.2,
    'bloomberg':      1.2,
    'ap':             1.2,
    'afp':            1.1,
    'dpa':            1.0,

    /* Tier-1 newspapers / broadcasters */
    'wsj':            1.1,
    'ft':             1.1,
    'nyt':            1.0,
    'guardian':       1.0,
    'bbc':            1.0,
    'economist':      1.0,
    'wapo':           1.0,
    'spiegel':        0.9,
    'lemonde':        0.9,

    /* Financial / markets */
    'cnbc':           0.9,
    'marketwatch':    0.9,
    'barrons':        0.9,
    'seeking_alpha':  0.8,
    'seekingalpha':   0.8,
    'zerohedge':      0.6,   // partisan slant — downweighted

    /* Defence / intelligence */
    'janes':          1.1,
    'defensenews':    1.0,
    'globalsecurity': 0.9,
    'bellingcat':     0.9,
    'osint':          0.8,

    /* Regional press */
    'aljazeera':      0.8,
    'middleeast':     0.7,
    'kyiv_post':      0.7,
    'khaleej':        0.7,
    'dawn':           0.7,
    'thehindu':       0.8,
    'scmp':           0.8,   // South China Morning Post

    /* State-controlled / agenda-risk */
    'xinhua':         0.5,
    'tass':           0.4,
    'rt':             0.3,   // Russian state propaganda
    'cgtn':           0.5,
    'globaltimes':    0.4,

    /* Crypto / tech */
    'coindesk':       0.8,
    'cointelegraph':  0.7,
    'theblock':       0.8,
    'decrypt':        0.7,
    'techcrunch':     0.8,
    'wired':          0.8,

    /* Prediction markets */
    'polymarket':     0.9,
    'pmfeed':         0.9,
    'pm':             0.9,
    'metaculus':      0.8,

    /* Social / low-signal */
    'twitter':        0.4,
    'reddit':         0.3,
    'telegram':       0.4,
    'discord':        0.3,
    'stocktwits':     0.3,

    /* Internal agent feeds — known quality */
    'shadowbroker':   0.9,
    'scalper':        0.9,
    'scalper_session':0.9,
    'gii':            1.0,
    'ic':             0.8,
    'onchain':        0.8,
    'macro':          0.9,
    'technicals':     0.9,
  };

  var DEFAULT_WEIGHT = 0.7;

  /* ── Normalise source tag for lookup ──────────────────────────────────── */
  function _normalise(source) {
    if (!source) return '';
    return source.toLowerCase().replace(/[\s\-\.\/]+/g, '_').replace(/[^a-z0-9_]/g, '');
  }

  /* ── Public API ───────────────────────────────────────────────────────── */
  window.SourceCredibility = {

    /* Returns weight (0.3 – 1.5) for a source tag */
    weight: function (source) {
      var s = _normalise(source);
      if (!s) return DEFAULT_WEIGHT;

      /* 1. Exact match */
      if (WEIGHTS[s] !== undefined) return WEIGHTS[s];

      /* 2. Substring match — e.g. 'reuters_rss' matches 'reuters' */
      var keys = Object.keys(WEIGHTS);
      for (var i = 0; i < keys.length; i++) {
        if (s.indexOf(keys[i]) !== -1 || keys[i].indexOf(s) !== -1) {
          return WEIGHTS[keys[i]];
        }
      }

      return DEFAULT_WEIGHT;
    },

    /* Returns 1 / 2 / 3 tier for display */
    tier: function (source) {
      var w = window.SourceCredibility.weight(source);
      return w >= 1.1 ? 1 : w >= 0.75 ? 2 : 3;
    },

    /* Human-readable label */
    label: function (source) {
      var t = window.SourceCredibility.tier(source);
      return 'T' + t + ' (' + window.SourceCredibility.weight(source).toFixed(1) + ')';
    },

    /* All weights (for debug) */
    dump: function () { return Object.assign({}, WEIGHTS); }
  };

  console.log('[SourceCredibility] Loaded — ' + Object.keys(WEIGHTS).length + ' source weights');

})();
