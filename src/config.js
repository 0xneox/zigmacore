/**
 * Centralized Configuration
 * All magic numbers and thresholds extracted here for easy tuning
 */

module.exports = {
  // Edge thresholds for trading decisions
  EDGE_THRESHOLDS: {
    MINIMUM: 0.02,
    MODERATE: 0.05,
    STRONG: 0.10,
    EXTREME: 0.15
  },

  // Liquidity thresholds
  LIQUIDITY_THRESHOLDS: {
    MINIMUM: 10000,
    GOOD: 50000,
    EXCELLENT: 100000,
    MAX_FOR_TRADING: 300000
  },

  // Volume thresholds
  VOLUME_THRESHOLDS: {
    MINIMUM: 10000,
    GOOD: 50000,
    EXCELLENT: 100000,
    SPIKE_MULTIPLIER: 3
  },

  // Price thresholds
  PRICE_THRESHOLDS: {
    MIN_YES: 0.005,
    MAX_YES: 0.995,
    DEAD_MARKET_MIN: 0.01,
    DEAD_MARKET_MAX: 0.99
  },

  // Kelly Criterion settings
  KELLY: {
    MULTIPLIER: 2.0,
    MAX_POSITION_SIZE: 0.05,
    EDGE_BUFFER: 0.01
  },

  // Horizon discount (time-based edge reduction)
  HORIZON_DISCOUNT: {
    NO_DISCOUNT_DAYS: 7,
    TIER_1_DAYS: 30,
    TIER_2_DAYS: 90,
    TIER_3_DAYS: 180,
    DISCOUNT_TIER_1: 0.95,
    DISCOUNT_TIER_2: 0.90,
    DISCOUNT_TIER_3: 0.85,
    DISCOUNT_MAX: 0.80
  },

  // Cache settings
  CACHE: {
    CLOB_PRICE_STALENESS_MS: 5000,
    NEWS_CACHE_TTL_MS: 2 * 60 * 1000,
    ANALYSIS_CACHE_TTL_MS: 3600000,
    PRICE_DELTA_THRESHOLD: 2
  },

  // Timeouts
  TIMEOUTS: {
    CYCLE_QUEUE_MS: 60000,
    API_REQUEST_MS: 5000,
    LLM_REQUEST_MS: 30000
  },

  // Market selection
  MARKET_SELECTION: {
    MAX_MARKETS: 100,
    MAX_PER_CATEGORY: 5,
    MIN_QUALITY_SCORE: 10,
    MIN_DAYS_LEFT: 7,
    MAX_DAYS_LEFT: 365
  },

  // Category diversity
  CATEGORY_DIVERSITY: {
    MAX_SPORTS_RATIO: 0.5,
    PRIORITY_CATEGORIES: ['POLITICS', 'MACRO', 'CRYPTO']
  },

  // LLM settings
  LLM: {
    CIRCUIT_BREAKER_FAILURES: 5,
    CIRCUIT_BREAKER_COOLDOWN_MS: 60000,
    MAX_TOKENS: 1000,
    TEMPERATURE: 0.3
  },

  // Adaptive learning
  ADAPTIVE_LEARNING: {
    MIN_SIGNALS: 20,
    LEARNING_RATE: 0.1,
    CONFIDENCE_OVERCORRECTION: 0.3,
    CONFIDENCE_UNDERCORRECTION: 0.2,
    EDGE_OVERCORRECTION: 0.05,
    EDGE_UNDERCORRECTION: 0.03
  },

  // Risk management
  RISK: {
    MAX_EXPOSURE: 0.05,
    MIN_LIQUIDITY: 30000,
    MAX_VOLATILITY: 0.05
  },

  // Logging
  LOGGING: {
    BATCH_FLUSH_MS: 50,
    VERBOSE_MARKET_LOGS: false
  }
};
