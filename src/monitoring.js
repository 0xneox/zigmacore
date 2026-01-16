/**
 * Comprehensive Monitoring Module
 * Tracks critical operations metrics for performance monitoring and alerting
 */

const fs = require('fs');
const path = require('path');

// Constants for monitoring
const MAX_METRICS_HISTORY = 100; // Keep only last N items
const MAX_CATEGORIES = 50; // Limit to top N categories
const PERSISTENCE_INTERVAL_MS = 60000; // Save every 60 seconds
const PERSISTENCE_FILE = path.join(__dirname, '../data/metrics.json');

// Simple mutex for atomic operations
let metricsLock = false;
function withMetricsLock(fn) {
  while (metricsLock) {
    // Wait for lock to release
  }
  metricsLock = true;
  try {
    return fn();
  } finally {
    metricsLock = false;
  }
}

const metrics = {
  // Cycle metrics
  cycleDuration: [],
  cyclesCompleted: 0,
  cyclesFailed: 0,

  // LLM metrics
  llmLatency: [],
  llmCalls: 0,
  llmFailures: 0,
  llmCircuitBreakerTrips: 0,

  // API metrics
  apiLatency: {
    polymarket: [],
    news: [],
    clob: []
  },
  apiCalls: {
    polymarket: 0,
    news: 0,
    clob: 0
  },
  apiFailures: {
    polymarket: 0,
    news: 0,
    clob: 0
  },

  // Signal metrics
  signalsGenerated: 0,
  signalsByAction: {
    'BUY YES': 0,
    'BUY NO': 0,
    'HOLD': 0
  },
  signalsByCategory: {},
  signalsByCategoryOther: 0, // Count for categories beyond top N

  // Persistence
  lastPersistTime: Date.now(),

  // Market metrics
  marketsAnalyzed: 0,
  marketsFiltered: 0,

  // Error tracking
  errors: [],
  errorCounts: {},

  // Performance tracking
  startTime: Date.now(),
  lastCycleTime: Date.now()
};

/**
 * Record cycle duration
 * @param {number} durationMs - Cycle duration in milliseconds
 * @param {boolean} success - Whether cycle completed successfully
 */
function recordCycle(durationMs, success = true) {
  metrics.cycleDuration.push(durationMs);
  if (success) {
    metrics.cyclesCompleted++;
  } else {
    metrics.cyclesFailed++;
  }
  metrics.lastCycleTime = Date.now();

  // Keep only last 100 cycles
  if (metrics.cycleDuration.length > MAX_METRICS_HISTORY) {
    metrics.cycleDuration.shift();
  }

  // Periodically persist metrics
  if (Date.now() - metrics.lastPersistTime > PERSISTENCE_INTERVAL_MS) {
    persistMetrics();
  }
}

/**
 * Record LLM call
 * @param {number} latencyMs - LLM call latency in milliseconds
 * @param {boolean} success - Whether LLM call succeeded
 */
function recordLLMCall(latencyMs, success = true) {
  metrics.llmLatency.push(latencyMs);
  metrics.llmCalls++;
  if (!success) {
    metrics.llmFailures++;
  }

  // Keep only last 100 calls
  if (metrics.llmLatency.length > MAX_METRICS_HISTORY) {
    metrics.llmLatency.shift();
  }
}

/**
 * Record LLM circuit breaker trip
 */
function recordCircuitBreakerTrip() {
  metrics.llmCircuitBreakerTrips++;
}

/**
 * Record API call
 * @param {string} api - API name (polymarket, news, clob)
 * @param {number} latencyMs - API call latency in milliseconds
 * @param {boolean} success - Whether API call succeeded
 */
function recordApiCall(api, latencyMs, success = true) {
  if (!metrics.apiLatency[api]) {
    metrics.apiLatency[api] = [];
    metrics.apiCalls[api] = 0;
    metrics.apiFailures[api] = 0;
  }

  metrics.apiLatency[api].push(latencyMs);
  metrics.apiCalls[api]++;
  if (!success) {
    metrics.apiFailures[api]++;
  }

  // Keep only last 100 calls per API
  if (metrics.apiLatency[api].length > MAX_METRICS_HISTORY) {
    metrics.apiLatency[api].shift();
  }
}

