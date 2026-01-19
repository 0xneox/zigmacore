/**
 * Time-to-Resolution Weighting Module
 * Adjusts position sizing and edge requirements based on time remaining
 * Markets closing in 2 days vs 2 months have fundamentally different risk/reward
 */

/**
 * Time decay curves for different market types
 * Markets behave differently as resolution approaches
 */
const TIME_PROFILES = {
  // Binary events (elections, announcements) - sharp moves near resolution
  BINARY_EVENT: {
    volatilityMultiplier: (daysRemaining) => {
      if (daysRemaining <= 1) return 3.0;   // Very high volatility
      if (daysRemaining <= 3) return 2.0;
      if (daysRemaining <= 7) return 1.5;
      if (daysRemaining <= 14) return 1.2;
      return 1.0;
    },
    edgeDecay: (daysRemaining) => {
      // Edge matters less as resolution approaches (market converges to outcome)
      if (daysRemaining <= 1) return 0.5;
      if (daysRemaining <= 3) return 0.7;
      if (daysRemaining <= 7) return 0.85;
      return 1.0;
    }
  },
  
  // Continuous metrics (price targets, statistical outcomes) - gradual convergence
  CONTINUOUS: {
    volatilityMultiplier: (daysRemaining) => {
      if (daysRemaining <= 1) return 2.0;
      if (daysRemaining <= 7) return 1.3;
      if (daysRemaining <= 30) return 1.1;
      return 1.0;
    },
    edgeDecay: (daysRemaining) => {
      if (daysRemaining <= 1) return 0.6;
      if (daysRemaining <= 7) return 0.8;
      return 1.0;
    }
  },
  
  // Sports/Games - known end time, high info asymmetry
  SPORTS: {
    volatilityMultiplier: (daysRemaining) => {
      if (daysRemaining <= 0.5) return 4.0;  // Game day
      if (daysRemaining <= 1) return 2.5;
      if (daysRemaining <= 3) return 1.5;
      return 1.0;
    },
    edgeDecay: (daysRemaining) => {
      if (daysRemaining <= 0.5) return 0.3;  // Too late for edge
      if (daysRemaining <= 1) return 0.6;
      return 1.0;
    }
  },
  
  // Long-term predictions (annual outcomes) - slow decay
  LONG_TERM: {
    volatilityMultiplier: (daysRemaining) => {
      if (daysRemaining <= 7) return 1.8;
      if (daysRemaining <= 30) return 1.3;
      if (daysRemaining <= 90) return 1.1;
      return 1.0;
    },
    edgeDecay: (daysRemaining) => {
      if (daysRemaining <= 7) return 0.7;
      if (daysRemaining <= 30) return 0.85;
      return 1.0;
    }
  }
};

/**
 * Map market categories to time profiles
 */
const CATEGORY_TO_PROFILE = {
  POLITICS: 'BINARY_EVENT',
  MACRO: 'CONTINUOUS',
  CRYPTO: 'CONTINUOUS',
  TECH: 'CONTINUOUS',
  TECH_ADOPTION: 'LONG_TERM',
  ETF_APPROVAL: 'BINARY_EVENT',
  ENTERTAINMENT: 'BINARY_EVENT',
  CELEBRITY: 'CONTINUOUS',
  SPORTS_FUTURES: 'SPORTS',
  WAR_OUTCOMES: 'BINARY_EVENT',
  EVENT: 'BINARY_EVENT'
};

/**
 * Calculate days remaining until resolution
 * @param {string|Date} endDate - Market end/resolution date
 * @param {Date} now - Current date (default: now)
 * @returns {number} - Days remaining (can be fractional)
 */
function calculateDaysRemaining(endDate, now = new Date()) {
  // Handle missing or invalid endDate
  if (!endDate || endDate === null || endDate === undefined) {
    return null;
  }
  
  const resolution = new Date(endDate);
  
  if (isNaN(resolution.getTime())) {
    return null;
  }
  
  const msRemaining = resolution.getTime() - now.getTime();
  const daysRemaining = msRemaining / (1000 * 60 * 60 * 24);
  
  return Math.max(0, daysRemaining);
}

