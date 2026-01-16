/**
 * Adaptive Learning Module
 * Learns from past signal outcomes to improve future predictions
 */

const { initDb } = require('./db');

// Learning parameters
const LEARNING_WINDOW_DAYS = 30;
const MIN_SIGNALS_FOR_LEARNING = 20;
const LEARNING_RATE = 0.1;

// Learning adjustment constants
const OVERCONFIDENCE_THRESHOLD = -0.1; // Accuracy error threshold for overconfidence
const UNDERCONFIDENCE_THRESHOLD = 0.1; // Accuracy error threshold for underconfidence
const OVERCONFIDENCE_CONFIDENCE_ADJUSTMENT = 0.3; // Confidence adjustment factor for overconfidence
const OVERCONFIDENCE_EDGE_ADJUSTMENT = 0.05; // Edge adjustment factor for overconfidence
const UNDERCONFIDENCE_CONFIDENCE_ADJUSTMENT = 0.2; // Confidence adjustment factor for underconfidence
const UNDERCONFIDENCE_EDGE_ADJUSTMENT = 0.03; // Edge adjustment factor for underconfidence

// Initialize database indexes for performance
function initializeIndexes() {
  try {
    const db = initDb();
    
    // Create composite index for learning queries
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_trade_signals_learning 
      ON trade_signals(category, action, outcome, timestamp DESC)
    `).run();
    
    // Create index for category performance queries
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_trade_signals_category_outcome 
      ON trade_signals(category, outcome, timestamp DESC)
    `).run();
    
    console.log('[LEARNING] Database indexes initialized');
  } catch (error) {
    console.error('[LEARNING] Failed to initialize indexes:', error.message);
  }
}

// Initialize indexes on module load
initializeIndexes();

/**
 * Calculate adaptive edge adjustment based on historical performance
 * @param {string} category - Market category
 * @param {string} actionType - BUY YES, BUY NO, SELL YES, SELL NO
 * @param {number} baseEdge - Original edge from analysis
 * @param {number} baseConfidence - Original confidence from analysis
 * @returns {Object} - Adjusted edge and confidence with learning factors
 */
function applyAdaptiveLearning(category, actionType, baseEdge, baseConfidence) {
  try {
    const db = initDb();
    
    // Calculate timestamp threshold in JavaScript to avoid SQL injection
    const timestampThreshold = new Date(Date.now() - (LEARNING_WINDOW_DAYS * 24 * 60 * 60 * 1000)).toISOString();
    
    // Fetch recent signals for this category and action type
    const recentSignals = db.prepare(`
      SELECT 
        action,
        confidence,
        edge,
        outcome,
        timestamp
      FROM trade_signals
      WHERE category = ? AND action = ?
      AND outcome IS NOT NULL
      AND timestamp > ?
      ORDER BY timestamp DESC
      LIMIT 100
    `).all(category, actionType, timestampThreshold);

    if (recentSignals.length < MIN_SIGNALS_FOR_LEARNING) {
      return {
        adjustedEdge: baseEdge,
        adjustedConfidence: baseConfidence,
        learningFactor: 0,
        sampleSize: recentSignals.length,
        message: 'Insufficient data for adaptive learning'
      };
    }

    // Calculate actual accuracy based on action type, not edge direction
    const correctSignals = recentSignals.filter(s => {
      // Determine prediction based on action type
      const predictedYes = s.action === 'BUY YES' || s.action === 'SELL NO';
      const actualYes = s.outcome === 'YES';
      return predictedYes === actualYes;
    }).length;

    const actualAccuracy = correctSignals / recentSignals.length;
    const predictedAccuracy = baseConfidence / 100;
    const accuracyError = actualAccuracy - predictedAccuracy;

    // Calculate edge performance
    const avgEdge = recentSignals.reduce((sum, s) => sum + (s.edge || 0), 0) / recentSignals.length;
    const edgePerformance = recentSignals.filter(s => s.outcome === 'YES').length / recentSignals.length;

    // Apply learning adjustments - ENABLED with conservative factors
    let edgeAdjustment = 0;
    let confidenceAdjustment = 0;

    // If model is overconfident, reduce confidence
    if (accuracyError < OVERCONFIDENCE_THRESHOLD) {
      confidenceAdjustment = accuracyError * OVERCONFIDENCE_CONFIDENCE_ADJUSTMENT;
      edgeAdjustment = -Math.abs(baseEdge) * OVERCONFIDENCE_EDGE_ADJUSTMENT;
    }
    // If model is underconfident, increase confidence
    else if (accuracyError > UNDERCONFIDENCE_THRESHOLD) {
      confidenceAdjustment = accuracyError * UNDERCONFIDENCE_CONFIDENCE_ADJUSTMENT;
      edgeAdjustment = Math.abs(baseEdge) * UNDERCONFIDENCE_EDGE_ADJUSTMENT;
    }

    // Apply learning rate
    const learningFactor = Math.min(1, recentSignals.length / MIN_SIGNALS_FOR_LEARNING) * LEARNING_RATE;

    const adjustedConfidence = Math.max(0, Math.min(100, baseConfidence + (confidenceAdjustment * 100 * learningFactor)));
    const adjustedEdge = baseEdge + (edgeAdjustment * learningFactor);

    return {
      adjustedEdge: Number(adjustedEdge.toFixed(4)),
      adjustedConfidence: Number(adjustedConfidence.toFixed(2)),
      learningFactor: Number(learningFactor.toFixed(3)),
      sampleSize: recentSignals.length,
      actualAccuracy: Number(actualAccuracy.toFixed(4)),
      message: `Applied adaptive learning based on ${recentSignals.length} signals`
    };

  } catch (error) {
    console.error('Adaptive learning error:', error.message);
    return {
      adjustedEdge: baseEdge,
      adjustedConfidence: baseConfidence,
      learningFactor: 0,
      sampleSize: 0,
      message: 'Adaptive learning failed, using base values'
    };
  }
}