/**
 * Record signal generation
 * @param {string} action - Signal action (BUY YES, BUY NO, HOLD)
 * @param {string} category - Market category
 */
function recordSignal(action, category) {
  withMetricsLock(() => {
    metrics.signalsGenerated++;
    
    // Atomic increment for action counter
    if (metrics.signalsByAction[action]) {
      metrics.signalsByAction[action]++;
    } else {
      metrics.signalsByAction[action] = 1;
    }

    if (category) {
      // Limit categories to prevent unbounded growth
      const categories = Object.keys(metrics.signalsByCategory);
      if (categories.length >= MAX_CATEGORIES && !metrics.signalsByCategory[category]) {
        // New category beyond limit, count as "OTHER"
        metrics.signalsByCategoryOther++;
      } else {
        if (!metrics.signalsByCategory[category]) {
          metrics.signalsByCategory[category] = 0;
        }
        metrics.signalsByCategory[category]++;
      }
    }
  });
}

/**
 * Record market analysis
 * @param {boolean} filtered - Whether market was filtered
 */
function recordMarketAnalysis(filtered = false) {
  metrics.marketsAnalyzed++;
  if (filtered) {
    metrics.marketsFiltered++;
  }
}

/**
 * Record error
 * @param {string} type - Error type
 * @param {string} message - Error message
 * @param {Error} errorObj - Optional Error object for stack trace
 */
function recordError(type, message, errorObj = null) {
  withMetricsLock(() => {
    const error = {
      type,
      message,
      timestamp: Date.now(),
      stack: errorObj?.stack || new Error().stack
    };
    metrics.errors.push(error);

    // Keep only last 100 errors
    if (metrics.errors.length > MAX_METRICS_HISTORY) {
      metrics.errors.shift();
    }

    if (!metrics.errorCounts[type]) {
      metrics.errorCounts[type] = 0;
    }
    metrics.errorCounts[type]++;
  });
}

/**
 * Get average of array
 * @param {number[]} arr - Array of numbers
 * @returns {number} Average
 */
