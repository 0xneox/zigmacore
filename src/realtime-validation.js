/**
 * Real-Time Signal Validation Module
 * Validates signals against actual market movements in real-time
 */

const { initDb } = require('./db');
const { getClobPrice } = require('./clob_price_cache');

// Validation parameters
const VALIDATION_INTERVAL_MS = 60000; // Check every minute
const PRICE_TOLERANCE = 0.02; // 2% price movement tolerance
const VOLUME_TOLERANCE = 0.1; // 10% volume movement tolerance
const MAX_VALIDATION_AGE_MS = 300000; // 5 minutes max validation window

/**
 * Validate a signal against current market conditions
 * @param {Object} signal - Signal to validate
 * @param {Object} currentMarket - Current market data
 * @returns {Object} - Validation result
 */
function validateSignal(signal, currentMarket) {
  try {
    const now = Date.now();
    const signalAge = now - (signal.timestamp || now);
    
    // Skip validation if signal is too old
    if (signalAge > MAX_VALIDATION_AGE_MS) {
      return {
        valid: true,
        status: 'EXPIRED',
        message: 'Signal too old for validation',
        signalAge: signalAge
      };
    }

    const validations = [];
    let overallValid = true;

    // Validate price movement
    if (signal.price && currentMarket.yesPrice) {
      const priceChange = Math.abs((currentMarket.yesPrice - signal.price) / signal.price);
      const priceValid = priceChange <= PRICE_TOLERANCE;
      
      validations.push({
        type: 'price',
        valid: priceValid,
        expected: signal.price,
        actual: currentMarket.yesPrice,
        change: priceChange,
        tolerance: PRICE_TOLERANCE
      });
      
      if (!priceValid) overallValid = false;
    }

    // Validate volume movement
    if (signal.volume && currentMarket.volume24hr) {
      const volumeChange = Math.abs((currentMarket.volume24hr - signal.volume) / signal.volume);
      const volumeValid = volumeChange <= VOLUME_TOLERANCE;
      
      validations.push({
        type: 'volume',
        valid: volumeValid,
        expected: signal.volume,
        actual: currentMarket.volume24hr,
        change: volumeChange,
        tolerance: VOLUME_TOLERANCE
      });
      
      if (!volumeValid) overallValid = false;
    }

    // Validate liquidity
    if (signal.minLiquidity && currentMarket.liquidity) {
      const liquidityValid = currentMarket.liquidity >= signal.minLiquidity;
      
      validations.push({
        type: 'liquidity',
        valid: liquidityValid,
        expected: signal.minLiquidity,
        actual: currentMarket.liquidity
      });
      
      if (!liquidityValid) overallValid = false;
    }

    // Validate edge (if price moved, edge may have changed)
    if (signal.edge && signal.price && currentMarket.yesPrice) {
      const priceMovement = (currentMarket.yesPrice - signal.price) / signal.price;
      const newEdge = signal.edge - (priceMovement * 100); // Simple edge adjustment
      
      const edgeValid = newEdge > 0;
      
      validations.push({
        type: 'edge',
        valid: edgeValid,
        originalEdge: signal.edge,
        adjustedEdge: newEdge,
        priceMovement
      });
      
      if (!edgeValid) overallValid = false;
    }

    // Determine validation status
    let status = 'VALID';
    if (!overallValid) {
      const failedValidations = validations.filter(v => !v.valid);
      if (failedValidations.length === 1) {
        status = 'WARNING';
      } else {
        status = 'INVALID';
      }
    }

    return {
      valid: overallValid,
      status,
      validations,
      message: `Signal ${status.toLowerCase()}: ${validations.filter(v => !v.valid).length} validation(s) failed`,
      signalAge
    };

  } catch (error) {
    console.error('Signal validation error:', error.message);
    return {
      valid: false,
      status: 'ERROR',
      message: 'Validation failed: ' + error.message
    };
  }
}

/**
 * Batch validate multiple signals
 * @param {Array<Object>} signals - Array of signals to validate
 * @param {Array<Object>} markets - Array of current market data
 * @returns {Array<Object>} - Validation results
 */