/**
 * Get time profile for a market category
 * @param {string} category - Market category
 * @returns {Object} - Time profile with multiplier functions
 */
function getTimeProfile(category) {
  const profileName = CATEGORY_TO_PROFILE[category] || 'BINARY_EVENT';
  return TIME_PROFILES[profileName];
}

/**
 * Calculate time-adjusted edge
 * Edge value diminishes as resolution approaches
 * @param {number} rawEdge - Original edge from analysis
 * @param {number} daysRemaining - Days until resolution
 * @param {string} category - Market category
 * @returns {Object} - Adjusted edge with explanation
 */
function calculateTimeAdjustedEdge(rawEdge, daysRemaining, category) {
  if (daysRemaining === null || daysRemaining === undefined) {
    return {
      adjustedEdge: rawEdge,
      multiplier: 1.0,
      reason: 'No resolution date available'
    };
  }
  
  const profile = getTimeProfile(category);
  const edgeMultiplier = profile.edgeDecay(daysRemaining);
  const adjustedEdge = rawEdge * edgeMultiplier;
  
  let reason;
  if (daysRemaining <= 1) {
    reason = 'Resolution imminent - edge heavily discounted';
  } else if (daysRemaining <= 7) {
    reason = 'Resolution soon - edge partially discounted';
  } else {
    reason = 'Sufficient time for edge to materialize';
  }
  
  return {
    adjustedEdge: Number(adjustedEdge.toFixed(4)),
    rawEdge: rawEdge,
    multiplier: Number(edgeMultiplier.toFixed(2)),
    daysRemaining: Number(daysRemaining.toFixed(2)),
    reason
  };
}

/**
 * Calculate time-adjusted position size
 * Reduces position size for volatile near-resolution markets
 * @param {number} baseSize - Base position size (e.g., from Kelly)
 * @param {number} daysRemaining - Days until resolution
 * @param {string} category - Market category
 * @returns {Object} - Adjusted position size with explanation
 */
function calculateTimeAdjustedSize(baseSize, daysRemaining, category) {
  if (daysRemaining === null || daysRemaining === undefined) {
    return {
      adjustedSize: baseSize,
      multiplier: 1.0,
      reason: 'No resolution date available'
    };
  }
  
  const profile = getTimeProfile(category);
  const volatilityMultiplier = profile.volatilityMultiplier(daysRemaining);
  
  // Higher volatility = smaller position (inverse relationship)
  const sizeMultiplier = 1 / volatilityMultiplier;
  const adjustedSize = baseSize * sizeMultiplier;
  
  let reason;
  if (volatilityMultiplier >= 2.0) {
    reason = 'High volatility expected - position reduced significantly';
  } else if (volatilityMultiplier >= 1.3) {
    reason = 'Elevated volatility - position reduced moderately';
  } else {
    reason = 'Normal volatility - full position allowed';
  }
  
  return {
    adjustedSize: Number(adjustedSize.toFixed(4)),
    baseSize: baseSize,
    sizeMultiplier: Number(sizeMultiplier.toFixed(2)),
    volatilityMultiplier: Number(volatilityMultiplier.toFixed(2)),
    daysRemaining: Number(daysRemaining.toFixed(2)),
    reason
  };
}

/**
 * Calculate minimum edge required based on time remaining
 * Near-resolution trades need higher edge to compensate for risk
 * @param {number} daysRemaining - Days until resolution
 * @param {string} category - Market category
 * @param {number} baseMinEdge - Base minimum edge (default 5%)
 * @returns {Object} - Required minimum edge
 */