function getAverage(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Get median of array
 * @param {number[]} arr - Array of numbers
 * @returns {number} Median
 */
function getMedian(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Get percentile of array
 * @param {number[]} arr - Array of numbers
 * @param {number} percentile - Percentile (0-100)
 * @returns {number} Percentile value
 */
function getPercentile(arr, percentile) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Get comprehensive metrics summary
 * @returns {Object} Metrics summary
 */
function getMetricsSummary() {
  const uptime = Date.now() - metrics.startTime;
  const avgCycleDuration = getAverage(metrics.cycleDuration);
  const medianCycleDuration = getMedian(metrics.cycleDuration);
  const p95CycleDuration = getPercentile(metrics.cycleDuration, 95);

  const avgLLMLatency = getAverage(metrics.llmLatency);
  const medianLLMLatency = getMedian(metrics.llmLatency);
  const p95LLMLatency = getPercentile(metrics.llmLatency, 95);

  const apiLatencySummary = {};
  Object.keys(metrics.apiLatency).forEach(api => {
    apiLatencySummary[api] = {
      average: getAverage(metrics.apiLatency[api]),
      median: getMedian(metrics.apiLatency[api]),
      p95: getPercentile(metrics.apiLatency[api], 95),
      calls: metrics.apiCalls[api],
      failures: metrics.apiFailures[api],
      successRate: metrics.apiCalls[api] > 0
        ? ((metrics.apiCalls[api] - metrics.apiFailures[api]) / metrics.apiCalls[api] * 100).toFixed(2)
        : 0
    };
  });

  return {
    uptime,
    uptimeFormatted: `${Math.floor(uptime / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m ${Math.floor((uptime % 60000) / 1000)}s`,

    cycle: {
      completed: metrics.cyclesCompleted,
      failed: metrics.cyclesFailed,
      successRate: metrics.cyclesCompleted + metrics.cyclesFailed > 0
        ? ((metrics.cyclesCompleted / (metrics.cyclesCompleted + metrics.cyclesFailed)) * 100).toFixed(2)
        : 0,
      averageDuration: avgCycleDuration.toFixed(0),
      medianDuration: medianCycleDuration.toFixed(0),
      p95Duration: p95CycleDuration.toFixed(0)
    },

    llm: {
      calls: metrics.llmCalls,
      failures: metrics.llmFailures,
      successRate: metrics.llmCalls > 0
        ? ((metrics.llmCalls - metrics.llmFailures) / metrics.llmCalls * 100).toFixed(2)
        : 0,
      circuitBreakerTrips: metrics.llmCircuitBreakerTrips,
      averageLatency: avgLLMLatency.toFixed(0),
      medianLatency: medianLLMLatency.toFixed(0),
      p95Latency: p95LLMLatency.toFixed(0)
    },

    api: apiLatencySummary,

    signals: {
      total: metrics.signalsGenerated,
      byAction: metrics.signalsByAction,
      byCategory: metrics.signalsByCategory,
      otherCategories: metrics.signalsByCategoryOther
    },

    markets: {
      analyzed: metrics.marketsAnalyzed,
      filtered: metrics.marketsFiltered,
      filterRate: metrics.marketsAnalyzed > 0
        ? ((metrics.marketsFiltered / metrics.marketsAnalyzed) * 100).toFixed(2)
        : 0
    },

    errors: {
      total: metrics.errors.length,
      byType: metrics.errorCounts,
      recent: metrics.errors.slice(-5)
    },

    lastCycleTime: new Date(metrics.lastCycleTime).toISOString()
  };
}

/**
 * Reset metrics (useful for testing or manual reset)
 */
function resetMetrics() {
  metrics.cycleDuration = [];
  metrics.cyclesCompleted = 0;
  metrics.cyclesFailed = 0;
  metrics.llmLatency = [];
  metrics.llmCalls = 0;
  metrics.llmFailures = 0;
  metrics.llmCircuitBreakerTrips = 0;
  metrics.apiLatency = { polymarket: [], news: [], clob: [] };
  metrics.apiCalls = { polymarket: 0, news: 0, clob: 0 };
  metrics.apiFailures = { polymarket: 0, news: 0, clob: 0 };
  metrics.signalsGenerated = 0;
  metrics.signalsByAction = { 'BUY YES': 0, 'BUY NO': 0, 'HOLD': 0 };
  metrics.signalsByCategory = {};
  metrics.marketsAnalyzed = 0;
  metrics.marketsFiltered = 0;
  metrics.errors = [];
  metrics.errorCounts = {};
  metrics.startTime = Date.now();
  metrics.lastCycleTime = Date.now();
}

/**
 * Persist metrics to file
 */
function persistMetrics() {
  try {
    const dataDir = path.dirname(PERSISTENCE_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    const metricsToSave = {
      ...metrics,
      persistedAt: Date.now()
    };
    
    fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(metricsToSave, null, 2));
    metrics.lastPersistTime = Date.now();
    console.log('[MONITORING] Metrics persisted to file');
  } catch (error) {
    console.error('[MONITORING] Failed to persist metrics:', error.message);
  }
}

/**
 * Load metrics from file
 */
function loadMetrics() {
  try {
    if (fs.existsSync(PERSISTENCE_FILE)) {
      const data = fs.readFileSync(PERSISTENCE_FILE, 'utf8');
      const loadedMetrics = JSON.parse(data);
      
      // Merge loaded metrics with current structure
      Object.assign(metrics, loadedMetrics);
      console.log('[MONITORING] Metrics loaded from file');
    }
  } catch (error) {
    console.error('[MONITORING] Failed to load metrics:', error.message);
  }
}

// Load persisted metrics on module load
loadMetrics();

// Set up periodic persistence
setInterval(() => {
  persistMetrics();
}, PERSISTENCE_INTERVAL_MS);

module.exports = {
  recordCycle,
  recordLLMCall,
  recordCircuitBreakerTrip,
  recordApiCall,
  recordSignal,
  recordMarketAnalysis,
  recordError,
  getMetricsSummary,
  resetMetrics,
  persistMetrics,
  loadMetrics,
  metrics
};
