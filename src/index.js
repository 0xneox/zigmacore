const fs = require('fs');
const path = require('path');
require('dotenv').config();

const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const log = (msg) => { 
  fs.appendFileSync(CONSOLE_LOG_FILE, msg + '\n');
  if (LOG_LEVEL === 'DEBUG') console.log(msg); 
};

const cron = require('node-cron');
const { fetchMarkets } = require('./fetcher');
const { computeMetrics } = require('./utils/metrics');
const { savePriceCache, loadCache, saveAnalysisCache, getAnalysisCache, saveTradeSignal } = require('./db');
const { generateDecrees, generateEnhancedAnalysis } = require('./llm');
const { postToX } = require('./poster');
const { calculateKelly } = require('./market_analysis');
const { getClobPrice, startPolling, getOrderBook, fetchOrderBook } = require('./clob_price_cache');
const { startServer, updateHealthMetrics } = require('../server'); // Fixed path to root
const { crossReferenceNews } = require('./processor');

const INSIGHTS_FILE = path.join(__dirname, '..', 'oracle_insights.txt');
const CONSOLE_LOG_FILE = path.join(__dirname, '..', 'console_output.log');
const PERSONAL_TRADES_FILE = path.join(__dirname, '..', 'personal_trades.txt');
const TRACK_LOG_FILE = path.join(__dirname, '..', 'trades.log');
const AUDIT_LOG_FILE = path.join(__dirname, '..', 'audit_trails.log');
const SNAPSHOT_FILE = path.join(__dirname, '..', 'cache', 'last_snapshot.json');

const GROUP_DEFINITIONS = {
  top_ai_2025: [
    "Will Google have the top AI model",
    "Will xAI have the top AI model",
    "Will OpenAI have the top AI model",
    "Will Anthropic have the top AI model",
    "Will Meta have the top AI model",
    "this year",
    "Dec 31"
  ],
  spacex_launches_2025: [
    "SpaceX launches in 2025: 160–179",
    "SpaceX launches in 2025: 180–199",
    "SpaceX launches in 2025: 200–219",
    "SpaceX launches in 2025: 220–239",
    "SpaceX launches in 2025: 240–259"
  ]
};

const DAY_MS = 24 * 60 * 60 * 1000;
const PROBABILITY_FLOOR = 0.0001;

// Global state
let systemHealth = { posts: 0, marketsMonitored: 0, lastRun: null };
const lastAnalyses = new Map();
let isRunning = false;

// Portfolio simulation
let portfolio = { balance: 1000, positions: {}, pnl: 0 };

// Failure-safe modes
let noSignalCycles = 0;
let isNoSignalMode = false;
let isVolatilityLock = false;
let isLiquidityShock = false;
let activeGroupSizes = {};

// --- Helper Functions ---

function classifyMarket(question) {
  const q = question.toLowerCase();
  if (/bitcoin|ethereum|btc|eth|crypto|solana|bnb/i.test(q)) return "CRYPTO";
  if (/recession|inflation|fed|gdp|economy/i.test(q)) return "MACRO";
  if (/election|president|trump|biden|political/i.test(q)) return "POLITICAL";
  return "EVENT";
}

function settlementRisk(question) {
  if (!question) return 'MEDIUM';
  const q = question.toLowerCase();
  if (/will.*win|who.*win|best.*movie/i.test(q)) return 'HIGH';
  if (/price.*above|will.*reach/i.test(q) && /\$.*\d+/i.test(q)) return 'LOW';
  return 'MEDIUM';
}

