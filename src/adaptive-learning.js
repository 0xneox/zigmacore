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
    console.log('[LEARNING] Database indexes initialized (Supabase handles indexes automatically)');
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
    
    // Return base values for now - Supabase async would require major refactoring
    return {
      adjustedEdge: baseEdge,
      adjustedConfidence: baseConfidence,
      learningFactor: 0,
      sampleSize: 0,
      message: 'Adaptive learning temporarily disabled for Supabase migration'
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
    // Return empty stats for now - Supabase async would require major refactoring
    return [];
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
    // Skip for now - Supabase async would require major refactoring
    console.log(`[LEARNING] Skipped recording outcome for signal ${signalId}: ${outcome} (Supabase migration)`);
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
    // Return empty insights for now - Supabase async would require major refactoring
    return {};
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