function calculateMinimumEdgeRequired(daysRemaining, category, baseMinEdge = 0.05) {
  if (daysRemaining === null || daysRemaining === undefined) {
    return {
      minEdge: baseMinEdge,
      reason: 'No resolution date - using base minimum'
    };
  }
  
  const profile = getTimeProfile(category);
  const volatilityMultiplier = profile.volatilityMultiplier(daysRemaining);
  
  // Higher volatility = need higher edge
  const adjustedMinEdge = baseMinEdge * volatilityMultiplier;
  
  // Cap at 20% - beyond this, just don't trade
  const finalMinEdge = Math.min(0.20, adjustedMinEdge);
  
  return {
    minEdge: Number(finalMinEdge.toFixed(4)),
    minEdgePercent: Number((finalMinEdge * 100).toFixed(1)),
    baseMinEdge: baseMinEdge,
    volatilityMultiplier: Number(volatilityMultiplier.toFixed(2)),
    daysRemaining: Number(daysRemaining.toFixed(2)),
    shouldTrade: daysRemaining > 0.25, // Don't trade within 6 hours of resolution
    reason: daysRemaining <= 0.25 
      ? 'Too close to resolution - do not trade'
      : `Minimum edge: ${(finalMinEdge * 100).toFixed(1)}% required`
  };
}

/**
 * Calculate optimal entry timing
 * Some markets are better entered at specific times
 * @param {number} daysRemaining - Days until resolution
 * @param {string} category - Market category
 * @param {number} currentEdge - Current edge available
 * @returns {Object} - Timing recommendation
 */
function calculateOptimalTiming(daysRemaining, category, currentEdge) {
  const minEdgeData = calculateMinimumEdgeRequired(daysRemaining, category);
  
  if (!minEdgeData.shouldTrade) {
    return {
      recommendation: 'DO_NOT_ENTER',
      reason: 'Too close to resolution',
      daysRemaining
    };
  }
  
  // Calculate edge efficiency (current edge vs required edge)
  const edgeEfficiency = currentEdge / minEdgeData.minEdge;
  
  if (edgeEfficiency >= 2.0) {
    return {
      recommendation: 'ENTER_NOW',
      reason: `Strong edge (${(currentEdge * 100).toFixed(1)}%) exceeds minimum (${minEdgeData.minEdgePercent}%) by 2x+`,
      edgeEfficiency: Number(edgeEfficiency.toFixed(2)),
      daysRemaining
    };
  }
  
  if (edgeEfficiency >= 1.2) {
    return {
      recommendation: 'ENTER_NOW',
      reason: `Good edge (${(currentEdge * 100).toFixed(1)}%) exceeds minimum (${minEdgeData.minEdgePercent}%)`,
      edgeEfficiency: Number(edgeEfficiency.toFixed(2)),
      daysRemaining
    };
  }
  
  if (edgeEfficiency >= 1.0) {
    return {
      recommendation: 'ENTER_SMALL',
      reason: `Marginal edge - enter with reduced size`,
      edgeEfficiency: Number(edgeEfficiency.toFixed(2)),
      suggestedSizeMultiplier: 0.5,
      daysRemaining
    };
  }
  
  // Edge below minimum
  if (daysRemaining > 7) {
    return {
      recommendation: 'WAIT',
      reason: `Edge ${(currentEdge * 100).toFixed(1)}% below minimum ${minEdgeData.minEdgePercent}% - wait for better opportunity`,
      edgeNeeded: minEdgeData.minEdge - currentEdge,
      daysRemaining
    };
  }
  
  return {
    recommendation: 'SKIP',
    reason: `Insufficient edge and limited time - skip this market`,
    edgeEfficiency: Number(edgeEfficiency.toFixed(2)),
    daysRemaining
  };
}

/**
 * Get comprehensive time-based analysis for a trade
 * @param {Object} market - Market data with endDate, category
 * @param {number} rawEdge - Raw edge from analysis
 * @param {number} baseSize - Base position size
 * @returns {Object} - Complete time-adjusted analysis
 */
