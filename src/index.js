const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
require('dotenv').config();

// Create write streams for logging to prevent file descriptor leaks
const CONSOLE_LOG_FILE = path.join(__dirname, '..', 'console_output.log');
const consoleLogStream = fsSync.createWriteStream(CONSOLE_LOG_FILE, { flags: 'a' });

// Add error handler to prevent unhandled stream errors
consoleLogStream.on('error', (err) => {
  originalConsoleError('[STREAM ERROR]', err.message);
  // Attempt to recreate stream
  try {
    consoleLogStream.end();
  } catch (e) {
    // Ignore errors during cleanup
  }
});

// Cleanup function to properly close streams
const cleanupStreams = () => {
  if (consoleLogStream && !consoleLogStream.destroyed) {
    try {
      consoleLogStream.end();
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
};

// Ensure streams are closed on process exit
process.on('exit', cleanupStreams);
process.on('SIGINT', () => {
  cleanupStreams();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupStreams();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  originalConsoleError('[UNCAUGHT]', err);
  cleanupStreams();
  process.exit(1);
});

// Simple console override - write directly to avoid logger circular dependency
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

console.log = function(...args) {
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  originalConsoleLog(msg);
  // Write to stream instead of appendFile to prevent file descriptor leaks
  consoleLogStream.write(`[${new Date().toISOString()}] ${msg}\n`);
};

console.error = function(...args) {
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  originalConsoleError(`[ERROR] ${msg}`);
};

console.warn = function(...args) {
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  originalConsoleWarn(`[WARN] ${msg}`);
};

const { BoundedMap } = require('./utils/bounded-map');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const INSIGHTS_FILE = path.join(__dirname, '..', 'oracle_insights.txt');
const PERSONAL_TRADES_FILE = path.join(__dirname, '..', 'personal_trades.txt');
const TRACK_LOG_FILE = path.join(__dirname, '..', 'trades.log');
const AUDIT_LOG_FILE = path.join(__dirname, '..', 'audit_trails.log');
const SNAPSHOT_FILE = path.join(CACHE_DIR, 'last_snapshot.json');
const CATEGORY_PERFORMANCE_FILE = path.join(CACHE_DIR, 'category_performance.json');
const CYCLE_SNAPSHOT_FILE = path.join(CACHE_DIR, 'latest_cycle.json');
const CYCLE_HISTORY_FILE = path.join(CACHE_DIR, 'cycle_history.json');

// Log level filtering system to reduce production overhead
// Levels: DEBUG (0) < INFO (1) < WARN (2) < ERROR (3)
// Set LOG_LEVEL=DEBUG for development, LOG_LEVEL=INFO for production
// Usage: log('message', 'DEBUG') - only executes if level >= current threshold
const RAW_LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const NORMALIZED_LOG_LEVEL = RAW_LOG_LEVEL.split('#')[0].trim().toUpperCase();
const LOG_LEVEL_NUM = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const ACTIVE_LOG_LEVEL = LOG_LEVEL_NUM[NORMALIZED_LOG_LEVEL] != null ? NORMALIZED_LOG_LEVEL : 'INFO';
const CURRENT_LOG_LEVEL = LOG_LEVEL_NUM[ACTIVE_LOG_LEVEL];

const log = (msg, level = 'INFO') => {
  const normalizedLevel = (level || 'INFO').toUpperCase();
  const levelValue = LOG_LEVEL_NUM[normalizedLevel] ?? LOG_LEVEL_NUM.INFO;
  if (levelValue >= CURRENT_LOG_LEVEL) {
    const timestamped = `[${new Date().toISOString()}] [${normalizedLevel}] ${msg}`;
    // Write to stream instead of appendFile to prevent file descriptor leaks
    consoleLogStream.write(timestamped + '\n');
    // Always output to console immediately for visibility - use original console to avoid circular dependency
    originalConsoleLog(timestamped);
  }
};

const cron = require('node-cron');

const { fetchAllMarkets, fetchTags, fetchSearchMarkets } = require('./fetcher');
const { computeMetrics } = require('./utils/metrics');
const { savePriceCache, loadCache, saveAnalysisCache, getAnalysisCache, saveTradeSignal } = require('./db');
const { generateDecrees, generateEnhancedAnalysis, computeNetEdge } = require('./llm');
const { applyAdaptiveLearning } = require('./adaptive-learning');
const { postToX } = require('./poster');
const { calculateKelly } = require('./market_analysis');
const { getClobPrice, startPolling, getOrderBook, fetchOrderBook } = require('./clob_price_cache');
const { startServer, updateHealthMetrics } = require('../server');
const { crossReferenceNews } = require('./processor');
const { startResolutionTracker, getCategoryEdgeAdjustment } = require('./resolution_tracker');
let createClient;
try {
  createClient = require('@supabase/supabase-js').createClient;
} catch (e) {
  console.log('Supabase not installed, skipping...');
  createClient = null;
}
const { classifyMarket } = require('./utils/classifier');
const {
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateMaxDrawdown,
  calculateVaR,
  calculateCVaR,
  calculateCalmarRatio,
  ensembleAverage
} = require('./utils/risk-metrics');
const {
  checkPositionConcentration,
  checkSectorExposure,
  estimateSlippage,
  calculateSpreadImpact,
  calculateTotalTradeCost,
  checkTradeRisk,
  calculatePortfolioRisk
} = require('./utils/risk-management');
const {
  calculateAccuracyMetrics,
  calculateWinLossRatio,
  calculateConfidenceCalibration,
  calculateCategoryPerformance,
  calculateTimeOfDayAnalysis,
  generateAnalyticsReport
} = require('./utils/analytics');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseKey && createClient) ? createClient(supabaseUrl, supabaseKey) : null;

const ensureCacheDir = async () => {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to ensure cache directory:', err.message);
  }
};
ensureCacheDir().catch(console.error);

const loadJsonFile = (filePath, fallback) => {
  try {
    if (!fsSync.existsSync(filePath)) return fallback;
    const raw = fsSync.readFileSync(filePath, 'utf8');
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to load JSON from ${filePath}:`, err.message);
    return fallback;
  }
};
const saveJsonFile = async (filePath, data) => {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to persist JSON to ${filePath}:`, err.message);
  }
};

const trimArray = (value, limit = 25) =>
  Array.isArray(value) ? value.slice(0, Math.max(0, limit)) : [];

