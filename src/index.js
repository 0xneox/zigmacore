const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { BoundedMap } = require('./utils/bounded-map');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const INSIGHTS_FILE = path.join(__dirname, '..', 'oracle_insights.txt');
const CONSOLE_LOG_FILE = path.join(__dirname, '..', 'console_output.log');
const PERSONAL_TRADES_FILE = path.join(__dirname, '..', 'personal_trades.txt');
const TRACK_LOG_FILE = path.join(__dirname, '..', 'trades.log');
const AUDIT_LOG_FILE = path.join(__dirname, '..', 'audit_trails.log');
const SNAPSHOT_FILE = path.join(CACHE_DIR, 'last_snapshot.json');
const CATEGORY_PERFORMANCE_FILE = path.join(CACHE_DIR, 'category_performance.json');
const CYCLE_SNAPSHOT_FILE = path.join(CACHE_DIR, 'latest_cycle.json');
const CYCLE_HISTORY_FILE = path.join(CACHE_DIR, 'cycle_history.json');

const LOG_LEVEL = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
const LOG_TO_CONSOLE = LOG_LEVEL === 'DEBUG' || process.env.NODE_ENV === 'development';

const log = (msg) => { 
  const timestamped = `[${new Date().toISOString()}] ${msg}`;
  try {
    fs.appendFileSync(CONSOLE_LOG_FILE, timestamped + '\n');
  } catch (err) {
    console.error('Failed to write log:', err.message);
  }
  if (LOG_TO_CONSOLE) console.log(timestamped); 
};

const cron = require('node-cron');

const { fetchAllMarkets, fetchTags, fetchSearchMarkets } = require('./fetcher');
const { computeMetrics } = require('./utils/metrics');
const { savePriceCache, loadCache, saveAnalysisCache, getAnalysisCache, saveTradeSignal } = require('./db');
const { generateDecrees, generateEnhancedAnalysis } = require('./llm');
const { postToX } = require('./poster');
const { calculateKelly } = require('./market_analysis');
const { getClobPrice, startPolling, getOrderBook, fetchOrderBook } = require('./clob_price_cache');
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

const ensureCacheDir = () => {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to ensure cache directory:', err.message);
  }
};
ensureCacheDir();

const loadJsonFile = (filePath, fallback) => {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to load JSON from ${filePath}:`, err.message);
    return fallback;
  }
};
const saveJsonFile = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to persist JSON to ${filePath}:`, err.message);
  }
};

const trimArray = (value, limit = 25) =>
  Array.isArray(value) ? value.slice(0, Math.max(0, limit)) : [];

