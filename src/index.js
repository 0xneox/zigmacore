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

// Global state
let systemHealth = { posts: 0, marketsMonitored: 0, lastRun: null };
const lastAnalyses = new Map();
let isRunning = false;

// Failure-safe modes
let noSignalCycles = 0;
let isNoSignalMode = false;
let isVolatilityLock = false;
let isLiquidityShock = false;

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

function getBaseRate(question) {
  const q = question.toLowerCase();
  if (/weed.*rescheduled/i.test(q)) return 0.25; // Special for weed
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
  return (bucket[0] + bucket[1]) / 2; // Midpoint for expected prior
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
    return edge > 0.07; // >7% edge flagged for analysis
  }).slice(0, 5);
  log(`DEBUG: Baseline flagged: ${baselineFlagged.length}`);

  // 1. Cumulative Drift (>5% price change)
  const priceSpikes = marketList
    .filter(m => Math.abs(m.priceChange || 0) > 0.05)
    .sort((a, b) => Math.abs(b.priceChange || 0) - Math.abs(a.priceChange || 0));

  log(`DEBUG: Cumulative Drift found: ${priceSpikes.length}`);

  // 2. Volume Velocity (>300% of 1-hour average)
  const volumeSpikes = marketList
    .filter(m => m.vVel > 3 * m.avgVvel && m.avgVvel > 0)
    .sort((a, b) => b.vVel - a.vVel);

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
  }).sort((a, b) => b.volume - a.volume).slice(0, 5);

  log(`DEBUG: Orderbook Imbalance found: ${deltaSnipers.length}`);

  // 4. New Blood Filter: Markets added in last 4 hours
  const newBlood = marketList.filter(m => {
    if (!m.startDateIso) return false;
    const start = new Date(m.startDateIso);
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    return start > fourHoursAgo;
  }).sort((a, b) => b.volume - a.volume).slice(0, 5);

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
  }).slice(0, 5);

  log(`DEBUG: Discovery markets found: ${discovery.length}`);

  // Combine all triggered markets
  let selected = [...baselineFlagged, ...priceSpikes, ...volumeSpikes, ...deltaSnipers, ...newBlood, ...discovery];

  // Remove duplicates
  selected = selected.filter((m, index, self) => index === self.findIndex(s => s.id === m.id));

  // Take top 5
  const selectedFiltered = selected.slice(0, 5);

  return selectedFiltered.slice(0, 5);
}

// --- Main Execution ---

