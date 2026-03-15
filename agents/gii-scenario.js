/* GII Scenario Simulation Agent — gii-scenario.js v1
 * Assigns real-time probability weights to ~20 pre-defined named geopolitical scenarios.
 * Uses evidence-weighted scoring (not Monte Carlo): aggregates existing first-order
 * agent signals rather than re-reading raw IC events.
 *
 * Approach:
 *   For each scenario:
 *     - Collects signals from named contributing agents (evidenceWeights map)
 *     - Filters to region-relevant signals (24h age limit)
 *     - Computes weighted average confidence across contributing agents
 *     - Blends with Bayesian posterior from gii-core (previous cycle) as a prior
 *     - Emits signals for scenarios exceeding their individual emitThreshold
 *
 * Scenarios (20):
 *   HORMUZ_ESCALATION, IRAN_NUCLEAR_BREAKOUT, TAIWAN_BLOCKADE, TAIWAN_INVASION,
 *   UKRAINE_CEASEFIRE, UKRAINE_NATO_ESCALATION, IRAN_SANCTIONS_SNAPBACK,
 *   OPEC_SUPPLY_CUT, RED_SEA_ESCALATION, NK_PROVOCATION, CHINA_TECH_SANCTIONS,
 *   RUSSIA_ENERGY_CUT, MIDDLE_EAST_REGIONAL_WAR, US_RECESSION, GLOBAL_RISK_OFF,
 *   MALACCA_DISRUPTION, ISRAEL_IRAN_DIRECT, CENTRAL_BANK_PIVOT,
 *   SAUDI_ARAMCO_ATTACK, MULTI_THEATRE_CRISIS
 *
 * Reads:  window.GII_AGENT_* (agent signals, passive read-only)
 *         window.GII.posterior()  — Bayesian prior from previous gii-core cycle
 * Exposes: window.GII_AGENT_SCENARIO
 */
