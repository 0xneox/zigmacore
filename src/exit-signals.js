/**
 * Exit Signal Generator Module
 * Determines when to CLOSE positions based on multiple factors
 * - Price movement vs entry
 * - Time decay / approaching resolution
 * - News sentiment shift
 * - Edge deterioration
 */

const { initDb } = require('./db');

// Exit thresholds
const EXIT_CONFIG = {
  // Profit taking
  PROFIT_TARGET_PERCENT: 25,        // Take profit at 25% gain
  TRAILING_STOP_PERCENT: 15,        // Trail by 15% from peak
  
  // Stop loss
  STOP_LOSS_PERCENT: 20,            // Cut loss at 20%
  
  // Time-based
  TIME_DECAY_DAYS: 3,               // Start considering exit 3 days before resolution
  STALE_POSITION_DAYS: 30,          // Flag positions held > 30 days
  
  // Edge-based
  EDGE_REVERSAL_THRESHOLD: -0.03,   // Exit if edge flips negative by 3%+
  CONFIDENCE_DROP_THRESHOLD: 20,    // Exit if confidence drops by 20+ points
  
  // Liquidity
  LIQUIDITY_DRY_THRESHOLD: 10000,   // Exit if liquidity drops below $10k
};

/**
 * Calculate current P&L for a position
 * @param {Object} position - Position object with entry price and current price
 * @returns {Object} - P&L metrics
 */
function calculatePositionPnL(position) {
  const { entryPrice, currentPrice, side, size } = position;
  
  if (!entryPrice || !currentPrice) {
    return { pnlPercent: 0, pnlAbsolute: 0, direction: 'flat' };
  }
  
  let pnlPercent, pnlAbsolute;
  
  if (side === 'YES' || side === 'BUY_YES') {
    // Bought YES: profit if price goes up
    pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    pnlAbsolute = (currentPrice - entryPrice) * (size || 1);
  } else {
    // Bought NO: profit if price goes down (YES price)
    pnlPercent = ((entryPrice - currentPrice) / (1 - entryPrice)) * 100;
    pnlAbsolute = (entryPrice - currentPrice) * (size || 1);
  }
  
  return {
    pnlPercent: Number(pnlPercent.toFixed(2)),
    pnlAbsolute: Number(pnlAbsolute.toFixed(4)),
    direction: pnlPercent > 0 ? 'profit' : pnlPercent < 0 ? 'loss' : 'flat'
  };
}

/**
 * Check if position should be exited based on profit target
 * @param {Object} position - Position with P&L data
 * @param {number} peakPnL - Highest P&L reached
 * @returns {Object} - Exit signal if triggered
 */
function checkProfitExit(position, peakPnL = null) {
  const pnl = calculatePositionPnL(position);
  
  // Fixed profit target
  if (pnl.pnlPercent >= EXIT_CONFIG.PROFIT_TARGET_PERCENT) {
    return {
      shouldExit: true,
      reason: 'PROFIT_TARGET',
      priority: 'medium',
      message: `Profit target reached: ${pnl.pnlPercent.toFixed(1)}% >= ${EXIT_CONFIG.PROFIT_TARGET_PERCENT}%`,
      pnl: pnl.pnlPercent
    };
  }
  
  // Trailing stop from peak
  if (peakPnL !== null && peakPnL > 10) {
    const dropFromPeak = peakPnL - pnl.pnlPercent;
    if (dropFromPeak >= EXIT_CONFIG.TRAILING_STOP_PERCENT) {
      return {
        shouldExit: true,
        reason: 'TRAILING_STOP',
        priority: 'high',
        message: `Trailing stop triggered: dropped ${dropFromPeak.toFixed(1)}% from peak of ${peakPnL.toFixed(1)}%`,
        pnl: pnl.pnlPercent
      };
    }
  }
  
  return { shouldExit: false };
}

/**
 * Check if position should be exited based on stop loss
 * @param {Object} position - Position with P&L data
 * @returns {Object} - Exit signal if triggered
 */
function checkStopLoss(position) {
  const pnl = calculatePositionPnL(position);
  
  if (pnl.pnlPercent <= -EXIT_CONFIG.STOP_LOSS_PERCENT) {
    return {
      shouldExit: true,
      reason: 'STOP_LOSS',
      priority: 'critical',
      message: `Stop loss triggered: ${pnl.pnlPercent.toFixed(1)}% <= -${EXIT_CONFIG.STOP_LOSS_PERCENT}%`,
      pnl: pnl.pnlPercent
    };
  }
  
  return { shouldExit: false };
}

/**
 * Check if position should be exited based on time decay
 * @param {Object} position - Position with resolution date
 * @param {Date} now - Current date
 * @returns {Object} - Exit signal if triggered
 */