function computeHorizonDiscount(daysToResolution) {
  // No horizon discount for MVP - always return 1.0
  return 1.0;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PROBABILITY_FLOOR = 0.0001;
const POLYMARKET_BASE_URL = 'https://polymarket.com';

const CORRELATION_CLUSTERS = {
  politics: ['POLITICS', 'WAR_OUTCOMES'],
  crypto: ['CRYPTO', 'ETF_APPROVAL']
};

const CATEGORY_CLUSTER_MAP = Object.entries(CORRELATION_CLUSTERS).reduce((acc, [cluster, cats]) => {
  cats.forEach(cat => { acc[cat] = cluster; });
  return acc;
}, {});

const CLUSTER_PENALTY_STEPS = [1, 0.9, 0.7];
const CLUSTER_PENALTY_FLOOR = 0.5;

function getClusterForCategory(category = '') {
  if (!category) return null;
  return CATEGORY_CLUSTER_MAP[category.toUpperCase()] || null;
}

function applyClusterDampening(signals = []) {
  const seen = {};
  for (const signal of signals) {
    const cluster = signal?.cluster;
    if (!cluster) continue;
    seen[cluster] = (seen[cluster] || 0) + 1;
    const idx = seen[cluster] - 1;
    const penalty = idx < CLUSTER_PENALTY_STEPS.length
      ? CLUSTER_PENALTY_STEPS[idx]
      : CLUSTER_PENALTY_FLOOR;
    if (typeof signal.intentExposure === 'number') {
      signal.intentExposure = Number((signal.intentExposure * penalty).toFixed(4));
    }
    if (typeof signal.effectiveEdge === 'number') {
      signal.effectiveEdge = Number((signal.effectiveEdge * penalty).toFixed(2));
    }
    if (typeof signal.edgeScore === 'number') {
      signal.edgeScore = Number((signal.edgeScore * penalty).toFixed(2));
    }
    if (typeof signal.finalEffectiveEdge === 'number') {
      signal.finalEffectiveEdge = Number((signal.finalEffectiveEdge * penalty).toFixed(2));
    }
  }
}

const PRIOR_BUCKETS = {
  MACRO: [0.10, 0.35],
  POLITICS: [0.05, 0.25],
  SPORTS_FUTURES: [0.02, 0.15],
  CRYPTO: [0.15, 0.45],
  CELEBRITY: [0.01, 0.10],
  TECH: [0.08, 0.35],
  ENTERTAINMENT: [0.03, 0.18],
  TECH_ADOPTION: [0.10, 0.40],
  ETF_APPROVAL: [0.20, 0.60],
  WAR_OUTCOMES: [0.05, 0.30],
  EVENT: [0.05, 0.25],
  OTHER: [0.05, 0.20]
};

const CATEGORY_EDGE_CONFIG = {
  SPORTS_FUTURES: { base: 0.05, low: 0.02, hiLiquidity: 150000 },
  POLITICS: { base: 0.04, low: 0.0225, hiLiquidity: 120000 },
  MACRO: { base: 0.035, low: 0.02, hiLiquidity: 100000 },
  CRYPTO: { base: 0.04, low: 0.025, hiLiquidity: 90000 },
  TECH: { base: 0.035, low: 0.02, hiLiquidity: 80000 },
  TECH_ADOPTION: { base: 0.035, low: 0.02, hiLiquidity: 80000 },
  ETF_APPROVAL: { base: 0.04, low: 0.025, hiLiquidity: 80000 },
  ENTERTAINMENT: { base: 0.05, low: 0.03, hiLiquidity: 60000 },
  CELEBRITY: { base: 0.05, low: 0.035, hiLiquidity: 40000 },
  WAR_OUTCOMES: { base: 0.045, low: 0.03, hiLiquidity: 70000 },
  EVENT: { base: 0.05, low: 0.03, hiLiquidity: 60000 },
  OTHER: { base: 0.05, low: 0.035, hiLiquidity: 60000 }
};
const DEFAULT_EDGE_CONFIG = { base: 0.05, low: 0.03, hiLiquidity: 60000 };

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

  while (cycleQueue.length > 0) {
    const resolve = cycleQueue.shift();
    await runCycle();
    resolve();
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
    return JSON.parse(fs.readFileSync(CATEGORY_PERFORMANCE_FILE, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function saveCategoryPerformance(data = {}) {
  try {
    fs.mkdirSync(path.dirname(CATEGORY_PERFORMANCE_FILE), { recursive: true });
    fs.writeFileSync(CATEGORY_PERFORMANCE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to persist category performance cache:', err.message);
  }
}

function getStaticBucketPrior(categoryKey) {
  const bucket = PRIOR_BUCKETS[categoryKey] || [0.05, 0.20];
  return (bucket[0] + bucket[1]) / 2;
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
  console.log(`Category for ${question}: ${category}`);
  return category || 'OTHER';
}

function settlementRisk(question) {
  if (!question) return 'MEDIUM';
  const q = question.toLowerCase();
  if (/will.*win|who.*win|best.*movie/i.test(q)) return 'HIGH';
  if (/price.*above|will.*reach/i.test(q) && /\$.*\d+/i.test(q)) return 'LOW';
  return 'MEDIUM';
}

function buildPolymarketUrl(question) {
  const slug = (question || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${POLYMARKET_BASE_URL}/market/${slug}`;
}

function getBaseRate(question, market = null) {
  const q = (question || '').toLowerCase();
  const categoryKey = getCategoryKey(question, market);

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
  return clamp(blended, guardrailMin, guardrailMax);
}

function computeMarketTimeProgress(market = {}) {
  const now = Date.now();
  const end = Date.parse(market.endDateIso || market.endDate || '') || null;

  if (!end || end <= now) return 1;
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
  fs.appendFileSync(CONSOLE_LOG_FILE, JSON.stringify(payload) + '\n');
  if (LOG_TO_CONSOLE) {
    console.warn(`[VETO] ${payload.marketId || 'unknown'} -> ${payload.reason || 'unspecified'} | edge=${(payload.edgeScore ?? 0).toFixed(2)} conf=${(payload.confidence ?? 0).toFixed(2)} liq=${(payload.liquidity ?? 0).toFixed(0)}`);
  }
}

function buildDynamicCategoryPriors(markets = []) {
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
    return { yes, no };
  }

  if (typeof market.yesPrice === 'number' && typeof market.noPrice === 'number') {
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
  const yesPrice = getYesNoPrices(market)?.yes || 0.5;

  const prior = getBaseRate(market.question, market);
  return Math.abs(yesPrice - prior);
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

function enforceCategoryDiversity(selected, universe) {
  if (!Array.isArray(selected) || selected.length === 0) return [];
  const updated = [...selected].filter(m => m && m.question);
  const selectedIds = new Set(updated.map(m => m.id));

  const sports = updated.filter(m => getCategoryKey(m.question, m) === 'SPORTS_FUTURES');
  const maxSports = Math.floor(updated.length * 0.5);
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
  const maxPerCat = 5;
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

  log(`DEBUG: Markets after extreme price filter: ${filteredList.length}`);

  const seen = new Map();
  const dedupedList = filteredList.filter(m => {
    const normalized = (m.question || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const key = normalized + (m.endDateIso || m.endDate || '');
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });

  log(`DEBUG: Markets after deduplication: ${dedupedList.length}`);

  dynamicCategoryPriors = Object.keys(dynamicCategoryPriors).length ? dynamicCategoryPriors : buildDynamicCategoryPriors(dedupedList);

  const baselineFlagged = dedupedList.filter(m => {
    const yesPrice = typeof m.yesPrice === 'number' && Number.isFinite(m.yesPrice) ? m.yesPrice : 0.5;
    const pPrior = getBaseRate(m.question, m);
    const edge = Math.abs(pPrior - yesPrice);
    const category = getCategoryKey(m.question, m);
    const edgeFloor = computeCategoryEdgeFloor(category, m);
    const liquidityFloor = computeCategoryLiquidityFloor(category, m);
    return edge > edgeFloor && (m.liquidity || 0) > liquidityFloor;
  }).slice(0, 30);

  const priceSpikes = dedupedList
    .map(m => ({ market: m, drift: Math.abs(computePriceDrift(m)) }))
    .filter(entry => entry.drift > 0.03)
    .sort((a, b) => b.drift - a.drift)
    .slice(0, 15)
    .map(entry => entry.market);

  const volumeSpikes = dedupedList
    .map(m => {
      const vVel = computeVolumeVelocity(m);
      const baseline = Math.max(0.05, computeBaselineVolumeVelocity(m));
      return { market: m, vVel, baseline };
    })
    .filter(entry => entry.vVel > entry.baseline * 3 || entry.vVel > 0.6)
    .sort((a, b) => b.vVel - a.vVel)
    .slice(0, 15)
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
    if (getCategoryKey(m.question, m) === 'POLITICS' && edge < 0.12) return false;
    return true;
  });

  let selectedFiltered = selected.slice(0, 30);
  if (selectedFiltered.length < 25) {
    const needed = 25 - selectedFiltered.length;
    const selectedIds = new Set(selectedFiltered.map(m => m.id));
    const fallback = dedupedList
      .filter(m => !selectedIds.has(m.id))
      .sort((a, b) => Math.abs(getBaseRate(b.question, b) - (b.yesPrice || 0.5)) - Math.abs(getBaseRate(a.question, a) - (a.yesPrice || 0.5)))
      .slice(0, needed);
    selectedFiltered = [...selectedFiltered, ...fallback];
  }
  const diversified = enforceCategoryDiversity(selectedFiltered, dedupedList);
  return diversified.slice(0, 30);
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
    const livePrice = getClobPrice(market.id) || market.yesPrice || 0.5;
    const cached = getAnalysisCache(market.id);
    let analysis = null;

    if (cached) {
      const timeDelta = Date.now() - cached.timestamp;
      const priceDelta = Math.abs(((livePrice - cached.last_price) / cached.last_price) * 100);
      if (priceDelta <= 2 && timeDelta <= 3600000) {
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

      log(`[LLM] Analyzing: ${market.id} - ${market.question}`);

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

    ensureProbability(analysis, market);

    const marketAgeDays = (Date.now() - new Date(getMarketStartDate(market) || Date.now())) / (1000 * 60 * 60 * 24);
    if ((analysis.llmAnalysis?.confidence || 0) < 50 || marketAgeDays < 1) continue;

    rawSignalData.push({ market, analysis });
  }

  // Sort rawSignalData by abs effective edge before grouping
  rawSignalData.sort((a, b) => {
    const edgeA = Math.abs(a.analysis?.llmAnalysis?.effectiveEdge ?? a.analysis?.effectiveEdge ?? 0);
    const edgeB = Math.abs(b.analysis?.llmAnalysis?.effectiveEdge ?? b.analysis?.effectiveEdge ?? 0);
    return edgeB - edgeA;
  });

  const groups = {
    "top_ai_2025": GROUP_DEFINITIONS.top_ai_2025,
    "spacex_launches_2025": GROUP_DEFINITIONS.spacex_launches_2025
  };

  for (const groupName in groups) {
    const groupStrings = groups[groupName];
    const groupData = rawSignalData.filter(d => groupStrings.some(s => (d.market.question || '').includes(s)));
    let sum = groupData.reduce((s, d) => s + (d.analysis?.probability || 0), 0);

    if (sum > 0) {
      groupData.forEach(d => {
        if (d.analysis) d.analysis.probability /= sum;
      });

      groupData.sort((a, b) => (b.analysis?.probability || 0) - (a.analysis?.probability || 0));
      groupData.forEach((d, idx) => {
        d.forcedAction = idx === 0 && (d.analysis?.probability || 0) > 0.03 ? "EXECUTE BUY YES" : "EXECUTE BUY NO";
      });
    }
  }

  const executableTrades = [];
  const outlookSignals = [];
  const rejectedSignals = [];

  for (const data of rawSignalData) {
    const market = data.market;
    const analysis = data.analysis;
    let action = data.forcedAction || analysis.action || 'SKIP_NO_TRADE';
    if (action === 'HOLD') action = 'SKIP_NO_TRADE';
    if (action === 'BUY YES') action = 'EXECUTE BUY YES';
    if (action === 'BUY NO') action = 'EXECUTE BUY NO';
    const probability = ensureProbability(analysis, market);
    const yesPrice = getYesNoPrices(market)?.yes || market.yesPrice || 0.5;
    const confidence = analysis.confidenceScore || analysis.llmAnalysis?.confidence || 50;
    let normalizedConfidence = confidence > 1 ? confidence / 100 : confidence;

    let winProb, betPrice;
    if (action === 'EXECUTE BUY YES') {
      winProb = normalizedConfidence;
      betPrice = yesPrice;
    } else if (action === 'EXECUTE BUY NO') {
      winProb = 1 - normalizedConfidence;
      betPrice = 1 - yesPrice;
    } else {
      winProb = normalizedConfidence;
      betPrice = yesPrice;
    }

    const rawEdge = winProb - betPrice;
    const absEdge = Math.abs(rawEdge);

    const daysToResolution = market.endDateIso
      ? Math.max(0, (new Date(market.endDateIso) - Date.now()) / DAY_MS)
      : market.endDate
        ? Math.max(0, (new Date(market.endDate) - Date.now()) / DAY_MS)
        : 365;
    const horizonDiscount = computeHorizonDiscount(daysToResolution);

    normalizedConfidence = clamp(normalizedConfidence, 0.01, 1);
    const expectedEdge = rawEdge * normalizedConfidence * horizonDiscount;
    const absExpectedEdge = Math.abs(expectedEdge);
    const confidencePercent = Math.round(normalizedConfidence * 100);

    const marketOdds = yesPrice * 100;
    if ((marketOdds < 3 || marketOdds > 97) && confidencePercent < 90) {
      rejectedSignals.push({
        marketId: market.id,
        reason: 'Tail market skipped (low confidence)',
        probMarket: marketOdds,
        confidence: confidencePercent,
        action,
        timestamp: new Date().toISOString()
      });
      continue;
    }

    let kellyFraction = calculateKelly(winProb, betPrice, 0, market.liquidity || 10000);
    let intentExposure = Math.min(5, kellyFraction);

    const entropyScore = typeof analysis.llmAnalysis?.entropy === 'number'
      ? analysis.llmAnalysis.entropy
      : typeof analysis.entropy === 'number'
        ? analysis.entropy
        : 0.5;

    let riskPenalty = 1.0;
    riskPenalty = Math.max(0.01, riskPenalty);
    intentExposure *= riskPenalty;

    log(`[DEBUG OVERRIDE] conf=${confidencePercent}% absEdge=${absEdge.toFixed(4)} intentExposure=${intentExposure.toFixed(4)}`);

    if (confidencePercent >= 90 && absEdge >= 0.005) {
      intentExposure = Math.max(intentExposure, 0.020); // Minimum 2% for 90%+ conf, 1%+ edge
      log(`[DEBUG OVERRIDE] Applied 2% minimum for 90%+ conf`);
    } else if (confidencePercent >= 85 && absEdge >= 0.015) {
      intentExposure = Math.max(intentExposure, 0.010); // Minimum 1% for 85%+ conf, 1.5%+ edge
      log(`[DEBUG OVERRIDE] Applied 1% minimum for 85%+ conf`);
    } else if (confidencePercent >= 80 && absEdge >= 0.02) {
      intentExposure = Math.max(intentExposure, 0.005); // Minimum 0.5% for 80%+ conf, 2%+ edge
      log(`[DEBUG OVERRIDE] Applied 0.5% minimum for 80%+ conf`);
    }

    intentExposure = Math.max(0.001, intentExposure);

    const finalEffectiveEdge = Number((absExpectedEdge * riskPenalty * 100).toFixed(2));
    analysis.finalEffectiveEdge = finalEffectiveEdge;
    if (analysis.llmAnalysis) {
      analysis.llmAnalysis.finalEffectiveEdge = finalEffectiveEdge;
    }

    const cluster = getClusterForCategory(market.category);

    let tradeTier = 'NO_TRADE';
    if (intentExposure > 0.02) tradeTier = 'STRONG_TRADE';
    else if (intentExposure > 0.005) tradeTier = 'SMALL_TRADE';
    else if (intentExposure >= 0.0001) tradeTier = 'PROBE';

    const signal = {
      marketId: market.id,
      action,
      price: yesPrice,
      confidence: Number(normalizedConfidence.toFixed(1)),
      confidenceClass: normalizedConfidence >= 0.7 ? 'HIGH' : normalizedConfidence >= 0.4 ? 'MEDIUM' : 'LOW',
      intentExposure,
      edgeScore: finalEffectiveEdge,
      confidenceScore: Number((normalizedConfidence * 100).toFixed(1)),
      tradeDecision: action,
      modelConfidence: Number((normalizedConfidence * 100).toFixed(1)),
      executionConfidence: Number((normalizedConfidence * 100).toFixed(1)),
      tradeTier,
      effectiveEdge: finalEffectiveEdge,
      finalEffectiveEdge,
      cluster
    };

    const signalTimestamp = new Date().toISOString();
    const debugDecision = signal.intentExposure >= 0.0005 && signal.confidenceScore >= 68 ? 'EXECUTABLE' : 'DROPPED';
    log(`[DEBUG] Signal ${(market.question || '').slice(0, 50)} | Edge ${(signal.effectiveEdge || 0).toFixed(2)}% | Exposure ${signal.intentExposure.toFixed(3)}% | Conf ${signal.confidenceScore.toFixed(1)} | Tier ${tradeTier} → ${debugDecision}`);

    if (process.env.SAFE_MODE !== 'true' && ['STRONG_TRADE', 'SMALL_TRADE', 'PROBE'].includes(tradeTier)) {
      const tweet = ` AGENT ZIGMA SIGNAL
Market: ${(market.question || '').slice(0, 50)}
Market Odds (YES): ${(yesPrice * 100).toFixed(1)}%
ZIGMA Odds (YES): ${(winProb * 100).toFixed(1)}%
Edge: ${(rawEdge > 0 ? '+' : '')}${(rawEdge * 100).toFixed(1)}%
Action: ${action === 'SKIP_NO_TRADE' ? 'NO TRADE' : action.replace('EXECUTE ', '')}
Tier: ${tradeTier}
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
      probMarket: action === 'EXECUTE BUY NO' ? (1 - yesPrice) * 100 : yesPrice * 100,
      effectiveEdge: finalEffectiveEdge,
      rawEdge: rawEdge * 100,
      link: buildPolymarketUrl(market.question),
      cluster
    };

    if (action.startsWith('EXECUTE') && ['STRONG_TRADE', 'SMALL_TRADE', 'PROBE'].includes(tradeTier)) {
      if ((market.liquidity || 0) < 10000) {
        rejectedSignals.push({
          marketId: market.id,
          reason: 'Liquidity too low for executable trade',
          probMarket: yesPrice * 100,
          confidence: confidencePercent,
          action,
          timestamp: new Date().toISOString()
        });
        continue;
      }

      if (yesPrice > 0.95 && absExpectedEdge < 0.05) {
        rejectedSignals.push({
          marketId: market.id,
          reason: 'Ultra-high odds skipped (low divergence)',
          probMarket: yesPrice * 100,
          confidence: confidencePercent,
          action,
          timestamp: new Date().toISOString()
        });
        continue;
      }

      if ((signal.finalEffectiveEdge ?? signal.effectiveEdge ?? 0) < 5) {
        rejectedSignals.push({ ...signalWithMarket, reason: 'Final edge veto: <5%' });
        continue;
      }

      if (signal.intentExposure >= 0.0005 && signal.confidenceScore >= 68) {
        if (signal.tradeTier === 'PROBE' && finalEffectiveEdge > 3.5) {
          signal.tradeTier = 'MEDIUM_TRADE';
        }
        executableTrades.push(signalWithMarket);
      } else {
        outlookSignals.push(signalWithMarket);
      }
    } else {
      outlookSignals.push(signalWithMarket);
    }
  }

  // Apply correlation cluster dampening before final caps
  applyClusterDampening(executableTrades);
  applyClusterDampening(outlookSignals);

  // Apply global exposure cap (e.g., 100% of bankroll) across executable trades
  const MAX_CYCLE_EXPOSURE = 1.0; // 100% bankroll cap

  const totalExposure = executableTrades.reduce((sum, trade) => sum + (trade.intentExposure || 0), 0);
  if (totalExposure > MAX_CYCLE_EXPOSURE) {
    const scale = MAX_CYCLE_EXPOSURE / totalExposure;
    executableTrades.forEach(trade => {
      trade.intentExposure = Number((trade.intentExposure * scale).toFixed(4));
    });
  }

  return {
    executableTrades,
    outlookSignals,
    rejectedSignals,
    signalsGenerated
  };
}

module.exports = {
  generateSignals,
  runCycle,
  pickHighAlphaMarkets,
  analyzeMarket
};

async function runCycle() {
  if (isRunning) return;
  isRunning = true;
  let markets = [];
  try {
    log(`\n--- Agent Zigma Cycle: ${new Date().toISOString()} ---`);
    const rawMarkets = await fetchAllMarkets();
    markets = rawMarkets;

    let lastSnapshot = {};
    if (fs.existsSync(SNAPSHOT_FILE)) {
      try {
        lastSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8') || '{}');
      } catch (e) {
        log('Failed to parse last snapshot');
      }
    }

    const result = await computeMetrics(rawMarkets, lastSnapshot);
    const enriched = Array.isArray(result) ? result : [];
    log(`FETCH SUMMARY | total=${enriched.length}`);
    if (!enriched.length) {
      log("No markets fetched — skipping analysis cycle");
      isRunning = false;
      return;
    }

    updateCategoryPerformance(enriched);
    dynamicCategoryPriors = buildDynamicCategoryPriors(enriched);

    enriched.forEach(m => {
      const prices = getYesNoPrices(m);
      if (prices) {
        m.yesPrice = prices.yes;
        m.noPrice = prices.no;
        m.settlementRisk = settlementRisk(m.question);
        m.category = classifyMarket(m.question);

        if (Math.abs((m.yesPrice + m.noPrice) - 1) > 0.01) {
          log(`ARBITRAGE ALERT: ${m.question} YES+NO ≠1 (vig: ${Math.abs((m.yesPrice + m.noPrice) - 1).toFixed(4)})`);
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
    enriched.forEach(m => {
      const category = getCategoryKey(m.question, m);
      if (!marketGroups[category]) marketGroups[category] = [];
      marketGroups[category].push(m);
    });

    const avgVolatility = enriched.reduce((sum, m) => sum + (m.priceVolatility || 0), 0) / enriched.length;
    const avgLiquidity = enriched.reduce((sum, m) => sum + (m.liquidity || 0), 0) / enriched.length;
    isVolatilityLock = avgVolatility > 0.1;
    isLiquidityShock = avgLiquidity < 50000;

    const selectedMarkets = pickHighAlphaMarkets(enriched, marketGroups).filter(m => (m.volume || 0) > 1000);
    log(` Selected ${selectedMarkets.length} markets for deep analysis`);

    activeGroupSizes = computeGroupSizeMap(selectedMarkets);

    if (selectedMarkets.length === 0) {
      noSignalCycles++;
      if (noSignalCycles > 5) isNoSignalMode = true;
    } else {
      noSignalCycles = 0;
      isNoSignalMode = false;
    }

    const { executableTrades, outlookSignals, rejectedSignals, signalsGenerated } = await generateSignals(selectedMarkets);

    const lastRunTimestamp = new Date().toISOString();

    global.latestData = {
      cycleSummary: {
        marketsFetched: markets.length,
        marketsEligible: selectedMarkets.length,
        signalsGenerated,
        watchlist: executableTrades.length,
        outlook: outlookSignals.length,
        rejected: rejectedSignals.length
      },
      liveSignals: executableTrades,
      marketOutlook: outlookSignals,
      rejectedSignals,
      lastRun: lastRunTimestamp,
      marketsMonitored: selectedMarkets.length,
      posts: signalsGenerated
    };

    saveCycleData(global.latestData);
    recordCycleSnapshot(global.latestData);

    try {
      const customFile = path.join(__dirname, '..', 'cache', 'custom_signals.json');
      if (fs.existsSync(customFile)) {
        const customSignals = JSON.parse(fs.readFileSync(customFile, 'utf8'));
        global.latestData.liveSignals = [...customSignals, ...global.latestData.liveSignals];
      }
    } catch (e) {
      console.error('Error loading custom signals:', e);
    }

    updateHealthMetrics({
      lastRun: lastRunTimestamp,
      marketsMonitored: selectedMarkets.length,
      posts: signalsGenerated
    });

    log("✅ Cycle complete");
  } catch (error) {
    log(`CRITICAL CYCLE ERROR: ${error.message}\n${error.stack}`);
  } finally {
    isRunning = false;
  }
}

async function main() {
  try {
    log("Agent Zigma starting...");
    startPolling?.();
    startServer?.();
    await queuedRunCycle();

    const cronExpression = process.env.CRON_SCHEDULE || '0 * * * *';
    cron.schedule(cronExpression, queuedRunCycle);
    log(`Agent Zigma scheduled cadence: ${cronExpression}`);
  } catch (err) {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  }
}

main();