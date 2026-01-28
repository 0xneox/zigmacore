/**
 * Heartbeat System for Proactive Alerts
 * Monitors tracked markets and sends alerts on significant changes
 */

const { BoundedMap } = require('./bounded-map');

// Store tracked markets with their alert thresholds
const trackedMarkets = new BoundedMap(1000);

// Store alert cooldowns to prevent spam
const alertCooldowns = new BoundedMap(1000);

// Store last notification for each market to prevent duplicates
const lastNotifications = new BoundedMap(1000);

/**
 * Add a market to tracking
 * @param {string} userId - User ID
 * @param {string} marketId - Market ID
 * @param {number} threshold - Alert threshold (edge change %)
 * @returns {Object} Tracking info
 */
function addTrackedMarket(userId, marketId, threshold = 5) {
  const key = `${userId}:${marketId}`;
  
  const tracking = {
    userId,
    marketId,
    threshold,
    addedAt: Date.now(),
    lastEdge: null,
    lastCheck: null
  };
  
  trackedMarkets.set(key, tracking);
  
  return {
    success: true,
    marketId,
    threshold,
    message: `Now tracking market. Will alert when edge changes by ${threshold}%`
  };
}

/**
 * Remove a market from tracking
 * @param {string} userId - User ID
 * @param {string} marketId - Market ID
 * @returns {Object} Result
 */
function removeTrackedMarket(userId, marketId) {
  const key = `${userId}:${marketId}`;
  
  if (!trackedMarkets.has(key)) {
    return {
      success: false,
      message: 'Market not being tracked'
    };
  }
  
  trackedMarkets.delete(key);
  alertCooldowns.delete(key);
  lastNotifications.delete(key);
  
  return {
    success: true,
    message: 'Stopped tracking market'
  };
}

/**
 * Get all tracked markets for a user
 * @param {string} userId - User ID
 * @returns {Array} Tracked markets
 */
function getTrackedMarkets(userId) {
  const markets = [];
  
  for (const [key, tracking] of trackedMarkets.entries()) {
    if (key.startsWith(`${userId}:`)) {
      markets.push(tracking);
    }
  }
  
  return markets;
}

/**
 * Check if an alert should be sent based on cooldown
 * @param {string} alertKey - Unique alert key
 * @param {number} cooldownMs - Cooldown period in milliseconds
 * @returns {boolean} Whether alert should be sent
 */
function shouldSendAlert(alertKey, cooldownMs = 0) {
  const now = Date.now();
  const lastAlert = alertCooldowns.get(alertKey);
  
  if (lastAlert === undefined) {
    return true;
  }
  
  const timeSinceLastAlert = now - lastAlert;
  return timeSinceLastAlert >= cooldownMs;
}

/**
 * Record that an alert was sent
 * @param {string} alertKey - Unique alert key
 */
function recordAlertSent(alertKey) {
  alertCooldowns.set(alertKey, Date.now());
}

/**
 * Check for edge changes on tracked markets
 * @param {Array} liveSignals - Current live signals
 * @returns {Array} Alerts to send
 */
function checkEdgeChanges(liveSignals) {
  const alerts = [];
  
  for (const [key, tracking] of trackedMarkets.entries()) {
    try {
      // Find current market data
      const market = liveSignals.find(s => s.marketId === tracking.marketId);
      
      if (!market) {
        continue;
      }
      
      // Calculate current edge
      const currentEdge = Math.abs(market.edgeScoreDecimal || (market.edge || 0)) * 100;
      const lastEdge = tracking.lastEdge;
      
      // First check - store edge and continue
      if (lastEdge === null) {
        tracking.lastEdge = currentEdge;
        tracking.lastCheck = Date.now();
        trackedMarkets.set(key, tracking);
        continue;
      }
      
      // Calculate edge change
      const edgeChange = Math.abs(currentEdge - lastEdge);
      
      // Check if edge crossed threshold
      if (edgeChange >= tracking.threshold) {
        const alertKey = `edge_change:${key}`;
        
        // Check cooldown (1 hour default)
        if (shouldSendAlert(alertKey, 60 * 60 * 1000)) {
          alerts.push({
            type: 'EDGE_CHANGE',
            userId: tracking.userId,
            marketId: tracking.marketId,
            market: {
              question: market.marketQuestion,
              currentEdge: currentEdge.toFixed(1),
              previousEdge: lastEdge.toFixed(1),
              edgeChange: edgeChange.toFixed(1),
              recommendation: market.action || 'NO_TRADE',
              confidence: market.confidence || 0
            },
            timestamp: Date.now()
          });
          
          recordAlertSent(alertKey);
        }
      }
      
      // Update tracking data
      tracking.lastEdge = currentEdge;
      tracking.lastCheck = Date.now();
      trackedMarkets.set(key, tracking);
      
    } catch (error) {
      console.error('Error checking edge changes:', error.message);
    }
  }
  
  return alerts;
}

/**
 * Check for high-confidence signals
 * @param {Array} liveSignals - Current live signals
 * @param {Object} config - Alert configuration
 * @returns {Array} Alerts to send
 */