function getTimeAnalysis(market, rawEdge, baseSize) {
  const { endDateIso, category } = market;
  const endDate = endDateIso || market.endDate;
  const daysRemaining = calculateDaysRemaining(endDate);
  
  if (daysRemaining === null) {
    return {
      hasResolutionDate: true,
      daysRemaining: null,
      category,
      profile: CATEGORY_TO_PROFILE[category] || 'BINARY_EVENT',
      adjustments: {
        edge: { adjustedEdge: rawEdge, multiplier: 1.0 },
        size: { adjustedSize: baseSize, multiplier: 1.0 },
        minEdge: { minEdge: 0.05, shouldTrade: true }
      },
      timing: { recommendation: 'ENTER_NOW', reason: 'No resolution date' },
      finalDecision: 'ACCEPT',
      summary: {
        originalEdge: rawEdge,
        adjustedEdge: rawEdge,
        originalSize: baseSize,
        adjustedSize: baseSize,
        minEdgeRequired: 0.05,
        passesMinEdge: true
      }
    };
  }
  
  const edgeAnalysis = calculateTimeAdjustedEdge(rawEdge, daysRemaining, category);
  const sizeAnalysis = calculateTimeAdjustedSize(baseSize, daysRemaining, category);
  const minEdgeAnalysis = calculateMinimumEdgeRequired(daysRemaining, category);
  const timingAnalysis = calculateOptimalTiming(daysRemaining, category, rawEdge);
  
  // Final trade decision
  let finalDecision;
  if (!minEdgeAnalysis.shouldTrade) {
    finalDecision = 'REJECT_TIME';
  } else if (rawEdge < minEdgeAnalysis.minEdge) {
    finalDecision = 'REJECT_EDGE';
  } else if (timingAnalysis.recommendation === 'SKIP') {
    finalDecision = 'REJECT_TIMING';
  } else {
    finalDecision = 'ACCEPT';
  }
  
  return {
    hasResolutionDate: true,
    daysRemaining: Number(daysRemaining.toFixed(2)),
    category,
    profile: CATEGORY_TO_PROFILE[category] || 'BINARY_EVENT',
    adjustments: {
      edge: edgeAnalysis,
      size: sizeAnalysis,
      minEdge: minEdgeAnalysis
    },
    timing: timingAnalysis,
    finalDecision,
    summary: {
      originalEdge: rawEdge,
      adjustedEdge: edgeAnalysis.adjustedEdge,
      originalSize: baseSize,
      adjustedSize: sizeAnalysis.adjustedSize,
      minEdgeRequired: minEdgeAnalysis.minEdge,
      passesMinEdge: rawEdge >= minEdgeAnalysis.minEdge
    }
  };
}

/**
 * Filter markets by time remaining
 * @param {Array} markets - Array of markets
 * @param {Object} config - Filter configuration
 * @returns {Array} - Filtered markets
 */
function filterMarketsByTime(markets, config = {}) {
  const {
    minDays = 0.25,      // Minimum 6 hours
    maxDays = 365,       // Maximum 1 year
    preferredMin = 3,    // Prefer > 3 days
    preferredMax = 90    // Prefer < 90 days
  } = config;
  
  return markets
    .map(market => {
      const daysRemaining = calculateDaysRemaining(market.endDate);
      return { ...market, daysRemaining };
    })
    .filter(market => {
      if (market.daysRemaining === null) return true; // Keep if no date
      return market.daysRemaining >= minDays && market.daysRemaining <= maxDays;
    })
    .map(market => {
      const inPreferredRange = market.daysRemaining === null ||
        (market.daysRemaining >= preferredMin && market.daysRemaining <= preferredMax);
      return {
        ...market,
        inPreferredTimeRange: inPreferredRange,
        timeScore: inPreferredRange ? 1.0 : 0.7
      };
    });
}

module.exports = {
  TIME_PROFILES,
  CATEGORY_TO_PROFILE,
  calculateDaysRemaining,
  getTimeProfile,
  calculateTimeAdjustedEdge,
  calculateTimeAdjustedSize,
  calculateMinimumEdgeRequired,
  calculateOptimalTiming,
  getTimeAnalysis,
  filterMarketsByTime
};
