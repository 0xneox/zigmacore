/**
 * Adaptive Learning Module
 * Learns from past signal outcomes to improve future predictions
 */

const { initDb } = require('./db');

// Learning parameters
const LEARNING_WINDOW_DAYS = 30;
const MIN_SIGNALS_FOR_LEARNING = 20;
const LEARNING_RATE = 0.1;

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
      AND timestamp > datetime('now', '-${LEARNING_WINDOW_DAYS} days')
      ORDER BY timestamp DESC
      LIMIT 100
    `).all(category, actionType);

    if (recentSignals.length < MIN_SIGNALS_FOR_LEARNING) {
      return {
        adjustedEdge: baseEdge,
        adjustedConfidence: baseConfidence,
        learningFactor: 0,
        sampleSize: recentSignals.length,
        message: 'Insufficient data for adaptive learning'
      };
    }

    // Calculate actual accuracy
    const correctSignals = recentSignals.filter(s => {
      const predictedYes = s.edge > 0;
      const actualYes = s.outcome === 'YES';
      return predictedYes === actualYes;
    }).length;

    const actualAccuracy = correctSignals / recentSignals.length;
    const predictedAccuracy = baseConfidence / 100;
    const accuracyError = actualAccuracy - predictedAccuracy;

    // Calculate edge performance
    const avgEdge = recentSignals.reduce((sum, s) => sum + (s.edge || 0), 0) / recentSignals.length;
    const edgePerformance = recentSignals.filter(s => s.outcome === 'YES').length / recentSignals.length;

    // Apply learning adjustments
    let edgeAdjustment = 0;
    let confidenceAdjustment = 0;

    // If model is overconfident, reduce confidence
    if (accuracyError < -0.1) {
      confidenceAdjustment = accuracyError * 0.5; // Reduce confidence
      edgeAdjustment = -Math.abs(baseEdge) * 0.1; // Reduce edge
    }
    // If model is underconfident, increase confidence
    else if (accuracyError > 0.1) {
      confidenceAdjustment = accuracyError * 0.3; // Increase confidence
      edgeAdjustment = Math.abs(baseEdge) * 0.05; // Slightly increase edge
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
    
    for (const { category } of categories) {
      const stats = getLearningStats(category);
      const recentSignals = db.prepare(`
        SELECT 
          AVG(CASE WHEN outcome = 'YES' THEN 1 ELSE 0 END) as winRate,
          COUNT(*) as total
        FROM trade_signals
        WHERE category = ? AND outcome IS NOT NULL
        AND timestamp > datetime('now', '-7 days')
      `).get(category);

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