async function runCycle() {
  if (isRunning) return;
  isRunning = true;
  log(`\n--- Agent Zigma Cycle: ${new Date().toISOString()} ---`);
  log(`--- Agent Zigma Cycle: ${new Date().toISOString()} ---`);

  try {
    const rawMarkets = await fetchMarkets(3000);
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
    log(`🎯 Selected ${selectedMarkets.length} markets for deep analysis`);

    // Check NO_SIGNAL_MODE
    if (selectedMarkets.length === 0) {
      noSignalCycles++;
      if (noSignalCycles > 5) isNoSignalMode = true;
    } else {
      noSignalCycles = 0;
      isNoSignalMode = false;
    }

    if (isNoSignalMode) {
      log('NO_SIGNAL_MODE active: no signals for 5+ consecutive cycles, skipping analysis');
      return;
    }

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

        // Time Decay Guardrail: Crush probabilities for complex tasks with insufficient time
        let timeAdjustedProbability = null;
        if (market.endDateIso) {
          const end = new Date(market.endDateIso);
          const now = new Date();
          const daysLeft = (end - now) / (1000 * 60 * 60 * 24);
          if (daysLeft < 30 && (market.question.toLowerCase().includes('reschedule') || market.question.toLowerCase().includes('eo') || market.question.toLowerCase().includes('regulation'))) {
            log(`[GUARDRAIL] Complex task with ${daysLeft.toFixed(1)} days left - crushing probability`);
            timeAdjustedProbability = 0.05; // Hard cap for impossible bets
          }
        }

        const orderBook = await fetchOrderBook(market.id, market.tokens?.[0]?.token_id);
        const newsResults = await crossReferenceNews(market);
        const news = newsResults.slice(0, 5).map(r => ({title: r.title, snippet: r.snippet}));
        log(`Headlines found: ${news.length}`);
        log(`NEWS for ${market.question}: ${news.map(n => n.title).join(' | ')}`);
        const enhanced = await generateEnhancedAnalysis(market, orderBook, news);
        analysis = enhanced;

        // Apply time decay if guardrail triggered
        if (timeAdjustedProbability !== null) {
          analysis.probability = Math.min(analysis.probability, timeAdjustedProbability);
          analysis.reasoning += ` (Time Decay Guardrail applied: ${timeAdjustedProbability})`;
        }
        
        saveAnalysisCache(market.id, livePrice, JSON.stringify(analysis.llmAnalysis), analysis.llmAnalysis.confidence || 50);
      }

      // 1. Force Numeric values
      const confidence = Number(analysis.confidence || 0.5);
      const probability = Number(analysis.probability || 0.5);
      const yesPrice = Number(market.yesPrice || 0.5);
      const dynamicBuffer = yesPrice > 0.8 ? 0.005 : 0.015;
      let action = (analysis.action || 'HOLD').toUpperCase();
      const liquidity = Number(market.liquidity || 0);

      // Normalize confidence to 0-1 if LLM output percentage
      let normalizedConfidence = confidence;
      if (normalizedConfidence > 1) normalizedConfidence /= 100;
      normalizedConfidence = Math.max(0, Math.min(1, normalizedConfidence));

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
        log(`💡 ORACLE INSIGHT: ${market.question.slice(0,30)} -> ${action} (${(probability * 100).toFixed(1)}%)`);
        log(`   Reasoning: ${analysis.reasoning}`);
        fs.appendFileSync(INSIGHTS_FILE, `${new Date().toISOString()}: ${market.question.slice(0,50)} -> ${action} (${(probability * 100).toFixed(1)}%)\nReasoning: ${analysis.reasoning}\n\n`);
        continue;
      } else if (action === 'AVOID') {
        log(`💡 ORACLE INSIGHT: ${market.question.slice(0,30)} -> ${action} (${(probability * 100).toFixed(1)}%)`);
        log(`   Reasoning: ${analysis.reasoning}`);
        fs.appendFileSync(INSIGHTS_FILE, `${new Date().toISOString()}: ${market.question.slice(0,50)} -> ${action} (${(probability * 100).toFixed(1)}%)\nReasoning: ${analysis.reasoning}\n\n`);
        continue;
      } else {
        winProb = probability;
        betPrice = 0.5;
      }

      // Edge Thresholding
      const edge = Math.abs(winProb - yesPrice);
      if (edge < 0.08) {
        action = "NO_TRADE";
        analysis.reasoning = `No measurable mispricing detected\nMarket Odds: ${(yesPrice*100).toFixed(1)}%\nZIGMA Odds: ${(winProb*100).toFixed(1)}%\nEdge: ${(edge*100).toFixed(1)}%`;
      }

      // Temporal Logic Guardrail: Crush probs for regulatory markets with insufficient time
      const daysLeft = (new Date(market.endDateIso) - Date.now()) / (86400000);  // ms to days
      const isRegulatory = /rescheduled|recession|fed|regulation|bill|law/i.test(market.question.toLowerCase());
      if (daysLeft < 30 && isRegulatory) {
        winProb = Math.min(winProb, 0.40);
        if (winProb < 0.10) action = "AVOID";
      }

      // Change HOLD 50% to real AVOID when no edge
      if (action === "HOLD" && winProb === 0.5) {
        action = "AVOID";
        normalizedConfidence = 0.7;
      }

      // Logic flip: If BUY YES but winProb < currentPrice, switch to BUY NO
      if (action === 'BUY YES' && winProb < yesPrice) {
        action = 'BUY NO';
        winProb = 1 - probability;
        betPrice = 1 - yesPrice;
      }

      // Hard rule override for regulatory/end-of-year markets
      if (market.endDateIso && (market.endDateIso.includes("2025") && market.question.toLowerCase().includes("rescheduled") || market.question.toLowerCase().includes("recession") || Date.parse(market.endDateIso) - Date.now() < 30*24*60*60*1000)) {
        winProb = Math.min(winProb, 0.30);  // cap low for short-timeline regulatory
        if (winProb < 0.10) action = "AVOID";
      }

      log(`DEBUG: Market ${market.question.slice(0, 20)}..., yesPrice ${yesPrice}, action ${action}, winProb ${winProb}, betPrice ${betPrice}, liquidity ${liquidity}`);
      // 2. Calculate Kelly with the correct side's price
      let kFraction = calculateKelly(winProb, betPrice, dynamicBuffer, liquidity);
      kFraction = Math.min(0.5 * kFraction, 0.03);  // half Kelly, max 3%
      
      const signal = {
        marketId: market.id,
        action: action,
        price: yesPrice,
        confidence: (normalizedConfidence * 100).toFixed(0),
        kellyFraction: kFraction
      };

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
      }

      const track = `Trade: ${market.question} | Market: ${yesPrice*100}% | Agent: ${winProb*100}% | Action: ${action} | Reason: ${analysis.reasoning} | Outcome: PENDING\n`;

log(`📊 SIGNAL: ${signal.action} (${signal.confidence}%) | Exposure: ${(signal.kellyFraction * 100).toFixed(2)}%`);
fs.appendFileSync(PERSONAL_TRADES_FILE, `${new Date().toISOString()}: ${signal.action} on ${market.question.slice(0,50)} - Confidence: ${signal.confidence}%, Exposure: ${(signal.kellyFraction * 100).toFixed(2)}%\n\n`);

// X Posting logic
if (process.env.SAFE_MODE !== 'true' || (market.volumeVelocity || 0) > 300) {
const tweet = ` AGENT ZIGMA SIGNAL\nMarket: ${market.question.slice(0, 50)}\nMarket Odds (YES): ${(yesPrice*100).toFixed(1)}%\nZIGMA Odds (YES): ${(winProb*100).toFixed(1)}%\nEdge: ${(edge > 0 ? '+' : '')}${(edge*100).toFixed(1)}%\nPrimary Reason: ${analysis.primaryReason || 'NONE'}\nAction: ${action}\nExposure: ${(kFraction * 100).toFixed(1)}%`;
await postToX(tweet);
}
}

// Save snapshot for next velocity check
const newSnapshot = {};
enriched.forEach(m => newSnapshot[m.id] = { volume: m.volume, price: m.yesPrice });
fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(newSnapshot));
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(newSnapshot));

  } catch (error) {
    console.error('CRITICAL CYCLE ERROR:', error);
  } finally {
    isRunning = false;
    log("Agent Zigma: Idle, next cycle in 7 minutes...");
  }
}

// Start Server and Cron
async function main() {
  log('Agent Zigma Initialized');
  startServer();
  
  if (process.env.NODE_ENV === 'development') await runCycle();
  cron.schedule('*/7 * * * *', runCycle);
}

main();