function computeHorizonDiscount(daysToResolution) {
  if (daysToResolution <= 0) return 1.0;
  if (daysToResolution < 7) return 1.0; // No discount for <1 week
  if (daysToResolution < 30) return 0.95;
  if (daysToResolution < 90) return 0.90;
  if (daysToResolution < 180) return 0.85;
  return 0.80; // Max 20% discount for long-term
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PROBABILITY_FLOOR = 0.0001;
const POLYMARKET_BASE_URL = 'https://polymarket.com';

const EDGE_THRESHOLD = 0.05; // 5% edge threshold (decimal)

const UNCERTAINTY_MARGIN = 0.15; // Margin for confidence intervals
const LOW_LIQUIDITY_THRESHOLD = 50000; // Below this is considered low liquidity
const HIGH_LIQUIDITY_THRESHOLD = 100000; // Above this is considered high liquidity
const MAX_EXPOSURE_LOW_LIQUIDITY = 0.03; // 3% max exposure for low liquidity
const MAX_EXPOSURE_HIGH_LIQUIDITY = 0.05; // 5% max exposure for high liquidity
const PROBE_EDGE_THRESHOLD = 0.02; // Minimum edge for probe trades
const STRONG_TRADE_EXPOSURE = 0.02; // Minimum exposure for strong trades
const SMALL_TRADE_EXPOSURE = 0.005; // Minimum exposure for small trades
const PROBE_EXPOSURE = 0.0005; // Minimum exposure for probe trades
const MIN_NET_EDGE = 0.015; // 1.5% minimum net edge after costs
const CONVICTION_MULTIPLIER_MIN = 0.85; // Minimum conviction multiplier
const HIGH_EDGE_THRESHOLD = 0.12; // Edge above which conviction doesn't matter
const MEDIUM_EDGE_THRESHOLD = 0.06; // Edge above which conviction penalty is reduced
const MIN_LIQUIDITY_THRESHOLD = 7500; // $7.5K minimum liquidity (further reduced for 5000 markets)
const MIN_VOLUME_VELOCITY = 150; // $150/hour minimum trading activity (further reduced)
const PRIORITY_CATEGORIES = ['MACRO', 'POLITICS', 'CRYPTO', 'SPORTS_FUTURES','ETF_APPROVAL', 'TECH_ADOPTION', 'TECH', 'ENTERTAINMENT', 'EVENT'];
const DATA_RICH_CATEGORIES = ['SPORTS_FUTURES', 'CRYPTO', 'ETF_APPROVAL', 'TECH_ADOPTION'];
const CONVICTION_BOOST_HIGH = 1.20; // 20% boost for high liquidity
const CONVICTION_BOOST_MEDIUM = 1.15; // 15% boost for medium liquidity
const CONVICTION_BOOST_LOW = 1.10; // 10% boost for low liquidity
const EDGE_THRESHOLD_HIGH = 0.10; // Very high edge threshold
const EDGE_THRESHOLD_MEDIUM_HIGH = 0.07; // High edge threshold
const EDGE_THRESHOLD_MEDIUM = 0.05; // Medium-high edge threshold
const DEFAULT_CONFIDENCE_THRESHOLD = 0.50; // 50% confidence (decimal)

const TAIL_MARKET_THRESHOLD = 0.95; // 95% - above or below this is tail market
const TAIL_MARKET_MIN_CONFIDENCE = 95; // Require 95% confidence for tail markets

const CORRELATION_CLUSTERS = {
  politics: ['POLITICS', 'WAR_OUTCOMES'],
  crypto: ['CRYPTO', 'ETF_APPROVAL'],
  macro: ['MACRO']
};

const CATEGORY_CLUSTER_MAP = Object.entries(CORRELATION_CLUSTERS).reduce((acc, [cluster, cats]) => {
  cats.forEach(cat => { acc[cat] = cluster; });
  return acc;
}, {});

const CLUSTER_PENALTY_STEPS = [1, 0.95, 0.9, 0.85];
const CLUSTER_PENALTY_FLOOR = 0.8;

function computeCorrelation(seriesA = [], seriesB = []) {
  const len = Math.min(seriesA.length, seriesB.length);
  if (len < 3) return 0;
  const a = seriesA.slice(-len).map(p => Number(p?.price ?? p)).filter(Number.isFinite);
  const b = seriesB.slice(-len).map(p => Number(p?.price ?? p)).filter(Number.isFinite);
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const denom = Math.sqrt(denA) * Math.sqrt(denB);
  if (denom === 0) return 0;
  return num / denom;
}

function getClusterForCategory(category = '') {
  if (!category) return null;
  return CATEGORY_CLUSTER_MAP[category.toUpperCase()] || null;
}

function applyPreAnalysisClusterFilter(markets = []) {
  const clusters = markets.reduce((acc, market) => {
    const cluster = getClusterForCategory(market.category);
    const clusterKey = cluster || 'default';
    acc[clusterKey] = acc[clusterKey] || [];
    acc[clusterKey].push(market);
    return acc;
  }, {});

  const filteredMarkets = [];
  
  Object.values(clusters).forEach(group => {
    if (group.length === 1) {
      // Single market in cluster - keep it
      filteredMarkets.push(group[0]);
    } else {
      // Multiple markets in cluster - keep only the best one
      // Sort by quality score, liquidity, and volume to find the best market
      group.sort((a, b) => {
        const scoreA = computeMarketQualityScore(a);
        const scoreB = computeMarketQualityScore(b);
        if (scoreB !== scoreA) return scoreB - scoreA;
        
        const liquidityA = a.liquidity || 0;
        const liquidityB = b.liquidity || 0;
        if (liquidityB !== liquidityA) return liquidityB - liquidityA;
        
        const volumeA = a.volume || 0;
        const volumeB = b.volume || 0;
        return volumeB - volumeA;
      });
      
      // Keep the best market from each cluster
      filteredMarkets.push(group[0]);
      
      // Log the filtered markets for transparency
      const filteredOut = group.slice(1);
      if (filteredOut.length > 0) {
        log(`[CLUSTER FILTER] Kept best market: ${(group[0].question || '').slice(0, 50)}... (score=${computeMarketQualityScore(group[0]).toFixed(1)})`, 'INFO');
        filteredOut.forEach((market, idx) => {
          log(`[CLUSTER FILTER] Filtered: ${(market.question || '').slice(0, 50)}... (score=${computeMarketQualityScore(market).toFixed(1)})`, 'DEBUG');
        });
      }
    }
  });

  log(`[CLUSTER FILTER] Reduced from ${markets.length} to ${filteredMarkets.length} markets (${((markets.length - filteredMarkets.length) / markets.length * 100).toFixed(1)}% reduction)`, 'INFO');
  return filteredMarkets;
}

function applyClusterDampening(signals = []) {
  const clusters = signals.reduce((acc, s) => {
    const cluster = s?.cluster || 'default';
    acc[cluster] = acc[cluster] || [];
    acc[cluster].push(s);
    return acc;
  }, {});

  const historyOf = (s) => s?.priceHistory || s?.market?.priceHistory || [];

  Object.values(clusters).forEach(group => {
    // Keep first signal untouched; dampen subsequent only if highly correlated
    for (let i = 1; i < group.length; i++) {
      const sig = group[i];
      const best = group[0];
      const corr = computeCorrelation(historyOf(sig), historyOf(best));
      if (corr <= 0.7) continue; // treat as independent
      
      // Calculate penalty based on position AND correlation strength
      const basePositionPenalty = i < CLUSTER_PENALTY_STEPS.length
        ? CLUSTER_PENALTY_STEPS[i]
        : CLUSTER_PENALTY_FLOOR;
      
      // Add correlation-based penalty: higher correlation = more penalty
      const corrPenalty = 1 - ((corr - 0.7) / 0.3) * 0.15; // 0-15% additional penalty
      const finalPenalty = basePositionPenalty * corrPenalty;
      
      if (typeof sig.intentExposure === 'number') {
        sig.intentExposure = Number((sig.intentExposure * finalPenalty).toFixed(4));
      }
      if (typeof sig.effectiveEdge === 'number') {
        sig.effectiveEdge = Number((sig.effectiveEdge * finalPenalty).toFixed(2));
      }
      if (typeof sig.edgeScore === 'number') {
        sig.edgeScore = Number((sig.edgeScore * finalPenalty).toFixed(2));
      }
      if (typeof sig.finalEffectiveEdge === 'number') {
        sig.finalEffectiveEdge = Number((sig.finalEffectiveEdge * finalPenalty).toFixed(2));
      }
    }
  });
}

const PRIOR_BUCKETS = {
  MACRO: [0.05, 0.20],
  POLITICS: [0.03, 0.15],
  SPORTS_FUTURES: [0.01, 0.05],
  SPORTS_PLAYER: [0.01, 0.05],
  CRYPTO: [0.08, 0.30],
  CELEBRITY: [0.01, 0.05],
  TECH: [0.05, 0.25],
  ENTERTAINMENT: [0.02, 0.10],
  TECH_ADOPTION: [0.05, 0.25],
  ETF_APPROVAL: [0.10, 0.40],
  WAR_OUTCOMES: [0.03, 0.15],
  EVENT: [0.03, 0.12],
  OTHER: [0.03, 0.10]
};

// State-specific political priors for governor races (based on historical data)
const STATE_POLITICAL_PRIORS = {
  // Solid Republican states (>90% GOP win rate historically)
  'idaho': 0.99,      // GOP hasn't lost since 1990
  'south dakota': 0.99, // Solid red state
  'wyoming': 0.99,
  'north dakota': 0.98,
  'utah': 0.95,
  'oklahoma': 0.95,
  'arkansas': 0.95,
  'kansas': 0.93,
  'nebraska': 0.93,
  'alabama': 0.92,
  'mississippi': 0.92,
  'tennessee': 0.92,
  'kentucky': 0.90,
  'louisiana': 0.90,
  'indiana': 0.90,
  'missouri': 0.88,
  'south carolina': 0.92,
  'west virginia': 0.95,
  'alaska': 0.92,
  'iowa': 0.85,
  'montana': 0.85,

  // Solid Democratic states (>80% Dem win rate historically)
  'rhode island': 0.80, // Democratic incumbent
  'massachusetts': 0.85,
  'maryland': 0.80,
  'hawaii': 0.90,
  'vermont': 0.85,
  'new york': 0.75,
  'california': 0.70,
  'illinois': 0.70,
  'washington': 0.70,
  'oregon': 0.70,
  'connecticut': 0.75,
  'delaware': 0.75,
  'colorado': 0.65,
  'maine': 0.70,
  'minnesota': 0.70,
  'new hampshire': 0.60,
  'new mexico': 0.65,
  'virginia': 0.60,

  // Competitive states (40-60% range)
  'pennsylvania': 0.55,
  'michigan': 0.55,
  'wisconsin': 0.55,
  'arizona': 0.52,
  'georgia': 0.52,
  'nevada': 0.52,
  'north carolina': 0.50,
  'florida': 0.48,
  'texas': 0.45,
  'ohio': 0.48,
};

const PROBABILITY_CAPS = {
  MACRO: 0.70,
  POLITICS: 0.70,
  SPORTS_FUTURES: 0.70,
  SPORTS_PLAYER: 0.70,
  CRYPTO: 0.70,
  CELEBRITY: 0.70,
  TECH: 0.70,
  ENTERTAINMENT: 0.70,
  TECH_ADOPTION: 0.70,
  ETF_APPROVAL: 0.70,
  WAR_OUTCOMES: 0.70,
  EVENT: 0.70,
  OTHER: 0.70
};

const CATEGORY_EDGE_CONFIG = {
  SPORTS_FUTURES: { base: 0.01, low: 0.008, hiLiquidity: 150000 },
  POLITICS: { base: 0.015, low: 0.01, hiLiquidity: 120000 },
  MACRO: { base: 0.015, low: 0.01, hiLiquidity: 100000 },
  CRYPTO: { base: 0.015, low: 0.01, hiLiquidity: 90000 },
  TECH: { base: 0.015, low: 0.01, hiLiquidity: 80000 },
  TECH_ADOPTION: { base: 0.015, low: 0.01, hiLiquidity: 80000 },
  ETF_APPROVAL: { base: 0.015, low: 0.01, hiLiquidity: 80000 },
  ENTERTAINMENT: { base: 0.02, low: 0.015, hiLiquidity: 60000 },
  CELEBRITY: { base: 0.02, low: 0.015, hiLiquidity: 40000 },
  WAR_OUTCOMES: { base: 0.02, low: 0.015, hiLiquidity: 70000 },
  EVENT: { base: 0.02, low: 0.015, hiLiquidity: 60000 },
  OTHER: { base: 0.02, low: 0.015, hiLiquidity: 60000 }
};
const DEFAULT_EDGE_CONFIG = { base: 0.02, low: 0.015, hiLiquidity: 60000 };

// Meme/joke market patterns to filter out
const MEME_MARKET_PATTERNS = [
  /before GTA VI/i,
  /before GTA6/i,
  /before Grand Theft Auto/i,
  /Jesus Christ return/i,
  /Jesus Christ come back/i,
  /Second Coming/i,
  /Rapture before/i,
  /bitcoin hit \$1m before GTA/i,
  /bitcoin hit 1m before GTA/i
];

function isMemeMarket(question = '') {
  const q = question.toLowerCase();
  return MEME_MARKET_PATTERNS.some(pattern => pattern.test(q));
}

const GROUP_DEFINITIONS = {
  top_ai_2025: [
    "agentic ai",
    "chatbot arena",
    "frontier ai",
    "openai",
    "anthropic",
    "xai",
    "deepseek",
    "llama",
    "groq"
  ],
  spacex_launches_2025: [
    "spacex",
    "starship",
    "falcon 9",
    "falcon heavy",
    "space launch",
    "crew dragon",
    "mars mission"
  ]
};

function computeCategoryEdgeFloor(category, market) {
  const config = CATEGORY_EDGE_CONFIG[category] || DEFAULT_EDGE_CONFIG;

  const liquidity = market.liquidity || 0;
  let floor = liquidity > config.hiLiquidity ? config.low : config.base;

  const ageDays = (Date.now() - new Date(getMarketStartDate(market) || Date.now())) / (1000 * 60 * 60 * 24);
  if (ageDays < 7) floor *= 0.95;

  return floor;
}

function computeCategoryLiquidityFloor(category, market) {
  const config = CATEGORY_EDGE_CONFIG[category] || DEFAULT_EDGE_CONFIG;
  return config.hiLiquidity;
}

let systemHealth = { posts: 0, marketsMonitored: 0, lastRun: null };
const lastAnalyses = new Map();
let isRunning = false;

// Request queue to prevent overlapping cycles
const cycleQueue = [];
let isProcessingQueue = false;

async function processCycleQueue() {
  if (isProcessingQueue || cycleQueue.length === 0) return;

  isProcessingQueue = true;
  const MAX_QUEUE_SIZE = 10;

  while (cycleQueue.length > 0) {
    // Prevent queue overflow
    if (cycleQueue.length > MAX_QUEUE_SIZE) {
      const dropped = cycleQueue.splice(MAX_QUEUE_SIZE);
      dropped.forEach(resolve => resolve());
      console.warn(`[QUEUE] Dropped ${dropped.length} pending cycles`);
    }
    
    const resolve = cycleQueue.shift();
    
    try {
      await Promise.race([
        runCycle(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Cycle timeout')), 60000))
      ]);
      resolve();
    } catch (err) {
      console.error('Cycle failed:', err.message);
      resolve(); // Always resolve to prevent queue block
    }
  }
  
  isProcessingQueue = false;
}

async function queuedRunCycle() {
  return new Promise((resolve) => {
    cycleQueue.push(resolve);
    processCycleQueue();
  });
}

let portfolio = { balance: 1000, positions: {}, pnl: 0 };

let isNoSignalMode = false;
let isVolatilityLock = false;
let isLiquidityShock = false;
let activeGroupSizes = {};
let dynamicCategoryPriors = {};
let categoryPerformance = loadCategoryPerformance();

// Simple mutex-like mechanism to prevent race conditions
let isUpdatingCategoryPerformance = false;
let isUpdatingDynamicPriors = false;

// Global directional bias tracking
let directionalBiasStats = {
  buyNoCount: 0,
  buyYesCount: 0,
  totalSignals: 0,
  lastReset: Date.now()
};

async function safeUpdateCategoryPerformance(markets = []) {
  if (isUpdatingCategoryPerformance) {
    log('[RACE] Category performance update already in progress, skipping', 'WARN');
    return;
  }
  
  isUpdatingCategoryPerformance = true;
  try {
    if (!Array.isArray(markets) || markets.length === 0) return;
    const aggregates = {};
    for (const market of markets) {
      const yesPrice = typeof market.yesPrice === 'number' ? market.yesPrice : null;
      if (yesPrice === null) continue;
      const category = getCategoryKey(market.question, market);
      const liquidity = Math.max(1000, Number(market.liquidity) || 0);
      const basePrior = getStaticBucketPrior(category);
      const baseError = Math.abs(basePrior - yesPrice);
      if (!aggregates[category]) {
        aggregates[category] = { weight: 0, priceSum: 0, errorSum: 0, liquiditySum: 0, count: 0 };
      }
      aggregates[category].weight += liquidity;
      aggregates[category].priceSum += yesPrice * liquidity;
      aggregates[category].errorSum += baseError * liquidity;
      aggregates[category].liquiditySum += liquidity;
      aggregates[category].count += 1;
    }

    const alpha = 0.5;  // New: faster adaptation to recent market data
    const now = Date.now();
    let updated = false;

    for (const [category, data] of Object.entries(aggregates)) {
      if (data.weight === 0) continue;
      const avgPrice = data.priceSum / data.weight;
      const avgError = data.errorSum / data.weight;
      const avgLiquidity = data.liquiditySum / Math.max(1, data.count);
      const perf = categoryPerformance[category] || {};
      perf.emaMarketPrice = perf.emaMarketPrice != null
        ? (perf.emaMarketPrice * (1 - alpha)) + (avgPrice * alpha)
        : avgPrice;
      perf.emaError = perf.emaError != null
        ? (perf.emaError * (1 - alpha)) + (avgError * alpha)
        : avgError;
      perf.liquidityEMA = perf.liquidityEMA != null
        ? (perf.liquidityEMA * (1 - alpha)) + (avgLiquidity * alpha)
        : avgLiquidity;
      perf.lastUpdated = now;
      categoryPerformance[category] = perf;
      updated = true;
    }

    if (updated) {
      saveCategoryPerformance(categoryPerformance);
    }
  } finally {
    isUpdatingCategoryPerformance = false;
  }
}

const MAX_CYCLE_HISTORY = Number(process.env.MAX_CYCLE_HISTORY || 168);
global.cycleHistory = Array.isArray(global.cycleHistory) ? global.cycleHistory : [];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const getCycleHistory = () =>
  Array.isArray(global.cycleHistory) ? global.cycleHistory : [];

global.getCycleHistory = getCycleHistory;

const bootstrapCycleData = () => {
  const persistedHistory = loadJsonFile(CYCLE_HISTORY_FILE, []);
  if (Array.isArray(persistedHistory)) {
    global.cycleHistory = trimArray(persistedHistory, MAX_CYCLE_HISTORY);
  }

  const persistedLatest = loadJsonFile(CYCLE_SNAPSHOT_FILE, null);
  if (persistedLatest && typeof persistedLatest === 'object') {
    global.latestData = { ...(global.latestData || {}), ...persistedLatest };
  } else if (global.latestData) {
    saveJsonFile(CYCLE_SNAPSHOT_FILE, global.latestData);
  } else {
    global.latestData = {
      cycleSummary: null,
      liveSignals: [],
      marketOutlook: [],
      rejectedSignals: [],
      volumeSpikes: [],
      lastRun: null,
      marketsMonitored: 0,
      posts: 0
    };
    saveJsonFile(CYCLE_SNAPSHOT_FILE, global.latestData);
  }
};

bootstrapCycleData();

const recordCycleSnapshot = (latestData = {}) => {
  const timestamp = latestData.lastRun || new Date().toISOString();
  const summary = latestData.cycleSummary || {};
  const snapshot = {
    timestamp,
    marketsFetched: summary.marketsFetched || 0,
    marketsEligible: summary.marketsEligible || 0,
    signalsGenerated: summary.signalsGenerated || 0,
    watchlist: summary.watchlist || latestData.liveSignals?.length || 0,
    outlook: summary.outlook || latestData.marketOutlook?.length || 0,
    rejected: summary.rejected || latestData.rejectedSignals?.length || 0,
  };

  const history = [snapshot, ...getCycleHistory()].filter(Boolean);
  global.cycleHistory = trimArray(history, MAX_CYCLE_HISTORY);
  saveJsonFile(CYCLE_HISTORY_FILE, global.cycleHistory);
  saveJsonFile(CYCLE_SNAPSHOT_FILE, latestData);
};

function loadCategoryPerformance() {
  try {
    return JSON.parse(fsSync.readFileSync(CATEGORY_PERFORMANCE_FILE, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function saveCategoryPerformance(data = {}) {
  try {
    fs.mkdirSync(path.dirname(CATEGORY_PERFORMANCE_FILE), { recursive: true });
    fsSync.writeFileSync(CATEGORY_PERFORMANCE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to persist category performance cache:', err.message);
  }
}

function getStaticBucketPrior(categoryKey) {
  const bucket = PRIOR_BUCKETS[categoryKey] || [0.05, 0.20];
  return (bucket[0] + bucket[1]) / 2;
}

/**
 * Returns edge threshold as DECIMAL (0.05 = 5%)
 * Callers must ensure they compare against decimal values, not percentages
 * @param {string} categoryKey - Market category
 * @returns {number} Edge threshold as decimal (typically 0.05-0.06)
 */
function getCategoryEdgeThreshold(categoryKey) {
  const categoryPerf = categoryPerformance[categoryKey];
  let edgeThreshold = EDGE_THRESHOLD; // 0.05 = 5% as decimal
  
  if (categoryPerf && typeof categoryPerf.emaError === 'number') {
    if (categoryPerf.emaError > 0.15) {
      edgeThreshold *= 1.2;
    } else if (categoryPerf.emaError > 0.10) {
      edgeThreshold *= 1.1;
    }
  }
  
  return edgeThreshold; // Returns decimal (0.05-0.06 typically)
}

function updateCategoryPerformance(markets = []) {
  if (!Array.isArray(markets) || markets.length === 0) return;
  const aggregates = {};
  for (const market of markets) {
    const yesPrice = typeof market.yesPrice === 'number' ? market.yesPrice : null;
    if (yesPrice === null) continue;
    const category = getCategoryKey(market.question, market);
    const liquidity = Math.max(1000, Number(market.liquidity) || 0);
    const basePrior = getStaticBucketPrior(category);
    const baseError = Math.abs(basePrior - yesPrice);
    if (!aggregates[category]) {
      aggregates[category] = { weight: 0, priceSum: 0, errorSum: 0, liquiditySum: 0, count: 0 };
    }
    aggregates[category].weight += liquidity;
    aggregates[category].priceSum += yesPrice * liquidity;
    aggregates[category].errorSum += baseError * liquidity;
    aggregates[category].liquiditySum += liquidity;
    aggregates[category].count += 1;
  }

  const alpha = 0.5;  // New: faster adaptation to recent market data
  const now = Date.now();
  let updated = false;

  for (const [category, data] of Object.entries(aggregates)) {
    if (data.weight === 0) continue;
    const avgPrice = data.priceSum / data.weight;
    const avgError = data.errorSum / data.weight;
    const avgLiquidity = data.liquiditySum / Math.max(1, data.count);
    const perf = categoryPerformance[category] || {};
    perf.emaMarketPrice = perf.emaMarketPrice != null
      ? (perf.emaMarketPrice * (1 - alpha)) + (avgPrice * alpha)
      : avgPrice;
    perf.emaError = perf.emaError != null
      ? (perf.emaError * (1 - alpha)) + (avgError * alpha)
      : avgError;
    perf.liquidityEMA = perf.liquidityEMA != null
      ? (perf.liquidityEMA * (1 - alpha)) + (avgLiquidity * alpha)
      : avgLiquidity;
    perf.lastUpdated = now;
    categoryPerformance[category] = perf;
    updated = true;
  }

  if (updated) {
    saveCategoryPerformance(categoryPerformance);
  }
}

function getCategoryKey(question, market = null) {
  const category = (market?.category || classifyMarket(question) || '').toUpperCase();
  log(`Category for ${question}: ${category}`);
  return category || 'OTHER';
}

function settlementRisk(question) {
  if (!question) return 'MEDIUM';
  const q = question.toLowerCase();
  if (/will.*win|who.*win|best.*movie/i.test(q)) return 'HIGH';
  if (/price.*above|will.*reach/i.test(q) && /\$.*\d+/i.test(q)) return 'LOW';
  return 'MEDIUM';
}

function buildPolymarketUrl(marketSlug, marketQuestion) {
  const POLYMARKET_BASE_URL = 'https://polymarket.com';
  // Use actual market slug for direct link
  if (marketSlug && marketSlug.length > 0) {
    return `${POLYMARKET_BASE_URL}/event/${marketSlug}`;
  }
  // Fallback to search if no slug
  if (marketQuestion) {
    const searchQuery = encodeURIComponent(marketQuestion);
    return `${POLYMARKET_BASE_URL}/search?q=${searchQuery}`;
  }
  return `${POLYMARKET_BASE_URL}`;
}

function getBaseRate(question, market = null) {
  const q = (question || '').toLowerCase();
  const categoryKey = getCategoryKey(question, market);
  
  // Check if dynamicCategoryPriors is actually resolved (not a Promise)
  if (dynamicCategoryPriors instanceof Promise) {
    log(`[WARNING] dynamicCategoryPriors is still a Promise, using static priors`, 'WARN');
    dynamicCategoryPriors = {};
  }

  // General competitor count detection for base rate calibration
  // This makes the system intelligent across all categories, not just sports
  
  // Detect NFL teams (32 teams = 3.1% base rate)
  if (/win the (super bowl|afc championship|nfc championship)/i.test(q)) {
    return 1 / 32; // ~3.1%
  }
  
  // Detect NBA teams (30 teams = 3.3% base rate)
  if (/win the nba championship/i.test(q)) {
    return 1 / 30;
  }
  
  // Detect MLB teams (30 teams = 3.3% base rate)
  if (/win the (world series|mlb championship)/i.test(q)) {
    return 1 / 30;
  }
  
  // Detect NHL teams (32 teams = 3.1% base rate)
  if (/win the (stanley cup|nhl championship)/i.test(q)) {
    return 1 / 32;
  }
  
  // Detect Premier League teams (20 teams = 5% base rate)
  if (/win the (premier league|epl)/i.test(q)) {
    return 1 / 20;
  }
  
  // Detect binary elections (2 main candidates = 50% base rate)
  if (/win the (2024|2025|2026|2028) (presidential|election)/i.test(q)) {
    return 0.5;
  }

  // Detect state governor races - use state-specific priors
  if (/win the (governor|governorship) in (2024|2025|2026|2028)/i.test(q)) {
    const stateMatch = q.match(/(?:in|for) ([a-z]+) (?:governor|governorship)/i);
    if (stateMatch) {
      const state = stateMatch[1].toLowerCase();
      if (STATE_POLITICAL_PRIORS[state]) {
        let prior = STATE_POLITICAL_PRIORS[state];

        // Incumbent advantage: boost prior by 10% for incumbents
        if (/incumbent|re-election|running for re-election/i.test(q)) {
          prior = Math.min(0.99, prior + 0.10);
        }

        return prior;
      }
    }
  }

  // Detect multi-candidate events (estimate from question structure)
  const teamMatch = q.match(/(\d{1,2}) (teams|candidates|options)/i);
  if (teamMatch) {
    const count = parseInt(teamMatch[1]);
    if (count > 0 && count <= 100) {
      return 1 / count;
    }
  }

  if (/weed.*rescheduled/i.test(q)) return 0.25;

  if (activeGroupSizes[q]) {
    const groupSize = Math.max(1, activeGroupSizes[q]);
    return Math.max(0.01, 1 / groupSize);
  }

  if (/top ai model/i.test(q)) return 0.2;
  if (/spacex launches in 2025/i.test(q)) return 0.2;

  let prior = getStaticBucketPrior(categoryKey);

  if (dynamicCategoryPriors[categoryKey]) {
    const livePrior = dynamicCategoryPriors[categoryKey];
    prior = (prior * 0.5) + (livePrior * 0.5);
  }

  const perf = categoryPerformance[categoryKey];
  if (perf) {
    const liquidityWeight = clamp((perf.liquidityEMA || 0) / 75000, 0, 1);
    if (perf.emaMarketPrice != null) {
      prior = (prior * (1 - liquidityWeight * 0.5)) + (perf.emaMarketPrice * liquidityWeight * 0.5);
    }
    if (perf.emaError != null) {
      const errorPenalty = clamp(perf.emaError * 2, 0, 0.4);
      prior = (prior * (1 - errorPenalty)) + (0.5 * errorPenalty);
    }
  }

  if (market && market.yesPrice) {
    const observedPrice = market.yesPrice;
    const timeConfidence = computeMarketTimeProgress(market);
    const blendWeight = clamp(0.1 + (timeConfidence * 0.4), 0.1, 0.5);
    prior = (prior * (1 - blendWeight)) + (observedPrice * blendWeight);
  }

  return calibratePrior(prior, categoryKey);
}

function calibratePrior(prior, categoryKey) {
  const bucket = PRIOR_BUCKETS[categoryKey] || PRIOR_BUCKETS.OTHER || [0.05, 0.20];
  const [bucketMin, bucketMax] = bucket;
  const midpoint = (bucketMin + bucketMax) / 2;
  const bucketSpan = Math.max(0.05, bucketMax - bucketMin);

  let sanitized = Number.isFinite(prior) ? prior : midpoint;
  sanitized = clamp(sanitized, PROBABILITY_FLOOR, 0.99);

  const guardrailMin = Math.max(PROBABILITY_FLOOR, bucketMin - bucketSpan * 0.5);
  const guardrailMax = Math.min(0.99, bucketMax + bucketSpan * 0.5);
  const guardrailSpan = Math.max(0.0001, (guardrailMax - guardrailMin) / 2);
  const deviation = Math.abs(sanitized - midpoint);
  const dampingStrength = clamp(deviation / guardrailSpan, 0, 1);
  const dampingFactor = 0.35 + (0.25 * dampingStrength);

  const blended = (sanitized * (1 - dampingFactor)) + (midpoint * dampingFactor);
  const capped = clamp(blended, guardrailMin, guardrailMax);

  return capped;
}

function computeMarketTimeProgress(market = {}) {
  const now = Date.now();
  const end = Date.parse(market.endDateIso || market.endDate || '') || null;

  if (!end || end <= now) {
    if (end && end <= now && market.id) {
      console.warn(`Market ${market.id} is expired, skipping analysis`);
    }
    return 1;
  }
  const start = Date.parse(market.startDateIso || market.startDate || market.createdAt || '') || (end - (180 * DAY_MS));
  const totalDuration = Math.max(DAY_MS, end - start);
  const elapsed = clamp(now - start, 0, totalDuration);
  return clamp(elapsed / totalDuration, 0, 1);
}

function detectTrend(market) {
  const history = market.priceHistory || [];
  if (history.length < 5) return 0;
  const recent = history.slice(-5);
  const prices = recent.map(h => h.price || 0.5);
  const trend = prices.reduce((acc, price, i) => {
    if (i === 0) return acc;
    return acc + (price - prices[i-1]);
  }, 0) / (prices.length - 1);
  return trend;
}

function deriveVetoReason({ liquidityFactor, confidence, entropy }) {
  if (entropy > 0.6) return 'high_entropy';
  return 'risk_policy';
}

function logVetoEvent(event = {}) {
  const payload = {
    type: 'veto_decision',
    timestamp: new Date().toISOString(),
    ...event
  };
  fsSync.appendFile(CONSOLE_LOG_FILE, JSON.stringify(payload) + '\n').catch(err => {
    console.error('Failed to write veto event:', err.message);
  });
  if (LOG_TO_CONSOLE) {
    console.warn(`[VETO] ${payload.marketId || 'unknown'} -> ${payload.reason || 'unspecified'} | edge=${(payload.edgeScore ?? 0).toFixed(2)} conf=${(payload.confidence ?? 0).toFixed(2)} liq=${(payload.liquidity ?? 0).toFixed(0)}`);
  }
}

async function safeBuildDynamicCategoryPriors(markets = []) {
  if (isUpdatingDynamicPriors) {
    log('[RACE] Dynamic priors update already in progress, skipping', 'WARN');
    return {};
  }
  
  isUpdatingDynamicPriors = true;
  try {
    const aggregates = {};
    for (const market of markets) {
      const yesPrice = typeof market.yesPrice === 'number' ? market.yesPrice : null;
      if (yesPrice === null) continue;

      const category = getCategoryKey(market.question, market);
      const weight = Math.max(1, Number(market.liquidity) || 0);
      if (!aggregates[category]) {
        aggregates[category] = { weight: 0, sum: 0, values: [] };
      }
      aggregates[category].weight += weight;
      aggregates[category].sum += yesPrice * weight;
      aggregates[category].values.push(yesPrice);
    }

    const priors = {};
    for (const [category, data] of Object.entries(aggregates)) {
      if (data.weight === 0 || data.values.length === 0) continue;
      const weighted = data.sum / data.weight;
      const sorted = data.values.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const blended = (weighted * 0.7) + (median * 0.3);
      priors[category] = Math.max(0.01, Math.min(0.99, blended));
    }
    
    return priors;
  } finally {
    isUpdatingDynamicPriors = false;
  }
}

function getYesNoPrices(market) {
  const clobPrice = getClobPrice(market.id);
  if (clobPrice && clobPrice > 0 && clobPrice < 1) {
    return { yes: clobPrice, no: 1 - clobPrice };
  }

  if (market.outcomePrices && market.outcomePrices.length >= 2) {
    let yes = parseFloat(market.outcomePrices[0]);
    let no = parseFloat(market.outcomePrices[1]);
    if (yes > 1) yes /= 100;
    if (no > 1) no /= 100;
    if (yes + no > 2) {
      const temp = yes;
      yes = no;
      no = temp;
    }
    if (!Number.isFinite(yes) || !Number.isFinite(no) || yes <= 0 || yes >= 1 || no <= 0 || no >= 1) {
      console.warn(`Invalid prices for ${market.id}: yes=${yes}, no=${no}`);
      return null;
    }
    return { yes, no };
  }

  if (typeof market.yesPrice === 'number' && typeof market.noPrice === 'number') {
    if (!Number.isFinite(market.yesPrice) || !Number.isFinite(market.noPrice) ||
        market.yesPrice <= 0 || market.yesPrice >= 1 ||
        market.noPrice <= 0 || market.noPrice >= 1) {
      console.warn(`Invalid prices for ${market.id}: yes=${market.yesPrice}, no=${market.noPrice}`);
      return null;
    }
    return { yes: market.yesPrice, no: market.noPrice };
  }

  return null;
}

function getMarketStartDate(market = {}) {
  const normalize = (value) => {
    if (!value) return null;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      if (value > 1e12) return new Date(value).toISOString();
      return new Date(value * 1000).toISOString();
    }
    if (typeof value === 'string') return value;
    return null;
  };

  const candidates = [
    market.startDateIso,
    market.start_date_iso,
    market.startDate,
    market.start_date,
    market.createdAt,
    market.created_at,
    market.creationTime,
    market.creation_time,
    market.createdTime,
    market.openDate,
    market.open_date,
    market.timestamp,
    market.listedAt,
    market.listed_at
  ];

  for (const candidate of candidates) {
    const normalized = normalize(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function computeGroupSizeMap(markets = []) {
  const map = {};
  Object.values(GROUP_DEFINITIONS).forEach(patterns => {
    const members = markets.filter(m =>
      m?.question && patterns.some(pattern => m.question.includes(pattern))
    );
    const size = members.length || patterns.length;
    members.forEach(m => {
      map[(m.question || '').toLowerCase()] = Math.max(1, size);
    });
  });
  return map;
}

function computePriceDrift(market = {}) {
  if (typeof market.priceChange === 'number' && market.priceChange !== 0) {
    return market.priceChange;
  }
  const history = market.priceHistory || [];
  if (history.length >= 2) {
    const first = history[0]?.price;
    const last = history[history.length - 1]?.price;
    if (first && last && first > 0) {
      return (last - first) / first;
    }
  }
  if (typeof market.priceVolatility === 'number' && market.priceVolatility > 0) {
    return Math.sign((market.yesPrice || 0.5) - (market.lastPrice || market.yesPrice || 0.5)) * market.priceVolatility;
  }
  return 0;
}

function computeVolumeVelocity(market = {}) {
  if (typeof market.vVel === 'number' && market.vVel !== 0) return market.vVel;
  if (typeof market.volumeVelocity === 'number' && market.volumeVelocity !== 0) return market.volumeVelocity;

  const history = market.volumeHistory || [];
  if (history.length >= 2) {
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    const deltaVol = (last?.volume ?? 0) - (prev?.volume ?? 0);
    const deltaTime = ((last?.timestamp ?? 0) - (prev?.timestamp ?? 0)) / 1000;
    if (deltaTime > 0) {
      return deltaVol / deltaTime;
    }
  }

  if (typeof market.volumeChange === 'number' && market.volume > 0) {
    return (market.volumeChange / Math.max(1, market.volume - market.volumeChange)) * 100;
  }

  return 0;
}

function computeBaselineVolumeVelocity(market = {}) {
  if (typeof market.avgVvel === 'number' && market.avgVvel > 0) return market.avgVvel;
  const history = market.volumeHistory || [];
  if (history.length >= 3) {
    const deltas = [];
    for (let i = 1; i < history.length; i++) {
      const deltaVol = (history[i]?.volume ?? 0) - (history[i - 1]?.volume ?? 0);
      const deltaTime = ((history[i]?.timestamp ?? 0) - (history[i - 1]?.timestamp ?? 0)) / 1000;
      if (deltaTime > 0) {
        deltas.push(deltaVol / deltaTime);
      }
    }
    if (deltas.length) {
      return deltas.reduce((a, b) => a + b, 0) / deltas.length;
    }
  }
  return 0.1;
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
  let penalty = Math.min(0.15, progress * 0.15);
  if (penalty <= 0) return probability;

  if (market && market.yesPrice > 0.9) {
    penalty = Math.min(penalty, 0.05);
  }

  if (analysis) {
    analysis.deltas = analysis.deltas || {};
    analysis.deltas.time = -(penalty * 100);
  }

  return probability;
}

function validateLLMAnalysis(analysis, market) {
  if (!analysis) return { valid: false, reason: 'No analysis provided' };

  const llmData = analysis.llmAnalysis || analysis;
  const confidence = llmData.confidence || 0;
  const probability = llmData.revised_prior ?? llmData.probability ?? 0.5;

  // 1. Reject if confidence is too low (but not too strict)
  if (confidence < 20) {
    return { valid: false, reason: `Confidence too low (${confidence}%)` };
  }

  // 2. Validate probability is in valid range
  if (typeof probability !== 'number' || probability < 0.01 || probability > 0.99) {
    return { valid: false, reason: 'Invalid probability value' };
  }

  // 3. Calculate edge
  const yesPrice = getYesNoPrices(market)?.yes || market.yesPrice || 0.5;
  const edge = Math.abs(probability - yesPrice);

  // 4. Reject if edge is too small (< 3%)
  if (edge < 0.01) {
    return { valid: false, reason: `Edge too small (${(edge * 100).toFixed(1)}%)` };
  }

  // 5. Check for tail markets (extreme odds) - require strong evidence
  const evidenceCount = (llmData.evidence?.length || 0) +
                       (llmData.newsSources?.length || 0);

  if ((yesPrice > 0.95 || yesPrice < 0.05) && confidence < 60) {
    return { valid: false, reason: `Tail market requires confidence > 60% (got ${confidence}%)` };
  }

  // 6. Entropy check - only reject extreme cases
  // High entropy markets can still be profitable if LLM has good data
  // Only reject if entropy > 0.8 (very high uncertainty) AND confidence < 50%
  const entropy = llmData.entropy || llmData.uncertainty || 0;
  if (entropy > 0.8 && confidence < 50) {
    return { valid: false, reason: `Very high entropy (${(entropy * 100).toFixed(1)}%) with low confidence (${confidence}%)` };
  }

  // 7. Sanity check: probability and edge should align
  const expectedEdge = probability - yesPrice;
  if (Math.abs(expectedEdge) < 0.01) {
    return { valid: false, reason: 'Probability too close to market price' };
  }

  return { valid: true };
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

  if (market && market.yesPrice > 0.9 && analysis.deltas && analysis.deltas.struct < -0.1) {
    prob = Math.min(0.99, prob + 0.1);
    analysis.deltas.struct = Math.max(analysis.deltas.struct, -0.05);
  }

  prob = Math.min(0.99, Math.max(PROBABILITY_FLOOR, prob));

  analysis.probability = prob;
  return prob;
}

function computeEdgeScore(market) {
  if (!market) return 0;
  
  // Validate required fields
  if (!market.question || typeof market.question !== 'string') {
    console.warn('[computeEdgeScore] Invalid market: missing question');
    return 0;
  }
  
  const yesPrice = getYesNoPrices(market)?.yes || 0.5;
  
  if (typeof yesPrice !== 'number' || yesPrice < 0 || yesPrice > 1) {
    console.warn('[computeEdgeScore] Invalid yesPrice:', yesPrice);
    return 0;
  }
  
  const prior = getBaseRate(market.question, market);
  
  if (typeof prior !== 'number' || prior < 0 || prior > 1) {
    console.warn('[computeEdgeScore] Invalid prior:', prior);
    return 0;
  }
  
  return Math.abs(yesPrice - prior);
}

function parseAnalysis(llmOutput, market) {
  if (!llmOutput) return null;

  if (typeof llmOutput === 'string') {
    try {
      return JSON.parse(llmOutput);
    } catch (e) {
      // Use market price instead of defaulting to 0.5 to avoid incorrect bets
      const yesPrice = getYesNoPrices(market)?.yes || market.yesPrice || 0.5;
      console.warn(`[PARSE] JSON parse failed for ${market?.id}, using market price ${yesPrice}: ${e.message}`);
      return { probability: yesPrice, confidence: 50, reasoning: llmOutput };
    }
  }

  return llmOutput;
}

function computeProbabilitiesAndEdge(parsed, market) {
  if (!parsed || !market) {
    const yesPrice = getYesNoPrices(market)?.yes || market.yesPrice || 0.5;
    console.warn(`[COMPUTE] Missing parsed or market data, using market price ${yesPrice}`);
    return { probZigma: yesPrice, probMarket: yesPrice, effectiveEdge: 0 };
  }

  const probZigma = parsed.probability ?? parsed.llmAnalysis?.probability ?? 0.5;
  const yesPrice = getYesNoPrices(market)?.yes || market.yesPrice || 0.5;
  const probMarket = yesPrice;

  const effectiveEdge = probZigma - probMarket;

  return { probZigma, probMarket, effectiveEdge };
}

function decideAction(probZigma, probMarket, effectiveEdge, market) {
  const yesPrice = getYesNoPrices(market)?.yes || market.yesPrice || 0.5;
  const threshold = 0.05;

  if (probZigma > yesPrice + threshold) {
    return 'BUY YES';
  } else if (probZigma < yesPrice - threshold) {
    return 'BUY NO';
  }

  return 'NO_TRADE';
}

function getTradeTier(netEdge, confidence) {
  // Use net edge (after costs) and confidence (certainty)
  const absNetEdge = Math.abs(netEdge);

  // Thresholds based on NET edge
  if (absNetEdge > 0.03 && confidence > 0.70) return 'STRONG_TRADE';   // 3%+ net edge, high certainty
  else if (absNetEdge > 0.015 && confidence > 0.60) return 'SMALL_TRADE'; // 1.5%+ net edge
  else if (absNetEdge > 0.005 && confidence > 0.50) return 'PROBE';       // 0.5%+ net edge
  return 'NO_TRADE';
}

function computeSelectionScore(market) {
  if (!market) return 0;
  const edge = computeEdgeScore(market);
  const liquidity = Math.max(1000, Number(market.liquidity) || 0);
  const volatility = Number.isFinite(market.priceVolatility) ? market.priceVolatility : 0;
  const trend = Math.abs(market.priceChange || 0);
  const liquidityBoost = Math.log10(liquidity) / 2;
  const volatilityPenalty = Math.min(0.3, volatility * 4);
  const trendBoost = Math.min(0.2, trend * 2);
  return Math.max(0, edge * (1 + liquidityBoost + trendBoost) - volatilityPenalty);
}

// Market quality scoring - filters low-quality markets before LLM analysis
function computeMarketQualityScore(market) {
  if (!market) return 0;

  const liquidity = Number(market.liquidity) || 0;
  const volume = Number(market.volume) || 0;
  const yesPrice = getYesNoPrices(market)?.yes || market.yesPrice || 0.5;
  const priceVolatility = Number.isFinite(market.priceVolatility) ? market.priceVolatility : 0;
  const priceHistory = market.priceHistory || [];
  const marketAgeDays = (Date.now() - new Date(getMarketStartDate(market) || Date.now())) / (1000 * 60 * 60 * 24);

  let score = 0;

  // Liquidity score (0-30 points)
  if (liquidity >= 50000) score += 30;
  else if (liquidity >= 20000) score += 20;
  else if (liquidity >= 10000) score += 10;
  else if (liquidity >= 5000) score += 5;

  // Volume score (0-20 points)
  if (volume >= 100000) score += 20;
  else if (volume >= 50000) score += 15;
  else if (volume >= 20000) score += 10;
  else if (volume >= 10000) score += 5;

  // Price history depth (0-15 points)
  if (priceHistory.length >= 50) score += 15;
  else if (priceHistory.length >= 20) score += 10;
  else if (priceHistory.length >= 10) score += 5;

  // Market age (0-15 points) - prefer established but not stale markets
  if (marketAgeDays >= 7 && marketAgeDays <= 90) score += 15;
  else if (marketAgeDays >= 3 && marketAgeDays <= 180) score += 10;
  else if (marketAgeDays >= 1) score += 5;

  // Price volatility (0-10 points) - moderate volatility is good
  if (priceVolatility >= 0.01 && priceVolatility <= 0.05) score += 10;
  else if (priceVolatility >= 0.005 && priceVolatility <= 0.08) score += 5;

  // Price range (0-10 points) - avoid extreme prices
  if (yesPrice >= 0.1 && yesPrice <= 0.9) score += 10;
  else if (yesPrice >= 0.05 && yesPrice <= 0.95) score += 5;

  return Math.min(100, score);
}

// Ensemble probability blending - combines model, market, and prior for position sizing
// NOTE: This is ONLY used for position sizing/risk management, NOT for edge detection or trade decisions
// Edge detection and trade decisions use RAW LLM probability (llmProbability/revised_prior)
function blendProbabilities(modelProb, marketProb, priorProb, marketLiquidity = 10000) {
  // Weight based on market liquidity and confidence
  // Higher liquidity = more trust in market price
  // Higher model confidence = more trust in model
  
  // REDUCED market weight - trust the model more for position sizing
  const liquidityWeight = Math.min(0.25, Math.log10(marketLiquidity) / 6); // 0-0.25 based on liquidity
  const priorWeight = 0.10; // Always include base rate
  const modelWeight = 1 - liquidityWeight - priorWeight; // 65-90% weight on model
  
  // Blend probabilities
  const blended = (modelProb * modelWeight) + (marketProb * liquidityWeight) + (priorProb * priorWeight);
  
  return Math.max(0.01, Math.min(0.99, blended));
}

function enforceCategoryDiversity(selected, universe) {
  if (!Array.isArray(selected) || selected.length === 0) return [];
  const updated = [...selected].filter(m => m && m.question);
  const selectedIds = new Set(updated.map(m => m.id));

  const sports = updated.filter(m => getCategoryKey(m.question, m) === 'SPORTS_FUTURES');
  const maxSports = Math.floor(updated.length * 0.3); // Max 30%
  if (sports.length > maxSports) {
    const dropQueue = sports
      .map(m => ({ market: m, edge: computeEdgeScore(m) }))
      .sort((a, b) => a.edge - b.edge);
    const replacementsNeeded = sports.length - maxSports;
    const fallback = universe
      .filter(m => !selectedIds.has(m.id) && getCategoryKey(m.question, m) !== 'SPORTS_FUTURES')
      .map(m => ({ market: m, edge: computeEdgeScore(m) }))
      .sort((a, b) => b.edge - a.edge)
      .slice(0, replacementsNeeded);

    replacementsNeeded && log(`DIVERSITY: Rebalancing ${replacementsNeeded} sports markets`);
    for (let i = 0; i < replacementsNeeded; i++) {
      const drop = dropQueue.shift();
      const replacement = fallback[i];
      if (!drop || !replacement) break;
      const idx = updated.findIndex(m => m.id === drop.market.id);
      if (idx !== -1) {
        updated[idx] = replacement.market;
        selectedIds.add(replacement.market.id);
      }
    }
  }

  const priority = ['POLITICS', 'MACRO', 'CRYPTO'];
  for (const category of priority) {
    const hasCategory = updated.some(m => getCategoryKey(m.question, m) === category);
    if (hasCategory) continue;
    const candidate = universe
      .filter(m => !selectedIds.has(m.id) && getCategoryKey(m.question, m) === category)
      .map(m => ({ market: m, edge: computeEdgeScore(m) }))
      .sort((a, b) => b.edge - a.edge)[0];

    if (candidate) {
      const replaceIdx = updated
        .map((m, idx) => ({ idx, edge: computeEdgeScore(m), category: getCategoryKey(m.question, m) }))
        .sort((a, b) => a.edge - b.edge)
        .find(entry => entry.category !== category);
      if (replaceIdx) {
        updated[replaceIdx.idx] = candidate.market;
        selectedIds.add(candidate.market.id);
        log(`DIVERSITY: Injected ${category} market ${(candidate.market.question || '').slice(0, 40)}`);
      }
    }
  }

  const scored = updated
    .map(m => ({ market: m, score: computeSelectionScore(m) }))
    .sort((a, b) => b.score - a.score);

  const topSlice = scored.slice(0, 30).map(entry => entry.market);

  const categorySummary = topSlice.reduce((acc, market) => {
    const cat = getCategoryKey(market.question, market);
    acc[cat] = (acc[cat] || 0) + 1;
    return acc;
  }, {});

  log(`DIVERSITY: Category mix -> ${Object.entries(categorySummary).map(([cat, count]) => `${cat}:${count}`).join(', ')}`);

  topSlice.slice(0, 5).forEach((market, idx) => {
    const score = scored[idx]?.score ?? computeSelectionScore(market);
    log(`SCOREBOARD [${idx + 1}]: ${(market.question || '').slice(0, 50)}... score=${score.toFixed(3)} edge=${(computeEdgeScore(market)*100).toFixed(1)}% liq=$${(market.liquidity||0).toLocaleString()} vol=${(market.priceVolatility||0).toFixed(3)}`);
  });

  return topSlice;
}

function pickHighAlphaMarkets(data, marketGroups) {
  const maxPerCat = 8;
  const cappedMarkets = [];
  Object.keys(marketGroups).forEach(category => {
    const group = marketGroups[category].sort((a,b) => computeEdgeScore(b) - computeEdgeScore(a));
    cappedMarkets.push(...group.slice(0, maxPerCat));
  });
  const marketList = cappedMarkets.filter(m => m && m.question);

  const filteredList = marketList.filter(m => {
    const yesPrice = getYesNoPrices(m)?.yes || m.yesPrice || 0.5;
    return yesPrice <= 0.995 && yesPrice >= 0.005;
  });

  log(`DEBUG: Markets after extreme price filter: ${filteredList.length}`, 'DEBUG');

  const seen = new Set();
  const dedupedList = [];
  for (const m of filteredList) {
    const key = `${m.id}|${m.endDateIso || m.endDate}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedList.push(m);
    }
  }

  log(`DEBUG: Markets after deduplication: ${dedupedList.length}`, 'DEBUG');

  dynamicCategoryPriors = Object.keys(dynamicCategoryPriors).length ? dynamicCategoryPriors : safeBuildDynamicCategoryPriors(dedupedList);

  const baselineFlagged = dedupedList.filter(m => {
    const yesPrice = typeof m.yesPrice === 'number' && Number.isFinite(m.yesPrice) ? m.yesPrice : 0.5;
    const pPrior = getBaseRate(m.question, m);
    const edge = Math.abs(pPrior - yesPrice);
    const category = getCategoryKey(m.question, m);
    const edgeThreshold = getCategoryEdgeThreshold(category) / 100; // Convert percentage to decimal
    const liquidityFloor = computeCategoryLiquidityFloor(category, m);
    return edge > edgeThreshold && (m.liquidity || 0) > liquidityFloor;
  }).slice(0, 50);

  const priceSpikes = dedupedList
    .map(m => ({ market: m, drift: Math.abs(computePriceDrift(m)) }))
    .filter(entry => entry.drift > 0.03)
    .sort((a, b) => b.drift - a.drift)
    .slice(0, 20)
    .map(entry => entry.market);

  const volumeSpikes = dedupedList
    .map(m => {
      const vVel = computeVolumeVelocity(m);
      const baseline = Math.max(0.05, computeBaselineVolumeVelocity(m));
      return { market: m, vVel, baseline };
    })
    .filter(entry => entry.vVel > entry.baseline * 3 || entry.vVel > 0.6)
    .sort((a, b) => b.vVel - a.vVel)
    .slice(0, 20)
    .map(entry => entry.market);

  const deltaSnipers = dedupedList.filter(m => {
    const history = m.priceHistory || [];
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    const recent5min = history.filter(h => h.timestamp > fiveMinutesAgo);
    if (recent5min.length < 2) return false;
    const prices = recent5min.map(h => h.price || 0.5);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const delta = Math.abs(maxPrice - minPrice) / minPrice;
    return m.liquidity > 100000 ? delta > 0.02 : delta > 0.10;
  }).sort((a, b) => b.volume - a.volume).slice(0, 15);

  const newBlood = dedupedList.filter(m => {
    const startIso = getMarketStartDate(m);
    if (!startIso) return false;
    const start = new Date(startIso);
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    return start > fourHoursAgo;
  }).sort((a, b) => b.volume - a.volume).slice(0, 15);

  const now = Date.now();
  const discovery = dedupedList.filter(m => {
    const startIso = getMarketStartDate(m);
    if (!startIso) return false;
    const days = (now - new Date(startIso)) / (1000 * 60 * 60 * 24);
    return days > 0;
  }).sort((a, b) => {
    const edgeA = Math.abs(getBaseRate(a.question, a) - (a.yesPrice || 0.5));
    const edgeB = Math.abs(getBaseRate(b.question, b) - (b.yesPrice || 0.5));
    return edgeB - edgeA;
  }).slice(0, 15);

  const trends = dedupedList.filter(m => {
    const history = m.priceHistory || [];
    if (history.length < 5) {
      return typeof m.priceVolatility === 'number' && m.priceVolatility > 0.04;
    }
    const recent = history.slice(-5);
    const prices = recent.map(h => h.price || 0.5);
    const trend = prices.reduce((acc, price, i) => {
      if (i === 0) return acc;
      return acc + (price - prices[i-1]);
    }, 0) / (prices.length - 1);
    return Math.abs(trend) > 0.01;
  }).sort((a, b) => {
    const aTrend = detectTrend(a);
    const bTrend = detectTrend(b);
    return Math.abs(bTrend) - Math.abs(aTrend);
  }).slice(0, 15);

  let selected = [...baselineFlagged, ...priceSpikes, ...volumeSpikes, ...deltaSnipers, ...newBlood, ...discovery, ...trends];
  selected = selected.filter((m, index, self) => index === self.findIndex(s => s.id === m.id));

  selected = selected.filter(m => {
    const daysLeft = m.endDateIso ? (new Date(m.endDateIso) - Date.now()) / (1000 * 60 * 60 * 24) : 365;
    if (daysLeft < 7 || daysLeft > 365) return false;

    const pPrior = getBaseRate(m.question, m);
    const edge = Math.abs(pPrior - (m.yesPrice || 0.5));
    if (getCategoryKey(m.question, m) === 'CELEBRITY' && edge < 0.15) return false;
    if (getCategoryKey(m.question, m) === 'POLITICS' && edge < 0.08) return false;
    return true;
  });

  let selectedFiltered = selected.slice(0, 100);
  if (selectedFiltered.length < 50) {
    const needed = 50 - selectedFiltered.length;
    const selectedIds = new Set(selectedFiltered.map(m => m.id));
    const fallback = dedupedList
      .filter(m => !selectedIds.has(m.id))
      .sort((a, b) => Math.abs(getBaseRate(b.question, b) - (b.yesPrice || 0.5)) - Math.abs(getBaseRate(a.question, a) - (a.yesPrice || 0.5)))
      .slice(0, needed);
    selectedFiltered = [...selectedFiltered, ...fallback];
  }
  const diversified = enforceCategoryDiversity(selectedFiltered, dedupedList);
  return diversified.slice(0, 100);
}

function saveCycleData(data) {
  if (!supabase) return;
  supabase.from('cycle_snapshots').insert({ data }).then(({ error }) => {
    if (error) console.error('Error saving to Supabase:', error);
  }).catch(e => console.error('Failed to save cycle data:', e));
}

async function analyzeMarket(marketData) {
  const { market, event } = marketData;
  const description = event.description || market.question;
  const outcomes = market.outcomes;
  const analysis = await generateEnhancedAnalysis(market.question, description, outcomes);
  if (!analysis) return null;
  const parsed = parseAnalysis(analysis);
  const { probZigma, probMarket, effectiveEdge } = computeProbabilitiesAndEdge(parsed, market);
  const action = decideAction(probZigma, probMarket, effectiveEdge, market);
  const tier = getTradeTier(effectiveEdge, probZigma);
  const signal = {
    market: market.question,
    probZigma,
    probMarket,
    effectiveEdge,
    action,
    link: market.url || `https://polymarket.com/event/${event.slug}`,
    tier,
    custom: false,
  };
  return signal;
}

global.analyzeMarket = analyzeMarket;
global.fetchSearchMarkets = fetchSearchMarkets;
async function generateSignals(selectedMarkets) {
  const rawSignalData = [];
  let signalsGenerated = 0;

  for (const market of selectedMarkets) {
    // Filter out meme/joke markets
    if (isMemeMarket(market.question)) {
      log(`[FILTER] Skipping meme market: ${market.question}`, 'DEBUG');
      continue;
    }

    // Filter out low-quality markets before LLM analysis (saves costs, improves accuracy)
    const qualityScore = computeMarketQualityScore(market);
    const baseThreshold = selectedMarkets.length > 50 ? 25 : 15;
    const qualityThreshold = DATA_RICH_CATEGORIES.includes(getCategoryKey(market.question, market)) ? baseThreshold - 5 : baseThreshold;
    if (qualityScore < qualityThreshold) {
      log(`[FILTER] Skipping low-quality market (score=${qualityScore}, threshold=${qualityThreshold}): ${(market.question || '').slice(0, 50)}`, 'DEBUG');
      continue;
    }

    // Banned categories REMOVED - trust the LLM to analyze all markets
    // const bannedCategories = ['MACRO', 'WAR_OUTCOMES', 'POLITICS', 'CELEBRITY', 'TECH'];
    // if (bannedCategories.includes(categoryKey)) {
    //   log(`[FILTER] Skipping ${categoryKey} market (no edge): ${(market.question || '').slice(0, 50)}`);
    //   continue;
    // }

    const livePrice = getClobPrice(market.id) || market.yesPrice || 0.5;
    const cached = getAnalysisCache(market.id);
    let analysis = null;

    if (cached) {
      const timeDelta = Date.now() - cached.timestamp;
      const priceDelta = Math.abs(((livePrice - cached.last_price) / cached.last_price) * 100);
      // Tighter thresholds: 1% price change or 30 minutes
      if (priceDelta <= 1 && timeDelta <= 1800000) {
        try {
          analysis = { llmAnalysis: JSON.parse(cached.reasoning), probability: livePrice };
        } catch (e) {
          analysis = null;
        }
      }
    }

    if (!analysis) {
      const pBucketPrior = getBaseRate(market.question);
      if (Math.abs((market.yesPrice || 0.5) - pBucketPrior) < 0.05) continue;

      log(`[LLM] Analyzing: ${market.id} - ${market.question}`, 'INFO');

      let orderBook = {};
      try {
        const tokenId = market.tokens?.[0]?.token_id;
        orderBook = await fetchOrderBook(market.id, tokenId);
      } catch (e) {
        log(`Orderbook fetch failed for ${market.id}`);
      }

      let news = [];
      try {
        const newsResults = await crossReferenceNews(market);
        news = newsResults.slice(0, 5).map(r => ({title: r.title, snippet: r.snippet || ''}));
      } catch (e) {
        log(`News fetch failed for ${market.id}`);
      }

      const enhanced = await generateEnhancedAnalysis(market, orderBook, news);
      analysis = enhanced;
      saveAnalysisCache(market.id, livePrice, JSON.stringify(analysis.llmAnalysis || {}), analysis.llmAnalysis?.confidence || 50);
    }

    // Validate LLM analysis to prevent hallucinations and extreme predictions
    const validation = validateLLMAnalysis(analysis, market);
    if (!validation.valid) {
      log(`[VALIDATION] Rejected ${market.id}: ${validation.reason}`);
      continue;
    }

    ensureProbability(analysis, market);

    const marketAgeDays = (Date.now() - new Date(getMarketStartDate(market) || Date.now())) / (1000 * 60 * 60 * 24);
    // Confidence floor REMOVED - trust LLM's assessment
    // if ((analysis.llmAnalysis?.confidence || 0) < 35 || marketAgeDays < 1) continue;
    if (marketAgeDays < 1) continue;

    rawSignalData.push({ market, analysis });
  }

  // Sort rawSignalData by abs effective edge before grouping
  rawSignalData.sort((a, b) => {
    const edgeA = Math.abs(a.analysis?.llmAnalysis?.effectiveEdge ?? a.analysis?.effectiveEdge ?? 0);
    const edgeB = Math.abs(b.analysis?.llmAnalysis?.effectiveEdge ?? b.analysis?.effectiveEdge ?? 0);
    return edgeB - edgeA;
  });

  const executableTrades = [];
  const outlookSignals = [];
  const rejectedSignals = [];

  for (const data of rawSignalData) {
    const market = data.market;
    const analysis = data.analysis;
    const probability = ensureProbability(analysis, market);
    const yesPrice = getYesNoPrices(market)?.yes || market.yesPrice || 0.5;
    const confidence = analysis.confidence || analysis.llmAnalysis?.confidence || analysis.confidenceScore || 50;
    let normalizedConfidence = confidence > 1 ? confidence / 100 : confidence;

    // Category caps REMOVED - trust LLM confidence entirely
    const categoryKey = getCategoryKey(market.question, market);
    
    // DEBUG: Category classification logging
    log(`[DEBUG] Market: ${market.question}`, 'INFO');
    log(`[DEBUG] Category: ${categoryKey}`, 'INFO');
    log(`[DEBUG] In DATA_RICH: ${DATA_RICH_CATEGORIES.includes(categoryKey)}`, 'INFO');

    // Get delta adjustment from LLM analysis
    const delta = analysis.llmAnalysis?.delta || analysis.delta || 0;

    // Store raw LLM confidence for edge calculation (no blending)
    let rawLLMConfidence = normalizedConfidence;

    // Apply delta adjustment to confidence for edge calculation
    if (delta !== 0) {
      rawLLMConfidence = Math.max(0.01, Math.min(0.99, normalizedConfidence + delta));
      // Also apply delta to normalizedConfidence for confidencePercent calculation
      normalizedConfidence = rawLLMConfidence;
    }

    // Calculate raw edge using LLM probability (revised_prior) instead of confidence
    // If model probability > market price, edge is positive for YES
    // If model probability < market price, edge is negative for YES (positive for NO)
    const llmProbability = analysis.llmAnalysis?.revised_prior ?? analysis.probability ?? rawLLMConfidence;

    // Get order book for spread calculation
    const orderBook = getOrderBook(market.conditionId);

    // Calculate net edge after accounting for spread and fees
    const edgeAnalysis = computeNetEdge(llmProbability, yesPrice, orderBook || {});
    let rawEdge = edgeAnalysis.rawEdge;        // Signed (-1 to +1)
    let netEdge = edgeAnalysis.netEdge;        // Absolute, after costs
    const direction = edgeAnalysis.direction;    // 'BUY_YES' or 'BUY_NO'
    const isExecutable = edgeAnalysis.isExecutable;

    // Apply category-specific edge adjustment based on historical accuracy
    const categoryAdjustment = getCategoryEdgeAdjustment(categoryKey);
    const adjustedEdge = rawEdge * categoryAdjustment.adjustment;
    rawEdge = adjustedEdge; // Use adjusted edge for all subsequent calculations
    netEdge = Math.abs(adjustedEdge) - edgeAnalysis.executionCost; // Recalculate net edge
    netEdge = Math.max(0, netEdge); // Ensure non-negative
    
    console.log(`[EDGE] ${categoryKey} adjustment: ${categoryAdjustment.adjustment}x (${categoryAdjustment.reason})`);
    console.log(`[EDGE] Original: ${(edgeAnalysis.rawEdge * 100).toFixed(2)}% → Adjusted: ${(rawEdge * 100).toFixed(2)}%`);

    const categoryEdgeThreshold = getCategoryEdgeThreshold(categoryKey);

    // CRITICAL: Set action based on direction
    // rawEdge and categoryEdgeThreshold are both decimals (0-1 scale)
    let action = 'SKIP_NO_TRADE';
    if (isExecutable && Math.abs(rawEdge) >= categoryEdgeThreshold) {
      action = direction === 'BUY_YES' ? 'EXECUTE BUY YES' : 'EXECUTE BUY NO';
    }

    // Calculate winProb and betPrice BASED ON ACTION
    let winProb, betPrice;
    if (action === 'EXECUTE BUY YES') {
      winProb = llmProbability;      // Probability YES wins
      betPrice = yesPrice;            // Price you pay for YES
    } else if (action === 'EXECUTE BUY NO') {
      winProb = 1 - llmProbability;   // Probability NO wins (YES loses)
      betPrice = 1 - yesPrice;        // Price you pay for NO
    } else {
      winProb = llmProbability;
      betPrice = yesPrice;
    }

    const absEdge = Math.abs(rawEdge);

    const daysToResolution = market.endDateIso
      ? Math.max(0, (new Date(market.endDateIso) - Date.now()) / (1000 * 60 * 60 * 24))
      : market.endDate
        ? Math.max(0, (new Date(market.endDate) - Date.now()) / (1000 * 60 * 60 * 24))
        : 365;
    const horizonDiscount = computeHorizonDiscount(daysToResolution);

    normalizedConfidence = clamp(normalizedConfidence, 0.01, 1);
    const confidencePercent = Math.round(normalizedConfidence * 100);

    // Calculate uncertainty bands (confidence intervals)
    const uncertaintyMargin = (1 - normalizedConfidence) * UNCERTAINTY_MARGIN;
    const lowerBound = Math.max(0.01, normalizedConfidence - uncertaintyMargin);
    const upperBound = Math.min(0.99, normalizedConfidence + uncertaintyMargin);
    const uncertaintyBand = {
      lower: Number((lowerBound * 100).toFixed(1)),
      upper: Number((upperBound * 100).toFixed(1)),
      margin: Number((uncertaintyMargin * 100).toFixed(1))
    };

    const marketOdds = yesPrice * 100;
    // Tail market handling - only skip if edge is weak, otherwise reduce exposure
    const isTailMarket = (marketOdds < 3 || marketOdds > 97) && confidencePercent < 70;

    if (isTailMarket) {
      // Only skip if edge is also weak (< 8%)
      if (Math.abs(rawEdge) < 0.08) {
        log(`[SKIP] Tail market with insufficient edge: ${market.question.slice(0, 40)} (odds: ${marketOdds.toFixed(1)}%, conf: ${confidencePercent}%, edge: ${(rawEdge * 100).toFixed(2)}%)`);

        rejectedSignals.push({
          marketId: market.id,
          marketSlug: market.slug,
          marketQuestion: market.question,
          action,
          price: yesPrice,
          confidenceScore: confidencePercent,
          marketOdds,
          reason: 'TAIL_MARKET_LOW_EDGE',
          details: `Tail market at ${marketOdds.toFixed(1)}% with ${(rawEdge * 100).toFixed(2)}% edge requires 8% minimum`,
          timestamp: new Date().toISOString()
        });
        continue;
      } else {
        // Reduce exposure by 50% for tail markets with strong edge
        log(`[WARNING] Tail market with strong edge - reducing exposure by 50%: ${market.question.slice(0, 40)} (odds: ${marketOdds.toFixed(1)}%, conf: ${confidencePercent}%)`, 'WARN');
        // Will apply exposure reduction later after intentExposure is calculated
      }
    }

    let adaptiveLearning = applyAdaptiveLearning(categoryKey, action, absEdge, confidencePercent);
    
    // DEBUG: Adaptive learning logging
    log(`[DEBUG] Adaptive Learning Input: cat=${categoryKey}, action=${action}, edge=${absEdge.toFixed(4)}, conf=${confidencePercent}`, 'DEBUG');
    log(`[DEBUG] Adaptive Learning Output: ${JSON.stringify(adaptiveLearning)}`, 'DEBUG');
    
    // Defensive validation of adaptive learning result
    if (!adaptiveLearning || typeof adaptiveLearning !== 'object' ||
        typeof adaptiveLearning.adjustedEdge !== 'number' ||
        typeof adaptiveLearning.adjustedConfidence !== 'number') {
      log(`[WARNING] Adaptive learning failed for ${market.id}, using raw values`, 'WARN');
      adaptiveLearning = { 
        adjustedEdge: absEdge, 
        adjustedConfidence: confidencePercent,
        sampleSize: 0,
        message: 'Fallback - adaptive learning unavailable'
      };
    }
    const effectiveEdge = typeof adaptiveLearning?.adjustedEdge === 'number' ? adaptiveLearning.adjustedEdge : rawEdge;
    const adjustedConfidence = clamp(
      typeof adaptiveLearning?.adjustedConfidence === 'number' ? adaptiveLearning.adjustedConfidence / 100 : normalizedConfidence,
      0.01,
      0.99
    );

    // POSITION SIZING HIERARCHY
    // Step 1: Calculate base Kelly fraction based on ACTUAL bet
    let kellyFraction = calculateKelly(winProb, betPrice, 0, market.liquidity || 10000);
    log(`[POSITION SIZING] Step 1 - Base Kelly: ${(kellyFraction * 100).toFixed(2)}%`);

    // Step 2: Apply conviction adjustments (before hard cap)
    const liquidity = market.liquidity || 0;
    let convictionBoost = 1.0;
    
    // DEBUG: Liquidity and conviction boost logging
    log(`[DEBUG] Liquidity: ${liquidity}, Threshold: HIGH=${HIGH_LIQUIDITY_THRESHOLD}, LOW=${LOW_LIQUIDITY_THRESHOLD}`, 'INFO');

    if (DATA_RICH_CATEGORIES.includes(categoryKey)) {
      if (liquidity > HIGH_LIQUIDITY_THRESHOLD) convictionBoost = CONVICTION_BOOST_HIGH;
      else if (liquidity > LOW_LIQUIDITY_THRESHOLD) convictionBoost = CONVICTION_BOOST_MEDIUM;
      else if (liquidity > LOW_LIQUIDITY_THRESHOLD / 2) convictionBoost = CONVICTION_BOOST_LOW;
    }
    
    log(`[DEBUG] Conviction Boost Calculated: ${convictionBoost}`, 'INFO');

    let intentExposure = kellyFraction * convictionBoost;
    log(`[POSITION SIZING] Step 2 - After conviction boost (${convictionBoost.toFixed(2)}x): ${(intentExposure * 100).toFixed(2)}%`);

    // Step 3: Apply liquidity constraints (hard cap - cannot be exceeded)
    const maxExposure = (market.liquidity || 0) < LOW_LIQUIDITY_THRESHOLD ? MAX_EXPOSURE_LOW_LIQUIDITY : MAX_EXPOSURE_HIGH_LIQUIDITY;
    intentExposure = Math.min(maxExposure, intentExposure);
    log(`[POSITION SIZING] Step 3 - After liquidity cap: ${(intentExposure * 100).toFixed(2)}% (max: ${(maxExposure * 100).toFixed(2)}%)`);

    // Step 4: Apply tail market exposure reduction (if applicable)
    if (isTailMarket && Math.abs(rawEdge) >= 0.08) {
      intentExposure *= 0.5; // Reduce exposure by 50% for tail markets with strong edge
      log(`[POSITION SIZING] Step 4 - After tail market reduction: ${(intentExposure * 100).toFixed(2)}%`);
    }

    const boostedConfidenceScore = Math.min(100, confidencePercent * convictionBoost);

    const cluster = getClusterForCategory(market.category);

    // Create signal with CORRECT edge values (using adaptive learning adjustments)
    // Create signal with CORRECT edge values (using adaptive learning adjustments)
    // UNITS: edgeScore/rawEdge/effectiveEdge are PERCENTAGES (0-100)
    // UNITS: edgeScoreDecimal/rawEdgeDecimal are DECIMALS (0-1)
    const signal = {
      marketId: market.id,
      marketSlug: market.slug,
      marketQuestion: market.question,
      action,
      price: yesPrice,
      confidenceClass: normalizedConfidence >= 0.7 ? 'HIGH' : normalizedConfidence >= 0.4 ? 'MEDIUM' : 'LOW',
      intentExposure,
      edgeScore: Math.abs(effectiveEdge) * 100,       // PERCENTAGE (0-100)
      edgeScoreDecimal: Math.abs(effectiveEdge),      // DECIMAL (0-1) for threshold comparisons
      rawEdge: rawEdge * 100,                         // PERCENTAGE - signed for reference
      rawEdgeDecimal: rawEdge,                        // DECIMAL - signed
      confidenceScore: Number((adjustedConfidence * 100).toFixed(1)),
      tradeDecision: action,
      modelConfidence: Number((adjustedConfidence * 100).toFixed(1)),
      executionConfidence: Number((adjustedConfidence * 100).toFixed(1)),
      tradeTier: getTradeTier(netEdge, adjustedConfidence),
      effectiveEdge: netEdge * 100,                   // Net edge after costs
      adaptiveLearning: {
        applied: true,
        originalEdge: absEdge,
        adjustedEdge: Math.abs(effectiveEdge),
        adjustment: Math.abs(effectiveEdge) - absEdge
      },
      structuredAnalysis: {
        probability: winProb, // Use original LLM probability
        action,
        confidence: Number((adjustedConfidence * 100).toFixed(1)),
        reasoning: '', // Not used in this code
        kellyFraction: intentExposure,
        baseEffectiveEdge: netEdge,
        effectiveEdge: netEdge, // Both point to same netEdge value
        edge: {
          marketImplied: yesPrice,
          zigmaFair: llmProbability,
          rawEdge: rawEdge,
          netEdge: netEdge,
          spreadCost: edgeAnalysis.spreadCost,
          fees: 0.02, // 2% Polymarket fee
          slippage: 0.005, // Estimated 0.5% slippage
          effectiveEdge: netEdge - 0.02 - 0.005 // After fees and slippage
        },
        entropy: '', // Not used in this code
        sentimentScore: '', // Not used in this code
        adaptiveLearning: adaptiveLearning,
        calibration: {
          confidence: Number((adjustedConfidence * 100).toFixed(2)),
        },
        directionalBias: {
          buyNoCount: 0,
          buyYesCount: 0,
          totalSignals: 0
        }
      },
      cluster
    };

    // Update directional bias tracking
    if (action === 'EXECUTE BUY NO') {
      signal.structuredAnalysis.directionalBias.buyNoCount++;
    } else if (action === 'EXECUTE BUY YES') {
      signal.structuredAnalysis.directionalBias.buyYesCount++;
    }
    signal.structuredAnalysis.directionalBias.totalSignals++;

    // ...
    const signalTimestamp = new Date().toISOString();

    // Dynamic confidence threshold based on category and RAW edge (not adjusted)
    let confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD;

    if (DATA_RICH_CATEGORIES.includes(categoryKey)) {
      // For data-rich categories, reduce threshold based on edge strength
      // High edge (>=10%) allows lower conviction threshold
      const edge = absEdge; // Use the already-calculated absolute edge
      if (edge >= EDGE_THRESHOLD_HIGH) confidenceThreshold = 0.35; // 35% threshold
      else if (edge >= EDGE_THRESHOLD_MEDIUM_HIGH) confidenceThreshold = 0.40; // 40% threshold
      else if (edge >= MEDIUM_EDGE_THRESHOLD) confidenceThreshold = 0.45; // 45% threshold
      else confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD; // Still need 50% for low edge
    }

    // Debug decision should match shouldExecuteTrade logic
    const edgeDecimal = Math.abs(effectiveEdge);
    const meetsEdgeThreshold = edgeDecimal >= categoryEdgeThreshold;
    const meetsNetEdge = netEdge >= MIN_NET_EDGE;
    const meetsExposure = signal.intentExposure >= PROBE_EXPOSURE;
    const meetsValidTier = ['STRONG_TRADE', 'SMALL_TRADE', 'PROBE'].includes(signal.tradeTier);
    const debugDecision = (meetsEdgeThreshold && meetsNetEdge && meetsExposure && meetsValidTier) ? 'EXECUTABLE' : 'DROPPED';

    // Debug log with CORRECT values
    log(`[DEBUG] ${market.question.slice(0, 50)} | ` +
        `Edge ${(rawEdge * 100).toFixed(2)}% (${direction}) | ` +
        `Net ${(netEdge * 100).toFixed(2)}% | ` +
        `Exposure ${(signal.intentExposure * 100).toFixed(2)}% | ` +
        `Conf ${signal.confidenceScore.toFixed(1)}% | ` +
        `Tier ${signal.tradeTier} â†’ ${debugDecision}`, 'DEBUG');

    if (process.env.SAFE_MODE !== 'true' && ['STRONG_TRADE', 'SMALL_TRADE', 'PROBE'].includes(signal.tradeTier)) {
      const tweet = ` AGENT ZIGMA SIGNAL
Market: ${(market.question || '').slice(0, 50)}
Market Odds (YES): ${(yesPrice * 100).toFixed(1)}%
ZIGMA Odds (YES): ${(winProb * 100).toFixed(1)}%
Edge: ${(rawEdge > 0 ? '+' : '')}${(rawEdge * 100).toFixed(1)}%
Action: ${action === 'SKIP_NO_TRADE' ? 'NO TRADE' : action.replace('EXECUTE ', '')}
Tier: ${signal.tradeTier}
Exposure: ${signal.intentExposure.toFixed(1)}%`;
      try {
        await postToX(tweet);
        signalsGenerated++;
      } catch (e) {
        log(`Failed to post to X: ${e.message}`);
      }
    }

    const signalWithMarket = {
      ...signal,
      market: market.question || 'Unknown',
      timestamp: signalTimestamp,
      probZigma: winProb * 100,
      probMarket: yesPrice * 100,
      effectiveEdge: netEdge * 100,
      rawEdge: rawEdge * 100,
      link: buildPolymarketUrl(market.slug, market.question),
      cluster: getClusterForCategory(market.category)
    };

    // Use simplified execution logic
    if (shouldExecuteTrade(signal, market)) {
      if (signal.tradeTier === 'PROBE' && Math.abs(rawEdge) > PROBE_EDGE_THRESHOLD) {
        signal.tradeTier = 'MEDIUM_TRADE';
      }
      executableTrades.push(signalWithMarket);
    } else {
      outlookSignals.push(signalWithMarket);
    }
  }

  applyClusterDampening(executableTrades);
  applyClusterDampening(outlookSignals);
  applyGlobalExposureCap(executableTrades);

  return {
    executableTrades,
    outlookSignals,
    rejectedSignals,
    signalsGenerated
  };
}

function shouldExecuteTrade(signal, market) {
  const categoryKey = getCategoryKey(market.question, market);
  const categoryEdgeThreshold = getCategoryEdgeThreshold(categoryKey);

  // FIX: Convert edgeScore from percentage to decimal for comparison
  // edgeScore is stored as percentage (0-100), threshold is decimal (0-1)
  const edgeScoreDecimal = signal.edgeScoreDecimal ?? (Math.abs(signal.edgeScore) / 100);
  if (edgeScoreDecimal < categoryEdgeThreshold) {
    log(`[SKIP] Edge ${(edgeScoreDecimal * 100).toFixed(2)}% below threshold ${(categoryEdgeThreshold * 100).toFixed(2)}%`, 'DEBUG');
    return false;
  }

  // Check minimum net edge after costs (1.5% threshold)
  // effectiveEdge is stored as percentage (0-100)
  const netEdgePercent = signal.effectiveEdge || 0;
  if (netEdgePercent < MIN_NET_EDGE * 100) {
    log(`[SKIP] Net edge too small: ${netEdgePercent.toFixed(2)}% (minimum: ${(MIN_NET_EDGE * 100).toFixed(2)}%)`, 'DEBUG');
    return false;
  }

  if (signal.intentExposure < PROBE_EXPOSURE) return false;

  if (!['STRONG_TRADE', 'SMALL_TRADE', 'PROBE'].includes(signal.tradeTier)) return false;

  const now = Date.now();
  const endDate = Date.parse(market.endDateIso || market.endDate || '');
  if (endDate && endDate <= now) return false;

  return true;
}

// Apply correlation cluster dampening - keep best signal at 100%, dampen others
function applyClusterDampening(trades) {
  const clusters = {};
  trades.forEach(trade => {
    const cluster = trade.cluster;
    if (!clusters[cluster]) clusters[cluster] = [];
    clusters[cluster].push(trade);
  });

  Object.keys(clusters).forEach(cluster => {
    const clusterTrades = clusters[cluster];
    clusterTrades.sort((a, b) => b.intentExposure - a.intentExposure);
    const bestTrade = clusterTrades[0];
    clusterTrades.forEach(trade => {
      if (trade !== bestTrade) {
        trade.intentExposure *= 0.75; // Changed from 0.5 to 0.75
      }
    });
  });
}

// Apply global exposure cap (e.g., 100% of bankroll) across executable trades
function applyGlobalExposureCap(trades) {
  const MAX_CYCLE_EXPOSURE = 1.0; // 100% bankroll cap
  const totalExposure = trades.reduce((sum, trade) => sum + (trade.intentExposure || 0), 0);
  if (totalExposure > MAX_CYCLE_EXPOSURE) {
    const scale = MAX_CYCLE_EXPOSURE / totalExposure;
    trades.forEach(trade => {
      trade.intentExposure = Number((trade.intentExposure * scale).toFixed(4));
    });
  }
}

const ARBITRAGE_THRESHOLD = 0.02; // 2% minimum spread arbitrage
const SPREAD_HISTORY_WINDOW = 300000; // 5 minutes in ms
const ORDER_BOOK_DEPTH = 10; // Track top 10 levels

function detectSpreadArbitrage(market) {
  // POLYMARKET PRO: Use real order book data from CLOB
  const orderBook = getOrderBook(market.conditionId) || getOrderBook(market.id);
  
  if (!orderBook || !orderBook.bids || !orderBook.asks) return null;
  
  // Calculate best bid/ask mid price
  const bestBid = orderBook.bids[0]?.price || 0;
  const bestAsk = orderBook.asks[0]?.price || 0;
  const midPrice = (bestBid + bestAsk) / 2;
  
  if (!bestBid || !bestAsk || bestBid >= bestAsk) return null;
  
  // Calculate spread percentage
  const spreadPct = ((bestAsk - bestBid) / midPrice) * 100;
  
  // Check for arbitrage opportunity
  if (spreadPct > ARBITRAGE_THRESHOLD) {
    // Calculate theoretical arbitrage profit
    const theoreticalProfit = (spreadPct - 2) * 0.5; // After 2% fees
    
    return {
      marketId: market.id,
      marketQuestion: market.question,
      spreadPct,
      theoreticalProfit,
      liquidity: market.liquidity || 0,
      orderBookDepth: {
        bidSize: orderBook.bids[0]?.size || 0,
        askSize: orderBook.asks[0]?.size || 0,
        bidLevels: orderBook.bids.length,
        askLevels: orderBook.asks.length
      },
      timestamp: Date.now(),
      isExecutable: theoreticalProfit > 1.0 && (market.liquidity || 0) > 25000
    };
  }

  return null;
}

function filterHighValueMarkets(markets = []) {
  log(`[INFO] filterHighValueMarkets: Processing ${markets.length} markets`);
  
  const filtered = markets.filter(market => {
    const liquidity = Number(market.liquidity) || 0;
    if (liquidity < MIN_LIQUIDITY_THRESHOLD) {
      log(`[INFO] Market ${market.question?.slice(0, 30)}... rejected: liquidity $${liquidity} < $${MIN_LIQUIDITY_THRESHOLD}`);
      return false;
    }
    
    const volumeVelocity = computeVolumeVelocity(market);
    if (volumeVelocity < MIN_VOLUME_VELOCITY) {
      log(`[INFO] Market ${market.question?.slice(0, 30)}... rejected: volume velocity $${volumeVelocity} < $${MIN_VOLUME_VELOCITY}`);
      return false;
    }
    
    const category = getCategoryKey(market.question, market);
    if (!PRIORITY_CATEGORIES.includes(category)) {
      log(`[INFO] Market ${market.question?.slice(0, 30)}... rejected: category ${category} not in priority list`);
      return false;
    }
    
    log(`[INFO] Market ${market.question?.slice(0, 30)}... PASSED all filters`);
    return true;
  });
  
  log(`[INFO] filterHighValueMarkets: ${filtered.length} markets passed filters`);
  return filtered;
}

function trackSpreadOpportunities(arbitrageOpportunities = []) {
  return arbitrageOpportunities
    .filter(opp => opp.isExecutable)
    .sort((a, b) => b.theoreticalProfit - a.theoreticalProfit)
    .slice(0, 5); // Top 5 opportunities
}

async function runCycle() {
  if (isRunning) return;
  isRunning = true;
  let markets = [];
  try {
    // ...
    const rawMarkets = await fetchAllMarkets();
    markets = rawMarkets;

    let lastSnapshot = {};
    if (fsSync.existsSync(SNAPSHOT_FILE)) {
      try {
        lastSnapshot = JSON.parse(fsSync.readFileSync(SNAPSHOT_FILE, 'utf8') || '{}');
      } catch (e) {
        log('Failed to parse last snapshot');
      }
    }

    const result = await computeMetrics(rawMarkets, lastSnapshot);
    const enriched = Array.isArray(result) ? result : [];
    log(`FETCH SUMMARY | total=${enriched.length}`);
    if (!enriched.length) {
      log("No markets fetched â€” skipping analysis cycle");
      isRunning = false;
      return;
    }

    // POLYMARKET PRO MOVE: Filter for high-value markets first
    const highValueMarkets = filterHighValueMarkets(enriched);
    log(`HIGH-VALUE FILTER: ${highValueMarkets.length}/${enriched.length} markets meet liquidity thresholds`);
    
    // POLYMARKET PRO MOVE: Detect spread arbitrage opportunities
    const arbitrageOpportunities = highValueMarkets
      .map(market => detectSpreadArbitrage(market))
      .filter(opp => opp !== null);
    
    const topArbitrageOpportunities = trackSpreadOpportunities(arbitrageOpportunities);
    if (topArbitrageOpportunities.length > 0) {
      log(` ARBITRAGE OPPORTUNITIES: ${topArbitrageOpportunities.length} found`);
      topArbitrageOpportunities.forEach((opp, i) => {
        log(`  #${i+1} ${opp.marketQuestion.slice(0, 50)}... | Spread: ${opp.spreadPct.toFixed(2)}% | Profit: ${opp.theoreticalProfit.toFixed(2)}% | Liquidity: $${(opp.liquidity/1000).toFixed(0)}K`);
      });
    }
    
    // Use safe update function to prevent race conditions
    await safeUpdateCategoryPerformance(highValueMarkets);
    dynamicCategoryPriors = await safeBuildDynamicCategoryPriors(highValueMarkets);

    highValueMarkets.forEach(m => {
      const prices = getYesNoPrices(m);
      if (prices) {
        m.yesPrice = prices.yes;
        m.noPrice = prices.no;
        m.settlementRisk = settlementRisk(m.question);
        m.category = classifyMarket(m.question);

        if (Math.abs((m.yesPrice + m.noPrice) - 1) > 0.01) {
          log(`ARBITRAGE ALERT: ${m.question} YES+NO â‰ 1 (vig: ${Math.abs((m.yesPrice + m.noPrice) - 1).toFixed(4)})`);
        }

        if (!m.startDateIso) {
          const fallbackStart = getMarketStartDate(m);
          if (fallbackStart) m.startDateIso = fallbackStart;
        }

        const snapshotEntry = lastSnapshot?.[m.id];
        if (snapshotEntry) {
          if ((!Array.isArray(m.priceHistory) || m.priceHistory.length === 0) && Array.isArray(snapshotEntry.priceHistory)) {
            m.priceHistory = snapshotEntry.priceHistory;
          }
          if ((!Array.isArray(m.volumeHistory) || m.volumeHistory.length === 0) && Array.isArray(snapshotEntry.volumeHistory)) {
            m.volumeHistory = snapshotEntry.volumeHistory;
          }
          if (typeof m.avgVvel !== 'number' && typeof snapshotEntry.avgVvel === 'number') {
            m.avgVvel = snapshotEntry.avgVvel;
          }
          if (typeof m.vVel !== 'number' && typeof snapshotEntry.vVel === 'number') {
            m.vVel = snapshotEntry.vVel;
          }
          if (!m.startDateIso && snapshotEntry.startDateIso) {
            m.startDateIso = snapshotEntry.startDateIso;
          }
        } else {
          m.priceHistory = m.priceHistory || [];
          m.volumeHistory = m.volumeHistory || [];
        }
      }
    });

    const marketGroups = {};
    highValueMarkets.forEach(m => {
      const category = getCategoryKey(m.question, m);
      if (!marketGroups[category]) marketGroups[category] = [];
      marketGroups[category].push(m);
    });

    const avgVolatility = highValueMarkets.reduce((sum, m) => sum + (m.priceVolatility || 0), 0) / highValueMarkets.length;
    const avgLiquidity = highValueMarkets.reduce((sum, m) => sum + (m.liquidity || 0), 0) / highValueMarkets.length;
    isVolatilityLock = avgVolatility > 0.1;
    isLiquidityShock = avgLiquidity < 50000;

    const selectedMarkets = pickHighAlphaMarkets(highValueMarkets, marketGroups).filter(m => (m.volume || 0) > 1000);
    log(` Selected ${selectedMarkets.length} markets for deep analysis`);
    
    // Apply cluster filtering BEFORE LLM analysis to save costs
    const clusterFiltered = applyPreAnalysisClusterFilter(selectedMarkets);
    log(` After cluster filtering: ${clusterFiltered.length} markets remain for LLM analysis`);

    activeGroupSizes = computeGroupSizeMap(clusterFiltered);

    if (clusterFiltered.length === 0) {
      noSignalCycles++;
      if (noSignalCycles > 5) isNoSignalMode = true;
    } else {
      noSignalCycles = 0;
      isNoSignalMode = false;
    }

    const { executableTrades, outlookSignals, rejectedSignals, signalsGenerated } = await generateSignals(clusterFiltered);

    const lastRunTimestamp = new Date().toISOString();

    global.latestData = {
      cycleSummary: {
        marketsFetched: markets.length,
        marketsEligible: selectedMarkets.length,
        marketsAnalyzed: clusterFiltered.length,
        signalsGenerated,
        watchlist: executableTrades.length,
        outlook: outlookSignals.length,
        rejected: rejectedSignals.length
      },
      liveSignals: executableTrades,
      marketOutlook: outlookSignals,
      rejectedSignals,
      lastRun: lastRunTimestamp,
      marketsMonitored: clusterFiltered.length,
      posts: signalsGenerated
    };

    saveCycleData(global.latestData);
    recordCycleSnapshot(global.latestData);

    try {
      const customFile = path.join(__dirname, '..', 'cache', 'custom_signals.json');
      if (fsSync.existsSync(customFile)) {
        const customSignals = JSON.parse(fsSync.readFileSync(customFile, 'utf8'));
        global.latestData.liveSignals = [...customSignals, ...global.latestData.liveSignals];
      }
    } catch (e) {
      console.error('Error loading custom signals:', e);
    }

    updateHealthMetrics({
      lastRun: lastRunTimestamp,
      marketsMonitored: clusterFiltered.length,
      posts: signalsGenerated
    });

    log("âœ… Cycle complete");
  } catch (error) {
    log(`CRITICAL CYCLE ERROR: ${error.message}\n${error.stack}`, 'ERROR');
  } finally {
    isRunning = false;
  }
}

async function main() {
  try {
    log("Agent Zigma starting...");
    startPolling?.();
    startServer?.();
    startResolutionTracker(); // Start resolution tracking
    await queuedRunCycle();

    const cronExpression = process.env.CRON_SCHEDULE || '0 */6 * * *';
    cron.schedule(cronExpression, queuedRunCycle);
    log(`Agent Zigma scheduled cadence: ${cronExpression}`);
  } catch (err) {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  }
}

main();