(function () {
  'use strict';

  var MAX_SIGNALS   = 40;
  var POLL_INTERVAL = 85000;
  var FEEDBACK_KEY  = 'gii_scenario_v1';
  var MIN_CONF      = 0.15;
  var MAX_CONF      = 0.88;
  var AGE_LIMIT_MS  = 24 * 60 * 60 * 1000; // 24h — ignore older agent signals

  // ── Scenario definitions ──────────────────────────────────────────────────
  //
  // evidenceWeights: { agentName: weight } — raw weights, normalised during scoring
  //   Agent names correspond to GII_AGENT_<NAME.toUpperCase()> globals
  //
  // assets: ordered by directness of exposure (primary first)
  //   factor   — multiplied by scenario probability to get signal confidence
  //   impact   — human-readable expected price range (display only)
  //
  // emitThreshold: minimum scenario probability (0–1) to emit any signals
  //   Higher base probabilities get higher thresholds to avoid noise

  var SCENARIOS = [
    {
      id:            'HORMUZ_ESCALATION',
      label:         'Iran Hormuz Closure / Threat',
      regions:       ['STRAIT OF HORMUZ', 'IRAN', 'MIDDLE EAST'],
      horizon:       14,
      baseProb:      0.18,
      emitThreshold: 0.28,
      evidenceWeights: {
        maritime:   0.30,
        escalation: 0.25,
        energy:     0.20,
        conflict:   0.15,
        narrative:  0.10
      },
      assets: [
        { asset: 'WTI',   bias: 'long',  factor: 1.00, impact: '+8–15%'  },
        { asset: 'BRENT', bias: 'long',  factor: 0.95, impact: '+7–14%'  },
        { asset: 'GLD',   bias: 'long',  factor: 0.75, impact: '+3–6%'   },
        { asset: 'XLE',   bias: 'long',  factor: 0.80, impact: '+5–9%'   }
      ]
    },
    {
      id:            'IRAN_NUCLEAR_BREAKOUT',
      label:         'Iran Nuclear Weapons Breakout',
      regions:       ['IRAN', 'MIDDLE EAST'],
      horizon:       30,
      baseProb:      0.10,
      emitThreshold: 0.18,
      evidenceWeights: {
        escalation: 0.35,
        sanctions:  0.25,
        conflict:   0.20,
        narrative:  0.20
      },
      assets: [
        { asset: 'GLD',   bias: 'long',  factor: 1.00, impact: '+5–12%'  },
        { asset: 'WTI',   bias: 'long',  factor: 0.90, impact: '+6–14%'  },
        { asset: 'SPY',   bias: 'short', factor: 0.70, impact: '−4–8%'   }
      ]
    },
    {
      id:            'TAIWAN_BLOCKADE',
      label:         'China Naval Blockade of Taiwan',
      regions:       ['TAIWAN', 'SOUTH CHINA SEA'],
      horizon:       21,
      baseProb:      0.08,
      emitThreshold: 0.16,
      evidenceWeights: {
        maritime:   0.30,
        escalation: 0.30,
        conflict:   0.20,
        chokepoint: 0.20
      },
      assets: [
        { asset: 'TSM',   bias: 'short', factor: 1.00, impact: '−20–35%' },
        { asset: 'SMH',   bias: 'short', factor: 0.90, impact: '−15–25%' },
        { asset: 'GLD',   bias: 'long',  factor: 0.80, impact: '+4–8%'   },
        { asset: 'SPY',   bias: 'short', factor: 0.75, impact: '−5–10%'  }
      ]
    },
    {
      id:            'TAIWAN_INVASION',
      label:         'China Military Invasion of Taiwan',
      regions:       ['TAIWAN'],
      horizon:       30,
      baseProb:      0.04,
      emitThreshold: 0.10,
      evidenceWeights: {
        escalation: 0.40,
        conflict:   0.30,
        maritime:   0.20,
        narrative:  0.10
      },
      assets: [
        { asset: 'TSM',   bias: 'short', factor: 1.00, impact: '−40–70%' },
        { asset: 'GLD',   bias: 'long',  factor: 0.90, impact: '+8–18%'  },
        { asset: 'SPY',   bias: 'short', factor: 0.85, impact: '−10–20%' },
        { asset: 'SMH',   bias: 'short', factor: 0.80, impact: '−30–50%' }
      ]
    },
    {
      id:            'UKRAINE_CEASEFIRE',
      label:         'Ukraine–Russia Ceasefire Agreement',
      regions:       ['UKRAINE', 'RUSSIA'],
      horizon:       30,
      baseProb:      0.22,
      emitThreshold: 0.32,
      evidenceWeights: {
        escalation: 0.35,
        conflict:   0.25,
        narrative:  0.25,
        macro:      0.15
      },
      assets: [
        { asset: 'WTI',   bias: 'short', factor: 1.00, impact: '−5–10%'  },
        { asset: 'GLD',   bias: 'short', factor: 0.85, impact: '−3–6%'   },
        { asset: 'WHT',   bias: 'short', factor: 0.90, impact: '−8–14%'  }
      ]
    },
    {
      id:            'UKRAINE_NATO_ESCALATION',
      label:         'NATO Direct Military Involvement in Ukraine',
      regions:       ['UKRAINE', 'RUSSIA'],
      horizon:       21,
      baseProb:      0.07,
      emitThreshold: 0.14,
      evidenceWeights: {
        escalation: 0.40,
        conflict:   0.30,
        narrative:  0.20,
        macro:      0.10
      },
      assets: [
        { asset: 'GLD',   bias: 'long',  factor: 1.00, impact: '+8–16%'  },
        { asset: 'WTI',   bias: 'long',  factor: 0.90, impact: '+6–12%'  },
        { asset: 'SPY',   bias: 'short', factor: 0.85, impact: '−8–15%'  }
      ]
    },
    {
      id:            'IRAN_SANCTIONS_SNAPBACK',
      label:         'Iran Full Snapback Sanctions',
      regions:       ['IRAN', 'MIDDLE EAST'],
      horizon:       14,
      baseProb:      0.28,
      emitThreshold: 0.36,
      evidenceWeights: {
        sanctions:  0.40,
        narrative:  0.25,
        conflict:   0.20,
        escalation: 0.15
      },
      assets: [
        { asset: 'WTI',   bias: 'long',  factor: 1.00, impact: '+5–10%'  },
        { asset: 'BRENT', bias: 'long',  factor: 0.95, impact: '+5–9%'   }
      ]
    },
    {
      id:            'OPEC_SUPPLY_CUT',
      label:         'Major OPEC+ Surprise Supply Cut',
      regions:       ['MIDDLE EAST', 'GLOBAL'],
      horizon:       7,
      baseProb:      0.30,
      emitThreshold: 0.38,
      evidenceWeights: {
        energy:    0.50,
        macro:     0.25,
        sanctions: 0.15,
        social:    0.10
      },
      assets: [
        { asset: 'WTI',   bias: 'long',  factor: 1.00, impact: '+6–12%'  },
        { asset: 'BRENT', bias: 'long',  factor: 0.95, impact: '+6–11%'  },
        { asset: 'XLE',   bias: 'long',  factor: 0.85, impact: '+4–8%'   }
      ]
    },
    {
      id:            'RED_SEA_ESCALATION',
      label:         'Major Red Sea Shipping Disruption',
      regions:       ['RED SEA', 'MIDDLE EAST'],
      horizon:       7,
      baseProb:      0.38,
      emitThreshold: 0.46,
      evidenceWeights: {
        maritime:   0.40,
        chokepoint: 0.30,
        escalation: 0.20,
        conflict:   0.10
      },
      assets: [
        { asset: 'BRENT', bias: 'long',  factor: 1.00, impact: '+4–8%'   },
        { asset: 'WTI',   bias: 'long',  factor: 0.90, impact: '+3–7%'   },
        { asset: 'GLD',   bias: 'long',  factor: 0.70, impact: '+2–4%'   }
      ]
    },
    {
      id:            'NK_PROVOCATION',
      label:         'North Korea ICBM / Nuclear Test',
      regions:       ['NORTH KOREA'],
      horizon:       7,
      baseProb:      0.42,
      emitThreshold: 0.50,
      evidenceWeights: {
        escalation: 0.40,
        conflict:   0.30,
        satellite:  0.20,
        social:     0.10
      },
      assets: [
        { asset: 'GLD',   bias: 'long',  factor: 1.00, impact: '+2–5%'   },
        { asset: 'SPY',   bias: 'short', factor: 0.80, impact: '−1–3%'   }
      ]
    },
    {
      id:            'CHINA_TECH_SANCTIONS',
      label:         'US Expands Tech / Chip Sanctions vs China',
      regions:       ['CHINA', 'TAIWAN'],
      horizon:       21,
      baseProb:      0.32,
      emitThreshold: 0.40,
      evidenceWeights: {
        sanctions:  0.40,
        narrative:  0.25,
        macro:      0.20,
        social:     0.15
      },
      assets: [
        { asset: 'TSM',   bias: 'short', factor: 1.00, impact: '−6–12%'  },
        { asset: 'SMH',   bias: 'short', factor: 0.90, impact: '−5–10%'  },
        { asset: 'SOXX',  bias: 'short', factor: 0.85, impact: '−4–9%'   }
      ]
    },
    {
      id:            'RUSSIA_ENERGY_CUT',
      label:         'Russia Halts Energy Exports to Europe',
      regions:       ['RUSSIA', 'UKRAINE'],
      horizon:       14,
      baseProb:      0.15,
      emitThreshold: 0.24,
      evidenceWeights: {
        energy:     0.35,
        escalation: 0.25,
        sanctions:  0.25,
        narrative:  0.15
      },
      assets: [
        { asset: 'WTI',   bias: 'long',  factor: 1.00, impact: '+5–11%'  },
        { asset: 'BRENT', bias: 'long',  factor: 0.95, impact: '+6–12%'  },
        { asset: 'GLD',   bias: 'long',  factor: 0.75, impact: '+2–5%'   }
      ]
    },
    {
      id:            'MIDDLE_EAST_REGIONAL_WAR',
      label:         'Multi-State Middle East Regional War',
      regions:       ['MIDDLE EAST', 'IRAN', 'ISRAEL'],
      horizon:       21,
      baseProb:      0.09,
      emitThreshold: 0.16,
      evidenceWeights: {
        conflict:   0.30,
        escalation: 0.30,
        maritime:   0.20,
        narrative:  0.20
      },
      assets: [
        { asset: 'WTI',   bias: 'long',  factor: 1.00, impact: '+12–25%' },
        { asset: 'BRENT', bias: 'long',  factor: 0.95, impact: '+12–22%' },
        { asset: 'GLD',   bias: 'long',  factor: 0.90, impact: '+6–14%'  },
        { asset: 'SPY',   bias: 'short', factor: 0.80, impact: '−8–15%'  }
      ]
    },
    {
      id:            'US_RECESSION',
      label:         'US Recession Confirmed (GDP −2 Qtrs)',
      regions:       ['US', 'GLOBAL'],
      horizon:       30,
      baseProb:      0.25,
      emitThreshold: 0.34,
      evidenceWeights: {
        macro:     0.45,
        liquidity: 0.30,
        social:    0.15,
        calendar:  0.10
      },
      assets: [
        { asset: 'GLD',   bias: 'long',  factor: 1.00, impact: '+4–8%'   },
        { asset: 'TLT',   bias: 'long',  factor: 0.90, impact: '+5–10%'  },
        { asset: 'SPY',   bias: 'short', factor: 0.90, impact: '−10–18%' },
        { asset: 'WTI',   bias: 'short', factor: 0.80, impact: '−8–15%'  }
      ]
    },
    {
      id:            'GLOBAL_RISK_OFF',
      label:         'Broad Global Risk-Off Episode',
      regions:       ['GLOBAL'],
      horizon:       14,
      baseProb:      0.20,
      emitThreshold: 0.30,
      evidenceWeights: {
        macro:      0.30,
        liquidity:  0.25,
        escalation: 0.20,
        regime:     0.15,
        social:     0.10
      },
      assets: [
        { asset: 'GLD',   bias: 'long',  factor: 1.00, impact: '+3–7%'   },
        { asset: 'TLT',   bias: 'long',  factor: 0.85, impact: '+3–6%'   },
        { asset: 'SPY',   bias: 'short', factor: 0.85, impact: '−6–12%'  },
        { asset: 'BTC',   bias: 'short', factor: 0.70, impact: '−10–20%' }
      ]
    },
    {
      id:            'MALACCA_DISRUPTION',
      label:         'Strait of Malacca Disruption',
      regions:       ['SOUTH CHINA SEA', 'MALAYSIA'],
      horizon:       14,
      baseProb:      0.10,
      emitThreshold: 0.18,
      evidenceWeights: {
        maritime:   0.40,
        chokepoint: 0.40,
        conflict:   0.20
      },
      assets: [
        { asset: 'WTI',   bias: 'long',  factor: 1.00, impact: '+3–7%'   },
        { asset: 'TSM',   bias: 'short', factor: 0.80, impact: '−3–6%'   }
      ]
    },
    {
      id:            'ISRAEL_IRAN_DIRECT',
      label:         'Israel–Iran Direct Military Exchange',
      regions:       ['IRAN', 'ISRAEL', 'MIDDLE EAST'],
      horizon:       14,
      baseProb:      0.15,
      emitThreshold: 0.24,
      evidenceWeights: {
        conflict:   0.35,
        escalation: 0.35,
        narrative:  0.20,
        satellite:  0.10
      },
      assets: [
        { asset: 'WTI',   bias: 'long',  factor: 1.00, impact: '+8–18%'  },
        { asset: 'BRENT', bias: 'long',  factor: 0.95, impact: '+8–16%'  },
        { asset: 'GLD',   bias: 'long',  factor: 0.85, impact: '+5–10%'  },
        { asset: 'SPY',   bias: 'short', factor: 0.75, impact: '−4–8%'   }
      ]
    },
    {
      id:            'CENTRAL_BANK_PIVOT',
      label:         'Major Central Bank Aggressive Rate Pivot',
      regions:       ['US', 'GLOBAL'],
      horizon:       30,
      baseProb:      0.28,
      emitThreshold: 0.36,
      evidenceWeights: {
        macro:     0.50,
        liquidity: 0.30,
        calendar:  0.15,
        social:    0.05
      },
      assets: [
        { asset: 'GLD',   bias: 'long', factor: 1.00, impact: '+4–9%'    },
        { asset: 'BTC',   bias: 'long', factor: 0.80, impact: '+8–18%'   },
        { asset: 'TLT',   bias: 'long', factor: 0.90, impact: '+5–10%'   },
        { asset: 'SPY',   bias: 'long', factor: 0.70, impact: '+4–8%'    }
      ]
    },
    {
      id:            'SAUDI_ARAMCO_ATTACK',
      label:         'Major Saudi Aramco Infrastructure Attack',
      regions:       ['MIDDLE EAST', 'SAUDI ARABIA'],
      horizon:       7,
      baseProb:      0.12,
      emitThreshold: 0.20,
      evidenceWeights: {
        energy:    0.35,
        conflict:  0.25,
        satellite: 0.20,
        maritime:  0.20
      },
      assets: [
        { asset: 'WTI',   bias: 'long',  factor: 1.00, impact: '+6–15%'  },
        { asset: 'BRENT', bias: 'long',  factor: 0.95, impact: '+6–14%'  },
        { asset: 'XLE',   bias: 'long',  factor: 0.85, impact: '+4–9%'   }
      ]
    },
    {
      id:            'MULTI_THEATRE_CRISIS',
      label:         'Simultaneous Multi-Theatre Geopolitical Crisis',
      regions:       ['GLOBAL'],
      horizon:       14,
      baseProb:      0.07,
      emitThreshold: 0.14,
      evidenceWeights: {
        escalation: 0.30,
        conflict:   0.25,
        maritime:   0.20,
        narrative:  0.15,
        macro:      0.10
      },
      assets: [
        { asset: 'GLD',   bias: 'long',  factor: 1.00, impact: '+8–18%'  },
        { asset: 'TLT',   bias: 'long',  factor: 0.80, impact: '+5–10%'  },
        { asset: 'SPY',   bias: 'short', factor: 0.85, impact: '−10–20%' },
        { asset: 'WTI',   bias: 'long',  factor: 0.75, impact: '+5–12%'  }
      ]
    }
  ];

  // ── State ─────────────────────────────────────────────────────────────────

  var _signals       = [];
  var _scenarioState = {};  // id → { probability, evidenceScore, prior, supportingAgents, horizon, label }
  var _status = {
    lastPoll:        null,
    scenarioCount:   SCENARIOS.length,
    activeScenarios: [],    // scenarios currently above emitThreshold
    highestScenario: null   // { id, label, probability }
  };
  var _accuracy  = { total: 0, correct: 0, winRate: null };
  var _feedback  = {};  // id → { total, correct, winRate, lastTs }

  // ── Persistence ───────────────────────────────────────────────────────────

  (function _loadFeedback() {
    try {
      var stored = localStorage.getItem(FEEDBACK_KEY);
      if (stored) _feedback = JSON.parse(stored);
    } catch (e) {}
  })();

  function _saveFeedback() {
    try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(_feedback)); } catch (e) {}
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function _pushSignal(sig) {
    sig.timestamp = Date.now();
    _signals.unshift(sig);
    if (_signals.length > MAX_SIGNALS) _signals.length = MAX_SIGNALS;
  }

  // ── Agent signal reader ───────────────────────────────────────────────────
  // Returns region-relevant, age-filtered signals from a named first-order agent.
  // GLOBAL-tagged signals are always included (market-wide relevance).

  function _getAgentSignals(agentName, regions) {
    var globalName = 'GII_AGENT_' + agentName.toUpperCase();
    var agent = window[globalName];
    if (!agent || typeof agent.signals !== 'function') return [];

    var sigs = agent.signals();
    if (!sigs || !sigs.length) return [];

    var now    = Date.now();
    var cutoff = now - AGE_LIMIT_MS;

    return sigs.filter(function (s) {
      // Age filter
      if (s.timestamp && s.timestamp < cutoff) return false;
      // Region filter: GLOBAL signals always pass
      var sigRegion = (s.region || 'GLOBAL').toUpperCase();
      if (sigRegion === 'GLOBAL') return true;
      // Match if scenario region appears in signal region or vice versa
      return regions.some(function (r) {
        return sigRegion.indexOf(r) !== -1 || r.indexOf(sigRegion) !== -1;
      });
    });
  }

  // ── Scenario scorer ───────────────────────────────────────────────────────
  // Returns { evidenceScore, prior, probability, supportingAgents }

  function _scoreScenario(sc) {
    var totalWeight    = 0;
    var weightedConf   = 0;
    var supportingAgents = [];

    Object.keys(sc.evidenceWeights).forEach(function (agentName) {
      var weight   = sc.evidenceWeights[agentName];
      var relevant = _getAgentSignals(agentName, sc.regions);
      if (!relevant.length) return;

      var avgConf = relevant.reduce(function (sum, s) {
        return sum + (s.confidence || 0);
      }, 0) / relevant.length;

      weightedConf += avgConf * weight;
      totalWeight  += weight;
      supportingAgents.push(agentName);
    });

    // Normalised evidence score: 0 (no evidence) → 1 (all agents at full confidence)
    var evidenceScore = totalWeight > 0 ? _clamp(weightedConf / totalWeight, 0, 1) : 0;

    // ── Prior: Bayesian posterior from gii-core (previous cycle) if available
    var prior = sc.baseProb;
    if (window.GII && typeof window.GII.posterior === 'function') {
      sc.regions.forEach(function (r) {
        try {
          var p = window.GII.posterior(r);
          if (p && typeof p.posterior === 'number') {
            // Use GII posterior as a floor — don't let it deflate below baseProb
            var giiPrior = _clamp(p.posterior, sc.baseProb, 0.90);
            if (giiPrior > prior) prior = giiPrior;
          }
        } catch (e) {}
      });
    }

    // ── Final probability: evidence lifts probability above prior
    // Formula: P = prior + evidenceScore × (1 − prior) × 0.65
    // At evidenceScore=0: P = prior (no uplift from agents)
    // At evidenceScore=1: P = prior + 0.65×(1−prior) ≈ prior×0.35 + 0.65
    var rawProb   = prior + evidenceScore * (1.0 - prior) * 0.65;
    var finalProb = _clamp(rawProb, 0.02, 0.93);

    // ── Historical calibration: adjust for this scenario's past accuracy
    if (_feedback[sc.id] && _feedback[sc.id].total >= 5) {
      var wr = _feedback[sc.id].winRate || 0.50;
      // calFactor range: 0.70 (winRate=0) → 1.00 (winRate=0.50) → 1.30 (winRate=1.0)
      var calFactor = 0.70 + wr * 0.60;
      finalProb = _clamp(finalProb * calFactor, 0.02, 0.93);
    }

    return {
      evidenceScore:   evidenceScore,
      prior:           prior,
      probability:     finalProb,
      supportingAgents: supportingAgents
    };
  }

  // ── Main analysis ─────────────────────────────────────────────────────────

  function _analyseScenarios() {
    var activeScenarios = [];
    var highestProb     = 0;
    var highestId       = null;

    SCENARIOS.forEach(function (sc) {
      var result = _scoreScenario(sc);

      // Update scenario state (always, for UI display and getScenario() queries)
      _scenarioState[sc.id] = {
        label:           sc.label,
        probability:     result.probability,
        evidenceScore:   result.evidenceScore,
        prior:           result.prior,
        supportingAgents: result.supportingAgents,
        horizon:         sc.horizon,
        active:          result.probability >= sc.emitThreshold
      };

      // Track highest
      if (result.probability > highestProb) {
        highestProb = result.probability;
        highestId   = sc.id;
      }

      // Only emit signals if scenario probability exceeds threshold
      if (result.probability < sc.emitThreshold) return;

      activeScenarios.push({
        id:              sc.id,
        label:           sc.label,
        probability:     result.probability,
        supportingAgents: result.supportingAgents,
        horizon:         sc.horizon
      });

      var agentLabel = result.supportingAgents.length > 0
        ? result.supportingAgents.slice(0, 3).join('+')
        : 'base-rate-only';

      // Emit one signal per asset, confidence scaled by factor and position index
      sc.assets.forEach(function (assetDef, idx) {
        var rawConf = result.probability * assetDef.factor * 0.82;
        // Modest confidence step-down for non-primary assets
        if (idx > 0) rawConf *= (1.0 - idx * 0.07);
        var conf = _clamp(rawConf, MIN_CONF, MAX_CONF);

        _pushSignal({
          source:          'scenario',
          asset:           assetDef.asset,
          bias:            assetDef.bias,
          confidence:      conf,
          reasoning:       '[SCENARIO: ' + sc.id + '] p=' +
                           (result.probability * 100).toFixed(0) + '% | ' +
                           result.supportingAgents.length + ' agents (' + agentLabel + ') | ' +
                           sc.horizon + 'd | ' + assetDef.impact,
          region:          sc.regions[0],
          // Scenario-specific extra fields (passed through to EE reason string)
          scenario_name:   sc.id,
          scenario_label:  sc.label,
          probability:     result.probability,
          supporting_agents: result.supportingAgents,
          expected_impact: assetDef.impact,
          horizon_days:    sc.horizon,
          // gii-core tags
          _agentName:      'scenario'
        });
      });
    });

    // Sort active scenarios by probability descending for status()
    _status.activeScenarios = activeScenarios.sort(function (a, b) {
      return b.probability - a.probability;
    });
    _status.highestScenario = highestId
      ? { id: highestId, label: _scenarioState[highestId].label, probability: highestProb }
      : null;
  }

  // ── Outcome tracking ──────────────────────────────────────────────────────
  // Called by external callers (e.g. dashboard) to record whether a scenario
  // materialised. Updates per-scenario feedback and overall accuracy stats.

  function recordOutcome(scenarioId, didMaterialise) {
    if (!_feedback[scenarioId]) {
      _feedback[scenarioId] = { total: 0, correct: 0, winRate: null, lastTs: null };
    }
    _feedback[scenarioId].total++;
    if (didMaterialise) _feedback[scenarioId].correct++;
    _feedback[scenarioId].winRate =
      _feedback[scenarioId].correct / _feedback[scenarioId].total;
    _feedback[scenarioId].lastTs = Date.now();

    // Aggregate accuracy across all scenarios
    var totals = Object.keys(_feedback).reduce(function (acc, id) {
      acc.total   += _feedback[id].total;
      acc.correct += _feedback[id].correct;
      return acc;
    }, { total: 0, correct: 0 });
    _accuracy.total   = totals.total;
    _accuracy.correct = totals.correct;
    _accuracy.winRate = totals.total > 0
      ? Math.round((totals.correct / totals.total) * 100) / 100 : null;

    _saveFeedback();
  }

  // ── Public poll ───────────────────────────────────────────────────────────

  function poll() {
    _status.lastPoll = Date.now();
    _analyseScenarios();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.GII_AGENT_SCENARIO = {
    poll:          poll,
    signals:       function () { return _signals.slice(); },
    status:        function () { return Object.assign({}, _status); },
    accuracy:      function () { return Object.assign({}, _accuracy); },
    // Extra — scenario-specific methods
    scenarios:     function () { return Object.assign({}, _scenarioState); },
    getScenario:   function (id) { return _scenarioState[id] || null; },
    recordOutcome: recordOutcome
  };

  window.addEventListener('load', function () {
    // 10.2s delay: starts after all first-order agents have initial signals
    setTimeout(function () {
      poll();
      setInterval(poll, POLL_INTERVAL);
    }, 10200);
  });

})();