function checkHighConfidenceSignals(liveSignals, config = {}) {
  const alerts = [];
  const {
    minEdge = 0.08, // 8%
    minConfidence = 0.70, // 70%
    cooldownMinutes = 60
  } = config;
  
  for (const signal of liveSignals) {
    try {
      const edge = Math.abs(signal.edgeScoreDecimal || (signal.edge || 0));
      const confidence = signal.confidence || 0;
      
      // Check if signal meets criteria
      if (edge >= minEdge && confidence >= minConfidence) {
        const alertKey = `high_edge:${signal.marketId}`;
        
        // Check cooldown
        if (shouldSendAlert(alertKey, cooldownMinutes * 60 * 1000)) {
          alerts.push({
            type: 'HIGH_EDGE_SIGNAL',
            marketId: signal.marketId,
            market: {
              question: signal.marketQuestion,
              edge: (edge * 100).toFixed(1),
              confidence: (confidence * 100).toFixed(0),
              recommendation: signal.action || 'NO_TRADE',
              tier: signal.tier || 'UNKNOWN',
              liquidity: signal.liquidity || 0,
              kelly: signal.kellyFraction || 0
            },
            timestamp: Date.now()
          });
          
          recordAlertSent(alertKey);
        }
      }
      
    } catch (error) {
      console.error('Error checking high-confidence signals:', error.message);
    }
  }
  
  return alerts;
}

/**
 * Check for arbitrage opportunities
 * @param {Array} opportunities - Arbitrage opportunities
 * @param {Object} config - Alert configuration
 * @returns {Array} Alerts to send
 */
function checkArbitrageOpportunities(opportunities, config = {}) {
  const alerts = [];
  const {
    minProfit = 0.03, // 3%
    cooldownMinutes = 30
  } = config;
  
  for (const opp of opportunities) {
    try {
      const profit = opp.expectedProfit || 0;
      
      // Check if opportunity meets criteria
      if (profit >= minProfit) {
        const alertKey = `arbitrage:${opp.marketAId}_${opp.marketBId}`;
        
        // Check cooldown
        if (shouldSendAlert(alertKey, cooldownMinutes * 60 * 1000)) {
          alerts.push({
            type: 'ARBITRAGE_OPPORTUNITY',
            marketAId: opp.marketAId,
            marketBId: opp.marketBId,
            opportunity: {
              type: opp.type || 'UNKNOWN',
              expectedProfit: (profit * 100).toFixed(1),
              marketATitle: opp.marketATitle?.slice(0, 50),
              marketBTitle: opp.marketBTitle?.slice(0, 50),
              trades: opp.trades || [],
              confidence: opp.confidence || 0
            },
            timestamp: Date.now()
          });
          
          recordAlertSent(alertKey);
        }
      }
      
    } catch (error) {
      console.error('Error checking arbitrage opportunities:', error.message);
    }
  }
  
  return alerts;
}

/**
 * Check for exit signals
 * @param {Array} liveSignals - Current live signals
 * @param {Object} config - Alert configuration
 * @returns {Array} Alerts to send
 */
function checkExitSignals(liveSignals, config = {}) {
  const alerts = [];
  const {
    cooldownMinutes = 0 // Exit signals are urgent
  } = config;
  
  for (const signal of liveSignals) {
    try {
      // Check if signal has exit recommendation
      if (signal.action === 'EXIT' || signal.exitSignal) {
        const alertKey = `exit_signal:${signal.marketId}`;
        
        // Check cooldown (immediate for exits)
        if (shouldSendAlert(alertKey, cooldownMinutes * 60 * 1000)) {
          alerts.push({
            type: 'EXIT_SIGNAL',
            marketId: signal.marketId,
            market: {
              question: signal.marketQuestion,
              reason: signal.exitReason || 'Exit signal generated',
              pnl: signal.pnl || 0,
              holdTime: signal.holdTime || 0
            },
            timestamp: Date.now(),
            urgent: true
          });
          
          recordAlertSent(alertKey);
        }
      }
      
    } catch (error) {
      console.error('Error checking exit signals:', error.message);
    }
  }
  
  return alerts;
}

/**
 * Run heartbeat check
 * @param {Object} data - Current data
 * @returns {Array} All alerts to send
 */
function runHeartbeat(data = {}) {
  const {
    liveSignals = [],
    arbitrageOpportunities = [],
    config = {}
  } = data;
  
  const allAlerts = [];
  
  // Check edge changes on tracked markets
  const edgeChangeAlerts = checkEdgeChanges(liveSignals);
  allAlerts.push(...edgeChangeAlerts);
  
  // Check high-confidence signals
  const highEdgeAlerts = checkHighConfidenceSignals(liveSignals, config.highEdge);
  allAlerts.push(...highEdgeAlerts);
  
  // Check arbitrage opportunities
  const arbitrageAlerts = checkArbitrageOpportunities(arbitrageOpportunities, config.arbitrage);
  allAlerts.push(...arbitrageAlerts);
  
  // Check exit signals
  const exitAlerts = checkExitSignals(liveSignals, config.exit);
  allAlerts.push(...exitAlerts);
  
  return allAlerts;
}

/**
 * Get heartbeat stats
 * @returns {Object} Stats
 */
function getHeartbeatStats() {
  return {
    trackedMarketsCount: trackedMarkets.size,
    activeCooldownsCount: alertCooldowns.size,
    lastNotificationsCount: lastNotifications.size
  };
}

module.exports = {
  addTrackedMarket,
  removeTrackedMarket,
  getTrackedMarkets,
  checkEdgeChanges,
  checkHighConfidenceSignals,
  checkArbitrageOpportunities,
  checkExitSignals,
  runHeartbeat,
  getHeartbeatStats
};