function getBaseRate(question, market = null) {
  const q = question.toLowerCase();
  if (/weed.*rescheduled/i.test(q)) return 0.25; // Special for weed

  if (activeGroupSizes[q]) {
    const groupSize = Math.max(1, activeGroupSizes[q]);
    return Math.max(0.01, 1 / groupSize);
  }

  // Multinomial priors
  if (/top ai model/i.test(q)) return 0.2; // 1/5 for AI companies
  if (/spacex launches in 2025/i.test(q)) return 0.2; // 1/5 for launch bins

  const PRIOR_BUCKETS = {
    MACRO: [0.10, 0.30],
    POLITICS: [0.05, 0.20],
    CELEBRITY: [0.02, 0.10],
    TECH_ADOPTION: [0.10, 0.40],
    ETF_APPROVAL: [0.20, 0.60],
    WAR_OUTCOMES: [0.05, 0.25],
    SPORTS_FUTURES: [0.02, 0.15]
  };

  // Simple classify
  const qLower = question.toLowerCase();
  let category = 'OTHER';
  if (/recession|inflation|fed|gdp|economy/i.test(qLower)) category = 'MACRO';
  if (/election|president|trump|biden|political/i.test(qLower)) category = 'POLITICS';
  if (/celebrity|britney|tour|concert|divorce/i.test(qLower)) category = 'CELEBRITY';
  if (/bitcoin|btc|crypto|tech|adoption/i.test(qLower)) category = 'TECH_ADOPTION';
  if (/etf|approval/i.test(qLower)) category = 'ETF_APPROVAL';
  if (/war|ukraine|russia|ceasefire/i.test(qLower)) category = 'WAR_OUTCOMES';
  if (/sports|game|win/i.test(qLower)) category = 'SPORTS_FUTURES';

  const bucket = PRIOR_BUCKETS[category] || [0.05, 0.20]; // Default conservative
  let prior = (bucket[0] + bucket[1]) / 2; // Midpoint for expected prior

  // Bayesian updating: Adjust prior based on market price if available
  if (market && market.yesPrice) {
    const observedPrice = market.yesPrice;
    const edge = observedPrice - prior;
    // Simple update: move prior towards observed price by 10% of edge
    prior += edge * 0.1;
    prior = Math.max(0.01, Math.min(0.99, prior)); // Clamp
  }

  return prior;
}

function getYesNoPrices(market) {
  const clobPrice = getClobPrice(market.id);
  if (clobPrice && clobPrice > 0 && clobPrice < 1) return { yes: clobPrice, no: 1 - clobPrice };

  if (market.outcomePrices && market.outcomePrices.length >= 2) {
    let yes = parseFloat(market.outcomePrices[0]);
    let no = parseFloat(market.outcomePrices[1]);
    if (yes > 1) yes /= 100;
    if (no > 1) no /= 100;
    // Swap if sum > 2 (percentage format, assuming [no, yes])
    if (yes + no > 2) {
      let temp = yes;
      yes = no;
      no = temp;
    }
    return { yes, no };
  }
  return null;
}

function computeGroupSizeMap(markets) {
  const map = {};
  for (const patterns of Object.values(GROUP_DEFINITIONS)) {
    const members = markets.filter(m => patterns.some(pattern => m.question.includes(pattern)));
    ze = members.length || patterns.length;
    members.forEach(m => {
      map[m.question.toLowerCase()] = Math.max(1, ze);
    });
  }
  return map;
}

function applyTimeDecay(probability, market, analysis) {
  if (!market || !market.endDateIso) return probability;

  const endMs = Date.parse(market.endDateIso);
  if (Number.isNaN(endMs)) return probability;
  const now = Date.now();
  const timeLeftMs = endMs - now;
  if (timeLeftMs <= 0) return probability;

  let totalMs = null;
  if (market.startDateIso) {
    const startMs = Date.parse(market.startDateIso);
    if (!Number.isNaN(startMs) && endMs > startMs) {
      totalMs = endMs - startMs;
    }
  }
  if (!totalMs) totalMs = 180 * DAY_MS;

  const progress = 1 - Math.min(1, timeLeftMs / totalMs);
  const penalty = Math.min(0.15, progress * 0.15);
  if (penalty <= 0) return probability;

  // Guard: Never flip dominant outcomes
  if (market && market.yesPrice > 0.9) {
    penalty = Math.min(penalty, 0.05);
  }

  if (analysis) {
    analysis.deltas = analysis.deltas || {};
    analysis.deltas.time = -(penalty * 100);
  }
  return probability - penalty;
}

function ensureProbability(analysis, market) {
  if (!analysis) return 0.5;
  let prob = analysis.probability;
  if (typeof prob !== 'number') {
    prob = analysis.llmAnalysis?.probability;
  }
  if (typeof prob !== 'number') {
    prob = market?.yesPrice ?? 0.5;
  }

  prob = applyTimeDecay(prob, market, analysis);

  // Guard: Boost dominant favorites damaged by structural penalty
  if (market && market.yesPrice > 0.9 && analysis.deltas && analysis.deltas.struct < -0.1) {
    prob = Math.min(0.99, prob + 0.1);
    analysis.deltas.struct = Math.max(analysis.deltas.struct, -0.05);
  }

  // Final clamp
  prob = Math.min(0.99, Math.max(PROBABILITY_FLOOR, prob));

  analysis.probability = prob;
  return prob;
}