function checkTimeDecayExit(position, now = new Date()) {
  const { endDate, resolutionDate } = position;
  const resolution = new Date(endDate || resolutionDate);
  
  if (isNaN(resolution.getTime())) {
    return { shouldExit: false };
  }
  
  const daysToResolution = (resolution - now) / (1000 * 60 * 60 * 24);
  const pnl = calculatePositionPnL(position);
  
  // If losing and close to resolution, cut losses
  if (daysToResolution <= EXIT_CONFIG.TIME_DECAY_DAYS && pnl.pnlPercent < 0) {
    return {
      shouldExit: true,
      reason: 'TIME_DECAY_LOSS',
      priority: 'high',
      message: `Resolution in ${daysToResolution.toFixed(1)} days with ${pnl.pnlPercent.toFixed(1)}% loss - limited recovery time`,
      daysToResolution: Number(daysToResolution.toFixed(1)),
      pnl: pnl.pnlPercent
    };
  }
  
  // If small profit and very close to resolution, consider locking in
  if (daysToResolution <= 1 && pnl.pnlPercent > 5 && pnl.pnlPercent < EXIT_CONFIG.PROFIT_TARGET_PERCENT) {
    return {
      shouldExit: true,
      reason: 'LOCK_PROFIT_PRE_RESOLUTION',
      priority: 'medium',
      message: `Resolution in ${daysToResolution.toFixed(1)} days - lock in ${pnl.pnlPercent.toFixed(1)}% profit`,
      daysToResolution: Number(daysToResolution.toFixed(1)),
      pnl: pnl.pnlPercent
    };
  }
  
  return { shouldExit: false, daysToResolution: Number(daysToResolution.toFixed(1)) };
}

/**
 * Check if position should be exited based on edge deterioration
 * @param {Object} position - Position data
 * @param {Object} currentAnalysis - Current market analysis with edge
 * @returns {Object} - Exit signal if triggered
 */
function checkEdgeDeteriorationExit(position, currentAnalysis) {
  if (!currentAnalysis || currentAnalysis.edge === undefined) {
    return { shouldExit: false };
  }
  
  const { originalEdge, originalConfidence, side } = position;
  const { edge: currentEdge, confidence: currentConfidence } = currentAnalysis;
  
  // Check if edge has reversed
  const edgeChange = currentEdge - (originalEdge || 0);
  
  // If we bought YES and edge is now suggesting NO (negative edge for YES)
  const isBuyYes = side === 'YES' || side === 'BUY_YES';
  const edgeReversed = isBuyYes ? currentEdge < EXIT_CONFIG.EDGE_REVERSAL_THRESHOLD : currentEdge > -EXIT_CONFIG.EDGE_REVERSAL_THRESHOLD;
  
  if (edgeReversed && Math.abs(currentEdge) > 0.03) {
    return {
      shouldExit: true,
      reason: 'EDGE_REVERSAL',
      priority: 'high',
      message: `Edge reversed: was ${((originalEdge || 0) * 100).toFixed(1)}%, now ${(currentEdge * 100).toFixed(1)}%`,
      originalEdge: originalEdge,
      currentEdge: currentEdge
    };
  }
  
  // Check confidence drop
  if (originalConfidence && currentConfidence) {
    const confidenceDrop = originalConfidence - currentConfidence;
    if (confidenceDrop >= EXIT_CONFIG.CONFIDENCE_DROP_THRESHOLD) {
      return {
        shouldExit: true,
        reason: 'CONFIDENCE_DROP',
        priority: 'medium',
        message: `Confidence dropped: was ${originalConfidence}%, now ${currentConfidence}%`,
        confidenceDrop: confidenceDrop
      };
    }
  }
  
  return { shouldExit: false };
}

/**
 * Check if position should be exited based on liquidity concerns
 * @param {Object} position - Position data
 * @param {Object} market - Current market data with liquidity
 * @returns {Object} - Exit signal if triggered
 */
function checkLiquidityExit(position, market) {
  if (!market || !market.liquidity) {
    return { shouldExit: false };
  }
  
  const { size } = position;
  const { liquidity } = market;
  
  // Low absolute liquidity
  if (liquidity < EXIT_CONFIG.LIQUIDITY_DRY_THRESHOLD) {
    return {
      shouldExit: true,
      reason: 'LIQUIDITY_DRY',
      priority: 'high',
      message: `Market liquidity dropped to $${liquidity.toFixed(0)} - exit before trapped`,
      liquidity: liquidity
    };
  }
  
  // Position is too large relative to liquidity (>20%)
  if (size && (size / liquidity) > 0.20) {
    return {
      shouldExit: true,
      reason: 'POSITION_TOO_LARGE',
      priority: 'medium',
      message: `Position is ${((size / liquidity) * 100).toFixed(1)}% of market liquidity`,
      positionToLiquidity: size / liquidity
    };
  }
  
  return { shouldExit: false };
}

/**
 * Check if position is stale (held too long without movement)
 * @param {Object} position - Position with entry date
 * @returns {Object} - Exit signal if triggered
 */
