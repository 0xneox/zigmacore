/**
 * Token-Gated Access Control Middleware
 * Enforces tier-based access to features based on ZIGMA token balance
 */

const { verifyZigmaAccess } = require('../utils/token');

// Store daily usage tracking
const dailyUsage = new Map();

/**
 * Get or create daily usage record for a user
 * @param {string} userId - User ID
 * @returns {Object} Usage record
 */
function getDailyUsage(userId) {
  const today = new Date().toDateString();
  const key = `${userId}:${today}`;
  
  if (!dailyUsage.has(key)) {
    dailyUsage.set(key, {
      userId,
      date: today,
      signalsRequested: 0,
      walletAnalyses: 0,
      trackedMarkets: 0,
      arbitrageScans: 0
    });
  }
  
  return dailyUsage.get(key);
}

/**
 * Increment usage counter
 * @param {string} userId - User ID
 * @param {string} feature - Feature name
 */
function incrementUsage(userId, feature) {
  const usage = getDailyUsage(userId);
  
  switch (feature) {
    case 'signals':
      usage.signalsRequested++;
      break;
    case 'wallet':
      usage.walletAnalyses++;
      break;
    case 'track':
      usage.trackedMarkets++;
      break;
    case 'arbitrage':
      usage.arbitrageScans++;
      break;
  }
  
  dailyUsage.set(`${userId}:${usage.date}`, usage);
}

/**
 * Check if user has access to a feature
 * @param {string} userId - User ID
 * @param {string} walletAddress - Wallet address
 * @param {string} feature - Feature name
 * @returns {Promise<Object>} Access check result
 */
async function checkFeatureAccess(userId, walletAddress, feature) {
  // Get user's tier
  const access = await verifyZigmaAccess(walletAddress);
  const { tier, features } = access;
  
  // Get daily usage
  const usage = getDailyUsage(userId);
  
  // Feature limits by tier
  const limits = {
    FREE: {
      signalsPerDay: 3,
      walletAnalysisPerDay: 1,
      trackedMarkets: 1,
      arbitrageScans: 0,
      alerts: false,
      arbitrage: false,
      exitSignals: false
    },
    BASIC: {
      signalsPerDay: 15,
      walletAnalysisPerDay: 5,
      trackedMarkets: 5,
      arbitrageScans: 0,
      alerts: 'hourly',
      arbitrage: false,
      exitSignals: false
    },
    PRO: {
      signalsPerDay: -1, // Unlimited
      walletAnalysisPerDay: -1,
      trackedMarkets: 25,
      arbitrageScans: -1,
      alerts: '15min',
      arbitrage: true,
      exitSignals: true
    },
    WHALE: {
      signalsPerDay: -1,
      walletAnalysisPerDay: -1,
      trackedMarkets: -1,
      arbitrageScans: -1,
      alerts: 'realtime',
      arbitrage: true,
      exitSignals: true,
      apiAccess: true
    }
  };
  
  const tierLimits = limits[tier] || limits.FREE;
  
  // Check feature access
  let hasAccess = true;
  let reason = null;
  
  switch (feature) {
    case 'signals':
      if (tierLimits.signalsPerDay !== -1 && usage.signalsRequested >= tierLimits.signalsPerDay) {
        hasAccess = false;
        reason = `Daily limit reached (${tierLimits.signalsPerDay} signals/day)`;
      }
      break;
      
    case 'wallet':
      if (tierLimits.walletAnalysisPerDay !== -1 && usage.walletAnalyses >= tierLimits.walletAnalysisPerDay) {
        hasAccess = false;
        reason = `Daily limit reached (${tierLimits.walletAnalysisPerDay} analyses/day)`;
      }
      break;
      
    case 'track':
      if (tierLimits.trackedMarkets !== -1 && usage.trackedMarkets >= tierLimits.trackedMarkets) {
        hasAccess = false;
        reason = `Tracking limit reached (${tierLimits.trackedMarkets} markets)`;
      }
      break;
      
    case 'arbitrage':
      if (!tierLimits.arbitrage) {
        hasAccess = false;
        reason = 'Arbitrage scanner not available in your tier';
      }
      break;
      
    case 'alerts':
      if (!tierLimits.alerts) {
        hasAccess = false;
        reason = 'Alerts not available in your tier';
      }
      break;
      
    case 'exitSignals':
      if (!tierLimits.exitSignals) {
        hasAccess = false;
        reason = 'Exit signals not available in your tier';
      }
      break;
      
    case 'apiAccess':
      if (!tierLimits.apiAccess) {
        hasAccess = false;
        reason = 'API access not available in your tier';
      }
      break;
  }
  
  return {
    hasAccess,
    tier,
    reason,
    remaining: hasAccess ? {
      signals: tierLimits.signalsPerDay === -1 ? -1 : Math.max(0, tierLimits.signalsPerDay - usage.signalsRequested),
      wallet: tierLimits.walletAnalysisPerDay === -1 ? -1 : Math.max(0, tierLimits.walletAnalysisPerDay - usage.walletAnalyses),
      track: tierLimits.trackedMarkets === -1 ? -1 : Math.max(0, tierLimits.trackedMarkets - usage.trackedMarkets)
    } : null
  };
}

/**
 * Middleware to enforce token-gated access
 * @param {string} feature - Feature name
 * @returns {Function} Express middleware
 */
function requireTokenAccess(feature) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id || req.headers['x-user-id'];
      const walletAddress = req.headers['x-wallet-address'] || req.body?.walletAddress;
      
      if (!userId || !walletAddress) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing user ID or wallet address'
        });
      }
      
      // Check access
      const access = await checkFeatureAccess(userId, walletAddress, feature);
      
      if (!access.hasAccess) {
        return res.status(403).json({
          error: 'Feature not available',
          message: access.reason,
          tier: access.tier,
          upgradeRequired: true
        });
      }
      
      // Increment usage
      incrementUsage(userId, feature);
      
      // Add tier info to request
      req.userTier = access.tier;
      req.userFeatures = access.remaining;
      
      next();
    } catch (error) {
      console.error('[Token Access] Error:', error);
      res.status(500).json({
        error: 'Access check failed',
        message: error.message
      });
    }
  };
}

/**
 * Get user's daily usage stats
 * @param {string} userId - User ID
 * @returns {Object} Usage stats
 */
function getUserUsage(userId) {
  const today = new Date().toDateString();
  const key = `${userId}:${today}`;
  const usage = dailyUsage.get(key);
  
  if (!usage) {
    return {
      userId,
      date: today,
      signalsRequested: 0,
      walletAnalyses: 0,
      trackedMarkets: 0,
      arbitrageScans: 0
    };
  }
  
  return usage;
}

/**
 * Cleanup old daily usage records (older than 7 days)
 */
function cleanupOldUsage() {
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  
  for (const [key, usage] of dailyUsage.entries()) {
    const usageDate = new Date(usage.date).getTime();
    if (usageDate < sevenDaysAgo) {
      dailyUsage.delete(key);
    }
  }
}

// Cleanup old usage records every hour
setInterval(cleanupOldUsage, 60 * 60 * 1000);

module.exports = {
  checkFeatureAccess,
  requireTokenAccess,
  getUserUsage,
  incrementUsage,
  cleanupOldUsage
};