// --- Alpha Selection Logic ---

function pickHighAlphaMarkets(data) {
  // Ensure we have an array
  const marketList = Array.isArray(data) ? data : (data?.enriched || []);
  if (marketList.length === 0) return [];

  log(`DEBUG: Markets input: ${marketList.length}`);

  // 0. Baseline Edge Scan (static mispricing detection)
  log(`DEBUG: Baseline edge scan`);
  const baselineFlagged = marketList.filter(m => {
    const pPrior = getBaseRate(m.question);
    const edge = Math.abs(pPrior - m.yesPrice);
    log(`DEBUG: ${m.question.slice(0, 30)}... P_market: ${m.yesPrice.toFixed(3)}, P_prior: ${pPrior.toFixed(3)}, EDGE: ${(edge*100).toFixed(1)}%`);
    return edge > 0.05 && m.liquidity > 50000; // Harden filter
  }).slice(0, 15);
  log(`DEBUG: Baseline flagged: ${baselineFlagged.length}`);

  // 1. Cumulative Drift (>5% price change)
  const priceSpikes = marketList
    .filter(m => Math.abs(m.priceChange || 0) > 0.05)
    .sort((a, b) => Math.abs(b.priceChange || 0) - Math.abs(a.priceChange || 0))
    .slice(0, 15);

  log(`DEBUG: Cumulative Drift found: ${priceSpikes.length}`);

  // 2. Volume Velocity (>300% of 1-hour average)
  const volumeSpikes = marketList
    .filter(m => m.vVel > 3 * m.avgVvel && m.avgVvel > 0)
    .sort((a, b) => b.vVel - a.vVel)
    .slice(0, 15);

  log(`DEBUG: Volume Velocity found: ${volumeSpikes.length}`);

  // 3. Orderbook Imbalance (high-liquidity >2% move in 5min, low-liquidity >10%)
  const deltaSnipers = marketList.filter(m => {
    const history = m.priceHistory || [];
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    const recent5min = history.filter(h => h.timestamp > fiveMinutesAgo);
    if (recent5min.length < 2) return false;
    const prices = recent5min.map(h => h.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const delta = Math.abs(maxPrice - minPrice) / minPrice;
    return m.liquidity > 100000 ? delta > 0.02 : delta > 0.10;
  }).sort((a, b) => b.volume - a.volume).slice(0, 15);

  log(`DEBUG: Orderbook Imbalance found: ${deltaSnipers.length}`);

  // 4. New Blood Filter: Markets added in last 4 hours
  const newBlood = marketList.filter(m => {
    if (!m.startDateIso) return false;
    const start = new Date(m.startDateIso);
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    return start > fourHoursAgo;
  }).sort((a, b) => b.volume - a.volume).slice(0, 15);

  log(`DEBUG: New Blood markets found: ${newBlood.length}`);

  // 5. Discovery Phase: Markets with high volume/days since created (top fresh hype)
  const now = Date.now();
  const discovery = marketList.filter(m => {
    if (!m.startDateIso) return false;
    const days = (now - new Date(m.startDateIso)) / (1000 * 60 * 60 * 24);
    if (days <= 0) return false;
    return true;
  }).sort((a, b) => {
    const daysA = (now - new Date(a.startDateIso)) / (1000 * 60 * 60 * 24);
    const daysB = (now - new Date(b.startDateIso)) / (1000 * 60 * 60 * 24);
    return (b.volume / daysB) - (a.volume / daysA);
  }).slice(0, 15);

  log(`DEBUG: Discovery markets found: ${discovery.length}`);

  // 6. Trend Detection: Markets with upward/downward price trends
  const trends = marketList.filter(m => {
    const history = m.priceHistory || [];
    if (history.length < 5) return false;
    const recent = history.slice(-5);
    const prices = recent.map(h => h.price);
    const trend = prices.reduce((acc, price, i) => {
      if (i === 0) return acc;
      return acc + (price - prices[i-1]);
    }, 0) / (prices.length - 1);
    return Math.abs(trend) > 0.01; // >1% average trend
  }).sort((a, b) => {
    const aTrend = detectTrend(a);
    const bTrend = detectTrend(b);
    return Math.abs(bTrend) - Math.abs(aTrend);
  }).slice(0, 15);

  log(`DEBUG: Trend markets found: ${trends.length}`);

  // Combine all triggered markets
  let selected = [...baselineFlagged, ...priceSpikes, ...volumeSpikes, ...deltaSnipers, ...newBlood, ...discovery, ...trends];

  // Remove duplicates
  selected = selected.filter((m, index, self) => index === self.findIndex(s => s.id === m.id));

  // Reduce noise: Filter out low-edge celebrity/politics
  selected = selected.filter(m => {
    const pPrior = getBaseRate(m.question);
    const edge = Math.abs(pPrior - m.yesPrice);
    if (m.category === 'CELEBRITY' && edge < 0.20) return false;
    if (m.category === 'POLITICAL' && edge < 0.20) return false;
    return true;
  });

  // Take top 15
  const selectedFiltered = selected.slice(0, 15);

  return selectedFiltered.slice(0, 15);
}

// --- Main Execution ---

async function runCycle() {
  let markets = [];
  if (isRunning) return;
  isRunning = true;
  log(`\n--- Agent Zigma Cycle: ${new Date().toISOString()} ---`);

try {
  const limit = parseInt(process.env.GAMMA_LIMIT) || 500;
  const rawMarkets = await fetchMarkets(limit);
  markets = rawMarkets; // Assign here
  let lastSnapshot = {};
  if (fs.existsSync(SNAPSHOT_FILE)) {
    lastSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  }

  // Process metrics and extract the array correctly
  const result = await computeMetrics(rawMarkets, lastSnapshot);
  const enriched = result;
  
  // Update local price mapping
  enriched.forEach(m => {
    const prices = getYesNoPrices(m);
    if (prices) {
      m.yesPrice = prices.yes;
      m.noPrice = prices.no;
      m.settlementRisk = settlementRisk(m.question);
      m.category = classifyMarket(m.question);

      // Structural Arbitrage Detection
      if (m.yesPrice + m.noPrice !== 1) {
        log(`ARBITRAGE ALERT: ${m.question} YES+NO ≠1 (vig: ${(1 - (m.yesPrice + m.noPrice)).toFixed(2)})`);
        // flag for LLM: reasoning += ` | Structural vig arbitrage`;
      }
      if (m.endDateIso) {
        const timeLeft = new Date(m.endDateIso) - Date.now();
        if (timeLeft < 86400000 * 14 && m.yesPrice > 0.50) {
          m.yesPrice = Math.min(m.yesPrice, 0.50);  // time decay error cap
        }
      }
    }
  });

  // Calculate failure-safe modes
  const avgVolatility = enriched.reduce((sum, m) => sum + (m.priceVolatility || 0), 0) / enriched.length;
  const avgLiquidity = enriched.reduce((sum, m) => sum + (m.liquidity || 0), 0) / enriched.length;
  isVolatilityLock = avgVolatility > 0.1; // >10% average volatility
  isLiquidityShock = avgLiquidity < 50000; // <50k average liquidity

  const selectedMarkets = pickHighAlphaMarkets(enriched).filter(m => (m.volume || 0) > 1000);
  log(` Selected ${selectedMarkets.length} markets for deep analysis`);

  activeGroupSizes = computeGroupSizeMap(selectedMarkets);

  // Check NO_SIGNAL_MODE
  if (selectedMarkets.length === 0) {
    noSignalCycles++;
    if (noSignalCycles > 5) isNoSignalMode = true;
  } else {
    noSignalCycles = 0;
    isNoSignalMode = false;
  }


// Collect raw analyses
const rawSignalData = [];
let signalsGenerated = 0;
for (const market of selectedMarkets) {
    const livePrice = getClobPrice(market.id) || market.yesPrice;
    const cached = getAnalysisCache(market.id);
    let analysis;

    if (cached) {
        const delta = Math.abs(((livePrice - cached.last_price) / cached.last_price) * 100);
        log(`[CACHE] ${market.question.slice(0, 30)}... Delta: ${delta.toFixed(2)}%`);
        if (delta <= 0 && Date.now() - cached.timestamp <= 5 * 60 * 1000) {
            analysis = JSON.parse(cached.reasoning);
        }
    }

    if (!analysis) {
        const pBucketPrior = getBaseRate(market.question);
        if (Math.abs(market.yesPrice - pBucketPrior) < 0.05) {
            log(`Skipping analysis: market price too close to bucket prior (${(Math.abs(market.yesPrice - pBucketPrior)*100).toFixed(1)}% < 5%)`);
            continue;
        }

        log(`[LLM] Analyzing: ${market.id} - ${market.question}`);

        // LLM guardrail removed - allow regulated markets

        const orderBook = await fetchOrderBook(market.id, market.tokens?.[0]?.token_id);
        const newsResults = await crossReferenceNews(market);
        const news = newsResults.slice(0, 5).map(r => ({title: r.title, snippet: r.snippet}));
        log(`Headlines found: ${news.length}`);
        log(`NEWS for ${market.question}: ${news.map(n => n.title).join(' | ')}`);
        const enhanced = await generateEnhancedAnalysis(market, orderBook, news);
        analysis = enhanced;

        saveAnalysisCache(market.id, livePrice, JSON.stringify(analysis.llmAnalysis), analysis.llmAnalysis.confidence || 50);
    }

    ensureProbability(analysis, market);
    rawSignalData.push({ market, analysis });
}

// Mutual exclusion groups
const groups = {
    "top_ai_2025": ["Will Google have the top AI model", "Will xAI have the top AI model", "Will OpenAI have the top AI model", "Will Anthropic have the top AI model", "Will Meta have the top AI model", "this year", "Dec 31"],
    "spacex_launches_2025": ["SpaceX launches in 2025: 160–179", "SpaceX launches in 2025: 180–199", "SpaceX launches in 2025: 200–219", "SpaceX launches in 2025: 220–239", "SpaceX launches in 2025: 240–259"]
}

// Mutual exclusion normalization
for (const groupName in groups) {
    const groupStrings = groups[groupName];
    const groupData = rawSignalData.filter(d => groupStrings.some(s => d.market.question.includes(s)));
    const sum = groupData.reduce((s, d) => s + (d.analysis ? d.analysis.probability : 0), 0);
    log(`Group ${groupName} sum before normalization: ${sum.toFixed(3)}`);
    if (sum === 0) {
        log(`Skipping normalization for empty group ${groupName}`);
        continue;
    }
    if (sum > 0) {
        groupData.forEach(d => {
            if (d.analysis) d.analysis.probability /= sum;
        });
    }
    const newSum = groupData.reduce((s, d) => s + (d.analysis ? d.analysis.probability : 0), 0);
    if (Math.abs(newSum - 1.0) > 0.01) {
      if (console && console.error) {
        console.error(`❌ GROUP NORMALIZATION FAILED for ${groupName}, sum: ${newSum}`);
      }
    }

    // Group-level action gating
    if (groupData.length > 0) {
        groupData.sort((a, b) => (b.analysis ? b.analysis.probability : 0) - (a.analysis ? a.analysis.probability : 0));
        // Log normalized probabilities table
        console.table(
          groupData.map(d => ({
            market: d.market.question.slice(0, 30),
            winProb: ((d.analysis ? d.analysis.probability : 0) * 100).toFixed(2) + "%",
            action: d.forcedAction || "HOLD"
          }))
        );
        groupData.forEach((d, idx) => {
          const prob = d.analysis ? d.analysis.probability : 0;
          if (idx === 0 && prob > 0.03) { // Use threshold
            d.forcedAction = "BUY YES";
          } else {
            d.forcedAction = "BUY NO";
          }
        });
        // Group summary log
        if (groupData.length > 0) {
          const winner = groupData[0];
          const alt = groupData[1];
          const outlier = groupData.slice(2).map(d => d.market.question.slice(0,10)).join(', ');
          log(`${groupName.toUpperCase()} GROUP SUMMARY: Winner: ${winner.market.question.slice(0,20)} (${(winner.analysis.probability*100).toFixed(1)}%), Alt: ${alt ? alt.market.question.slice(0,20) : 'None'} (${alt ? (alt.analysis.probability*100).toFixed(1) : 0}%), Outlier: ${outlier}`);
        }
    }
}

// Process each market
for (const data of rawSignalData) {
const market = data.market;
const analysis = data.analysis;
const confidence = analysis.confidenceScore || 0;
let action = analysis.action || 'HOLD';
const probability = analysis.probability || 0;
const yesPrice = market.yesPrice || 0;

let dynamicBuffer = yesPrice > 0.8 ? 0.005 : 0.015;
let normalizedConfidence = confidence;
if (normalizedConfidence > 1) normalizedConfidence /= 100;
normalizedConfidence = Math.max(0, Math.min(1, normalizedConfidence));
if (normalizedConfidence > 0.8) normalizedConfidence = Math.max(normalizedConfidence, 0.9);  // Boost for strong signals

let winProb, betPrice;

    if (action === 'BUY YES') {
        // Betting on YES
        winProb = probability;
        betPrice = yesPrice;
    } else if (action === 'BUY NO') {
        // Betting on NO
        winProb = 1 - probability;
        betPrice = 1 - yesPrice;
    } else if (action.startsWith('BIAS')) {
        // Directional insight with small edge
        log(` ORACLE INSIGHT: ${market.question.slice(0,30)} -> ${action} (${(probability * 100).toFixed(1)}%)`);
        log(`   Reasoning: ${analysis.reasoning}`);
        fs.appendFileSync(INSIGHTS_FILE, `${new Date().toISOString()}: ${market.question.slice(0,50)} -> ${action} (${(probability * 100).toFixed(1)}%)\nReasoning: ${analysis.reasoning}\n\n`);
        continue;
    } else if (action === 'AVOID') {
        log(` ORACLE INSIGHT: ${market.question.slice(0,30)} -> ${action} (${(probability * 100).toFixed(1)}%)`);
        log(`   Reasoning: ${analysis.reasoning}`);
        fs.appendFileSync(INSIGHTS_FILE, `${new Date().toISOString()}: ${market.question.slice(0,50)} -> ${action} (${(probability * 100).toFixed(1)}%)\nReasoning: ${analysis.reasoning}\n\n`);
        continue;
    } else {
        winProb = probability;
        betPrice = 0.5;
    }

    // Calculate raw edge and effective edge (survivable edge)
    let rawEdge = Math.abs(winProb - yesPrice);
    rawEdge = Math.min(rawEdge, 0.35); // Cap at 35% to avoid extreme artifacts
    const entropy = analysis.entropy || 0.1;
    let entropyPenalty = 1 / (entropy + 0.1);
    if (market.liquidity > 100000) entropyPenalty *= 0.2;  // Lower penalty for high-liq markets
    const effectiveEdge = rawEdge * normalizedConfidence * entropyPenalty * (market.liquidity > 0 ? Math.min(market.liquidity / 50000, 1) : 1); // Cap at 50k

    // === INTENT EXPOSURE (DISPLAY-ONLY, HONEST) ===
    let intentExposure = 0;
    if (effectiveEdge >= 0.03) {
      intentExposure = Math.min(3.0, Math.max(0.25, effectiveEdge * 40));
    }

    // Edge Thresholding using effective edge
    if (effectiveEdge < 0.03) {  // Lower to 3% for signals
        action = "NO_TRADE";
        intentExposure = 0;
        analysis.reasoning = `No measurable survivable mispricing detected\nMarket Odds: ${(yesPrice*100).toFixed(1)}%\nZIGMA Odds: ${(winProb*100).toFixed(1)}%\nEffective Edge: ${(effectiveEdge*100).toFixed(1)}%`;
    }

    // Confidence override for high-edge markets: if edge > 3% and confidence >= 70%, force BUY/SELL
    if (effectiveEdge > 0.03 && normalizedConfidence >= 0.70) {
      action = winProb > yesPrice ? "BUY YES" : "BUY NO";
      analysis.reasoning = `High edge detected with strong confidence\nMarket Odds: ${(yesPrice*100).toFixed(1)}%\nZIGMA Odds: ${(winProb*100).toFixed(1)}%\nEffective Edge: ${(effectiveEdge*100).toFixed(1)}%\nConfidence Override Applied`;
    }

    // Update winProb and betPrice based on action
    // Logic flip: If BUY YES but winProb < currentPrice, switch to BUY NO
    if (action === 'BUY YES' && winProb < yesPrice) {
        action = 'BUY NO';
        winProb = 1 - probability;
        betPrice = 1 - yesPrice;
    }

    // Group-level forced action
    if (data.forcedAction) {
        action = data.forcedAction;
        if (action === 'BUY YES') {
            winProb = probability;
            betPrice = yesPrice;
        } else if (action === 'BUY NO') {
            winProb = 1 - probability;
            betPrice = 1 - yesPrice;
        }
    }
    if (normalizedConfidence >= 0.7) confidenceClass = 'HIGH';
    else if (normalizedConfidence >= 0.4) confidenceClass = 'MEDIUM';

    if (action === 'BUY YES' || action === 'BUY NO') signalsGenerated++;

    const signal = {
        marketId: market.id,
        action: action,
        price: yesPrice,
        confidence: (normalizedConfidence * 100).toFixed(0),
        confidenceClass: confidenceClass,
        intentExposure: intentExposure
    };

    // Runtime assert for non-zero intent exposure on signals and overflow
    if (signal.intentExposure > 10) {
      throw new Error(`Exposure overflow: ${signal.intentExposure}% for ${signal.marketId}`);
    }
    if (signal.action !== 'NO_TRADE' && signal.intentExposure === 0) {
      console.warn("⚠️ Non-zero signal with zero intent exposure", signal.marketId);
    }

    // Audit trail logging for signals
    if (signal.action === "BUY YES" || signal.action === "BUY NO") {
        const auditEntry = {
            marketId: signal.marketId,
            timestamp: new Date().toISOString(),
            P_market: yesPrice,
            P_prior_bucket: analysis.pPrior,
            P_zigma: analysis.probability,
            deltas: analysis.deltas,
            entropy: analysis.entropy,
            confidence: analysis.confidenceScore,
            final_edge: analysis.effectiveEdge,
            final_decision: signal.action
        };
        fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(auditEntry) + '\n');

        // P&L Simulation removed - signal only
    }

    const track = `Trade: ${market.question} | Market: ${yesPrice*100}% | Agent: ${winProb*100}% | Action: ${action} | Reason: ${analysis.reasoning} | Outcome: PENDING\n`;

    log(` SIGNAL: ${signal.action} (${signal.confidence}%) | Exposure: ${signal.intentExposure.toFixed(2)}%`);
    log(`Effective Edge: ${(effectiveEdge * 100).toFixed(2)}% (raw ${(rawEdge*100).toFixed(1)}%, conf ${(normalizedConfidence*100).toFixed(1)}, entropy ${entropy.toFixed(3)}, liqFactor ${(market.liquidity > 0 ? Math.min(market.liquidity / 50000, 1) : 1).toFixed(3)})`);
    fs.appendFileSync(PERSONAL_TRADES_FILE, `${new Date().toISOString()}: ${signal.action} on ${market.question.slice(0,50)} - Confidence: ${signal.confidence}%, Exposure: ${signal.intentExposure.toFixed(2)}%\n\n`);

    // Remove SAFE_MODE, signal-only
    if (process.env.SAFE_MODE !== 'true' || (market.volumeVelocity || 0) > 300) {
        const tweet = ` AGENT ZIGMA SIGNAL
Market: ${market.question.slice(0, 50)}
Market Odds (YES): ${(yesPrice*100).toFixed(1)}%
ZIGMA Odds (YES): ${(winProb*100).toFixed(1)}%
Edge: ${(rawEdge > 0 ? '+' : '')}${(rawEdge*100).toFixed(1)}%
Primary Reason: ${analysis.primaryReason || 'NONE'}
Action: ${action}
Exposure: ${signal.intentExposure.toFixed(1)}%`;
      await postToX(tweet);
  }
}

    updateHealthMetrics({ lastRun: new Date().toISOString(), marketsMonitored: selectedMarkets.length, posts: signalsGenerated });
    console.log("✅ Cycle complete, awaiting next action");
} catch (error) {
  console.error('CRITICAL CYCLE ERROR:', error);
  isRunning = false;
  log("Agent Zigma: Idle, next cycle per schedule...");
}
}

 // Start Server and Cron
async function main() {
  log('Agent Zigma Initialized');
  startServer();
  setInterval(() => console.log(" Zigma heartbeat", new Date().toISOString()), 30000);
  
  if (process.env.NODE_ENV === 'development') await runCycle();
  cron.schedule(process.env.CRON_SCHEDULE || '*/7 * * * *', runCycle);
}

main();