/**
 * Get learning statistics for a category
 * @param {string} category - Market category
 * @returns {Object} - Learning statistics
 */
function getLearningStats(category) {
  try {
    const db = initDb();
    
    const stats = db.prepare(`
      SELECT 
        action,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'YES' THEN 1 ELSE 0 END) as correct,
        AVG(confidence) as avgConfidence,
        AVG(edge) as avgEdge
      FROM trade_signals
      WHERE category = ? AND outcome IS NOT NULL
      GROUP BY action
    `).all(category);

    return stats.map(stat => ({
      ...stat,
      accuracy: stat.total > 0 ? stat.correct / stat.total : 0
    }));

  } catch (error) {
    console.error('Learning stats error:', error.message);
    return [];
  }
}

/**
 * Record signal outcome for learning
 * @param {string} signalId - Signal identifier
 * @param {string} outcome - YES, NO, or PENDING
 * @param {string} category - Market category
 * @param {string} action - Action taken
 * @param {number} edge - Signal edge
 * @param {number} confidence - Signal confidence
 */
function recordSignalOutcome(signalId, outcome, category, action, edge, confidence) {
  try {
    const db = initDb();
    
    // Check if signal exists
    const existing = db.prepare('SELECT id FROM trade_signals WHERE id = ?').get(signalId);
    
    if (existing) {
      db.prepare(`
        UPDATE trade_signals
        SET outcome = ?, category = ?, action = ?, edge = ?, confidence = ?
        WHERE id = ?
      `).run(outcome, category, action, edge, confidence, signalId);
    } else {
      db.prepare(`
        INSERT INTO trade_signals (id, market_id, action, price, confidence, kelly_fraction, outcome, category, edge)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(signalId, signalId, action, 0, confidence, 0, outcome, category, edge);
    }

    console.log(`[LEARNING] Recorded outcome for signal ${signalId}: ${outcome}`);
    return true;

  } catch (error) {
    console.error('Record signal outcome error:', error.message);
    return false;
  }
}

/**
 * Get category-specific performance insights
 * @returns {Object} - Performance insights by category
 */
function getCategoryPerformanceInsights() {
  try {
    const db = initDb();
    
    const categories = db.prepare(`
      SELECT DISTINCT category FROM trade_signals WHERE category IS NOT NULL
    `).all();

    const insights = {};
    
    // Calculate timestamp threshold for recent signals
    const recentTimestamp = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)).toISOString();
    
    for (const { category } of categories) {
      const stats = getLearningStats(category);
      const recentSignals = db.prepare(`
        SELECT 
          AVG(CASE WHEN outcome = 'YES' THEN 1 ELSE 0 END) as winRate,
          COUNT(*) as total
        FROM trade_signals
        WHERE category = ? AND outcome IS NOT NULL
        AND timestamp > ?
      `).get(category, recentTimestamp);

      insights[category] = {
        stats,
        recentWinRate: recentSignals?.winRate || 0,
        recentVolume: recentSignals?.total || 0,
        recommendation: recentSignals?.winRate > 0.6 ? 'STRONG' : recentSignals?.winRate > 0.5 ? 'MODERATE' : 'WEAK'
      };
    }

    return insights;

  } catch (error) {
    console.error('Category insights error:', error.message);
    return {};
  }
}

module.exports = {
  applyAdaptiveLearning,
  getLearningStats,
  recordSignalOutcome,
  getCategoryPerformanceInsights
};