function validateSignalsBatch(signals, markets) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return [];
  }

  const results = [];
  const marketMap = new Map();
  
  // Create market lookup map
  for (const market of markets) {
    if (market.id) marketMap.set(market.id, market);
    if (market.conditionId) marketMap.set(market.conditionId, market);
  }

  for (const signal of signals) {
    const marketId = signal.marketId || signal.id;
    const market = marketMap.get(marketId);
    
    if (market) {
      const result = validateSignal(signal, market);
      results.push({
        signalId: signal.id || signal.marketId,
        ...result
      });
    } else {
      results.push({
        signalId: signal.id || signal.marketId,
        valid: false,
        status: 'NOT_FOUND',
        message: 'Market data not found for validation'
      });
    }
  }

  return results;
}

/**
 * Get validation statistics for a time period
 * @param {number} sinceTimestamp - Start timestamp
 * @returns {Object} - Validation statistics
 */
function getValidationStats(sinceTimestamp) {
  try {
    const db = initDb();
    
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) as valid,
        SUM(CASE WHEN valid = 0 THEN 1 ELSE 0 END) as invalid,
        AVG(CASE WHEN valid = 1 THEN 1 ELSE 0 END) as validityRate
      FROM signal_validations
      WHERE timestamp > ?
    `).get(sinceTimestamp);

    return {
      total: stats.total || 0,
      valid: stats.valid || 0,
      invalid: stats.invalid || 0,
      validityRate: Number((stats.validityRate || 0).toFixed(4)),
      message: `${stats.valid || 0}/${stats.total || 0} signals valid (${((stats.validityRate || 0) * 100).toFixed(1)}%)`
    };

  } catch (error) {
    console.error('Validation stats error:', error.message);
    return {
      total: 0,
      valid: 0,
      invalid: 0,
      validityRate: 0,
      message: 'Failed to get validation stats'
    };
  }
}

/**
 * Save validation result to database
 * @param {Object} validation - Validation result
 * @returns {boolean} - Success status
 */
function saveValidationResult(validation) {
  try {
    const db = initDb();
    
    // Create signal_validations table if not exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS signal_validations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT NOT NULL,
        valid INTEGER NOT NULL,
        status TEXT NOT NULL,
        validations_json TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        signal_age INTEGER
      )
    `);

    const insert = db.prepare(`
      INSERT INTO signal_validations (signal_id, valid, status, validations_json, timestamp, signal_age)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insert.run(
      validation.signalId,
      validation.valid ? 1 : 0,
      validation.status,
      JSON.stringify(validation.validations || []),
      Date.now(),
      validation.signalAge || 0
    );

    console.log(`[VALIDATION] Saved validation for signal ${validation.signalId}: ${validation.status}`);
    return true;

  } catch (error) {
    console.error('Save validation error:', error.message);
    return false;
  }
}

/**
 * Get recent validation failures
 * @param {number} limit - Maximum number of failures to return
 * @returns {Array<Object>} - Recent validation failures
 */
function getRecentValidationFailures(limit = 20) {
  try {
    const db = initDb();
    
    const failures = db.prepare(`
      SELECT * FROM signal_validations
      WHERE valid = 0
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit);

    return failures.map(f => ({
      ...f,
      validations: JSON.parse(f.validations_json || '[]')
    }));

  } catch (error) {
    console.error('Get validation failures error:', error.message);
    return [];
  }
}

/**
 * Check if a signal should be invalidated based on validation
 * @param {Object} validation - Validation result
 * @returns {boolean} - Whether to invalidate the signal
 */
function shouldInvalidateSignal(validation) {
  // Invalidate if:
  // 1. Status is INVALID (multiple validations failed)
  // 2. Status is WARNING and edge has significantly degraded
  // 3. Price movement exceeds tolerance significantly
  
  if (validation.status === 'INVALID') {
    return true;
  }

  if (validation.status === 'WARNING') {
    const priceValidation = validation.validations?.find(v => v.type === 'price');
    if (priceValidation && priceValidation.change > PRICE_TOLERANCE * 2) {
      return true;
    }
  }

  return false;
}

module.exports = {
  validateSignal,
  validateSignalsBatch,
  getValidationStats,
  saveValidationResult,
  getRecentValidationFailures,
  shouldInvalidateSignal
};