function checkStalePosition(position) {
  const { entryDate, timestamp } = position;
  const entry = new Date(entryDate || timestamp);
  
  if (isNaN(entry.getTime())) {
    return { shouldExit: false };
  }
  
  const daysHeld = (Date.now() - entry.getTime()) / (1000 * 60 * 60 * 24);
  const pnl = calculatePositionPnL(position);
  
  // Stale and flat/losing
  if (daysHeld >= EXIT_CONFIG.STALE_POSITION_DAYS && pnl.pnlPercent <= 5) {
    return {
      shouldExit: true,
      reason: 'STALE_POSITION',
      priority: 'low',
      message: `Position held ${daysHeld.toFixed(0)} days with only ${pnl.pnlPercent.toFixed(1)}% gain - capital inefficiency`,
      daysHeld: Number(daysHeld.toFixed(0)),
      pnl: pnl.pnlPercent
    };
  }
  
  return { shouldExit: false, daysHeld: Number(daysHeld.toFixed(0)) };
}

/**
 * Generate comprehensive exit signal for a position
 * @param {Object} position - Full position data
 * @param {Object} market - Current market data
 * @param {Object} analysis - Current analysis (optional)
 * @param {number} peakPnL - Historical peak P&L (optional)
 * @returns {Object} - Exit recommendation
 */
function generateExitSignal(position, market = {}, analysis = null, peakPnL = null) {
  const signals = [];
  
  // Run all exit checks
  const profitCheck = checkProfitExit(position, peakPnL);
  if (profitCheck.shouldExit) signals.push(profitCheck);
  
  const stopLossCheck = checkStopLoss(position);
  if (stopLossCheck.shouldExit) signals.push(stopLossCheck);
  
  const timeCheck = checkTimeDecayExit(position);
  if (timeCheck.shouldExit) signals.push(timeCheck);
  
  const edgeCheck = checkEdgeDeteriorationExit(position, analysis);
  if (edgeCheck.shouldExit) signals.push(edgeCheck);
  
  const liquidityCheck = checkLiquidityExit(position, market);
  if (liquidityCheck.shouldExit) signals.push(liquidityCheck);
  
  const staleCheck = checkStalePosition(position);
  if (staleCheck.shouldExit) signals.push(staleCheck);
  
  // Prioritize signals
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  signals.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  
  const pnl = calculatePositionPnL(position);
  
  if (signals.length === 0) {
    return {
      shouldExit: false,
      recommendation: 'HOLD',
      currentPnL: pnl.pnlPercent,
      signals: [],
      metadata: {
        daysToResolution: timeCheck.daysToResolution,
        daysHeld: staleCheck.daysHeld
      }
    };
  }
  
  const primarySignal = signals[0];
  
  return {
    shouldExit: true,
    recommendation: primarySignal.reason,
    priority: primarySignal.priority,
    message: primarySignal.message,
    currentPnL: pnl.pnlPercent,
    signals: signals,
    suggestedAction: pnl.pnlPercent >= 0 ? 'TAKE_PROFIT' : 'CUT_LOSS',
    urgency: primarySignal.priority === 'critical' ? 'IMMEDIATE' : 
             primarySignal.priority === 'high' ? 'TODAY' : 'WHEN_CONVENIENT'
  };
}

/**
 * Scan all positions and generate exit signals
 * @param {Array} positions - Array of positions
 * @param {Map} marketData - Map of market ID to current market data
 * @param {Map} analysisCache - Map of market ID to current analysis
 * @returns {Array} - Array of exit recommendations
 */
function scanPositionsForExits(positions, marketData = new Map(), analysisCache = new Map()) {
  const exitSignals = [];
  
  for (const position of positions) {
    const marketId = position.conditionId || position.marketId || position.id;
    const market = marketData.get(marketId) || {};
    const analysis = analysisCache.get(marketId) || null;
    
    const signal = generateExitSignal(position, market, analysis);
    
    if (signal.shouldExit) {
      exitSignals.push({
        marketId,
        title: position.title || position.question || marketId,
        ...signal
      });
    }
  }
  
  // Sort by urgency and P&L
  const urgencyOrder = { IMMEDIATE: 0, TODAY: 1, WHEN_CONVENIENT: 2 };
  exitSignals.sort((a, b) => {
    const urgencyDiff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
    if (urgencyDiff !== 0) return urgencyDiff;
    return a.currentPnL - b.currentPnL; // Biggest losses first
  });
  
  return exitSignals;
}

/**
 * Store peak P&L for trailing stop calculation
 */
const peakPnLTracker = new Map();

function updatePeakPnL(positionId, currentPnL) {
  const current = peakPnLTracker.get(positionId) || 0;
  if (currentPnL > current) {
    peakPnLTracker.set(positionId, currentPnL);
  }
  return peakPnLTracker.get(positionId);
}

function getPeakPnL(positionId) {
  return peakPnLTracker.get(positionId) || 0;
}

function clearPeakPnL(positionId) {
  peakPnLTracker.delete(positionId);
}

module.exports = {
  calculatePositionPnL,
  checkProfitExit,
  checkStopLoss,
  checkTimeDecayExit,
  checkEdgeDeteriorationExit,
  checkLiquidityExit,
  checkStalePosition,
  generateExitSignal,
  scanPositionsForExits,
  updatePeakPnL,
  getPeakPnL,
  clearPeakPnL,
  EXIT_CONFIG
};
