/**
 * Confidence Calibration Module
 * Calibrates model confidence to match actual accuracy
 */

const { initDb } = require('./db');

// Calibration parameters
const CALIBRATION_WINDOW_DAYS = 30;
const MIN_SIGNALS_FOR_CALIBRATION = 20;
const CONFIDENCE_BINS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

/**
 * Calculate calibration metrics for confidence bins
 * @param {Array<Object>} signals - Array of signals with confidence and outcome
 * @returns {Object} - Calibration metrics
 */
function calculateCalibrationMetrics(signals) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return {
      bins: [],
      overallCalibrationError: 0,
      message: 'No signals to calibrate'
    };
  }

  // Initialize bins
  const bins = [];
  for (let i = 0; i < CONFIDENCE_BINS.length - 1; i++) {
    bins.push({
      min: CONFIDENCE_BINS[i],
      max: CONFIDENCE_BINS[i + 1],
      predicted: 0,
      correct: 0,
      total: 0,
      actualAccuracy: 0,
      predictedAccuracy: (CONFIDENCE_BINS[i] + CONFIDENCE_BINS[i + 1]) / 2 / 100,
      calibrationError: 0
    });
  }

  // Bin the signals
  for (const signal of signals) {
    const confidence = signal.confidence || 0;
    const binIndex = Math.min(Math.floor(confidence / 10), bins.length - 1);
    
    bins[binIndex].total++;
    bins[binIndex].predicted++;
    
    // Check if prediction was correct
    const predictedYes = signal.predictedProbability > 0.5;
    const actualYes = signal.outcome === 'YES';
    if (predictedYes === actualYes) {
      bins[binIndex].correct++;
    }
  }

  // Calculate metrics for each bin
  let totalCalibrationError = 0;
  let validBins = 0;

  for (const bin of bins) {
    if (bin.total > 0) {
      bin.actualAccuracy = bin.correct / bin.total;
      bin.calibrationError = Math.abs(bin.actualAccuracy - bin.predictedAccuracy);
      totalCalibrationError += bin.calibrationError;
      validBins++;
    }
  }

  const overallCalibrationError = validBins > 0 ? totalCalibrationError / validBins : 0;

  return {
    bins: bins.filter(b => b.total > 0),
    overallCalibrationError: Number(overallCalibrationError.toFixed(4)),
    validBins,
    message: `Calibration error: ${(overallCalibrationError * 100).toFixed(2)}% across ${validBins} bins`
  };
}

/**
 * Get calibration adjustment for a confidence level
 * @param {number} confidence - Raw confidence (0-100)
 * @param {string} category - Market category (optional)
 * @returns {Object} - Calibration adjustment
 */
function getCalibrationAdjustment(confidence, category = null) {
  try {
    const db = initDb();
    
    // Build query
    let query = `
      SELECT confidence, outcome, predicted_probability
      FROM trade_signals
      WHERE outcome IS NOT NULL
      AND timestamp > datetime('now', '-${CALIBRATION_WINDOW_DAYS} days')
    `;
    const params = [];

    if (category) {
      query += ` AND category = ?`;
      params.push(category);
    }

    const signals = db.prepare(query).all(...params);

    if (signals.length < MIN_SIGNALS_FOR_CALIBRATION) {
      return {
        adjustedConfidence: confidence,
        adjustment: 0,
        sampleSize: signals.length,
        message: 'Insufficient data for calibration'
      };
    }

    const metrics = calculateCalibrationMetrics(signals);
    
    // Find the bin for this confidence
    const binIndex = Math.min(Math.floor(confidence / 10), metrics.bins.length - 1);
    const bin = metrics.bins[binIndex];
    
    if (!bin || bin.total === 0) {
      return {
        adjustedConfidence: confidence,
        adjustment: 0,
        sampleSize: signals.length,
        message: 'No calibration data for this confidence level'
      };
    }

    // Calculate adjustment
    const adjustment = (bin.actualAccuracy - bin.predictedAccuracy) * 100;
    const adjustedConfidence = Math.max(0, Math.min(100, confidence + adjustment));

    return {
      adjustedConfidence: Number(adjustedConfidence.toFixed(2)),
      adjustment: Number(adjustment.toFixed(2)),
      sampleSize: bin.total,
      binAccuracy: Number(bin.actualAccuracy.toFixed(4)),
      message: `Adjusted confidence: ${adjustedConfidence.toFixed(1)}% (was ${confidence.toFixed(1)}%)`
    };

  } catch (error) {
    console.error('Calibration adjustment error:', error.message);
    return {
      adjustedConfidence: confidence,
      adjustment: 0,
      sampleSize: 0,
      message: 'Calibration failed, using raw confidence'
    };
  }
}

/**
 * Apply calibration to a signal
 * @param {Object} signal - Signal with confidence
 * @returns {Object} - Calibrated signal
 */
function applyCalibration(signal) {
  try {
    const category = signal.category || null;
    const confidence = signal.confidence || 50;
    
    const adjustment = getCalibrationAdjustment(confidence, category);
    
    return {
      ...signal,
      confidence: adjustment.adjustedConfidence,
      rawConfidence: confidence,
      confidenceAdjustment: adjustment.adjustment,
      calibrationSampleSize: adjustment.sampleSize
    };

  } catch (error) {
    console.error('Apply calibration error:', error.message);
    return signal;
  }
}

/**
 * Get overall calibration statistics
 * @returns {Object} - Calibration statistics
 */
function getCalibrationStats() {
  try {
    const db = initDb();
    
    // Get overall calibration
    const overallSignals = db.prepare(`
      SELECT confidence, outcome, predicted_probability
      FROM trade_signals
      WHERE outcome IS NOT NULL
      AND timestamp > datetime('now', '-${CALIBRATION_WINDOW_DAYS} days')
    `).all();

    const overallMetrics = calculateCalibrationMetrics(overallSignals);

    // Get calibration by category
    const categories = db.prepare(`
      SELECT DISTINCT category FROM trade_signals WHERE category IS NOT NULL
    `).all();

    const categoryStats = {};
    
    for (const { category } of categories) {
      const categorySignals = db.prepare(`
        SELECT confidence, outcome, predicted_probability
        FROM trade_signals
        WHERE category = ? AND outcome IS NOT NULL
        AND timestamp > datetime('now', '-${CALIBRATION_WINDOW_DAYS} days')
      `).all(category);

      const categoryMetrics = calculateCalibrationMetrics(categorySignals);
      
      categoryStats[category] = {
        overallCalibrationError: categoryMetrics.overallCalibrationError,
        sampleSize: categorySignals.length,
        bins: categoryMetrics.bins
      };
    }

    return {
      overall: overallMetrics,
      byCategory: categoryStats,
      message: `Overall calibration error: ${(overallMetrics.overallCalibrationError * 100).toFixed(2)}%`
    };

  } catch (error) {
    console.error('Calibration stats error:', error.message);
    return {
      overall: { overallCalibrationError: 0, bins: [] },
      byCategory: {},
      message: 'Failed to get calibration stats'
    };
  }
}

/**
 * Check if calibration is needed
 * @returns {Object} - Calibration status
 */
function checkCalibrationNeeded() {
  try {
    const db = initDb();
    
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved
      FROM trade_signals
      WHERE timestamp > datetime('now', '-${CALIBRATION_WINDOW_DAYS} days')
    `).get();

    const resolutionRate = stats.total > 0 ? stats.resolved / stats.total : 0;
    const needsCalibration = stats.resolved >= MIN_SIGNALS_FOR_CALIBRATION;

    return {
      needsCalibration,
      totalSignals: stats.total || 0,
      resolvedSignals: stats.resolved || 0,
      resolutionRate: Number(resolutionRate.toFixed(4)),
      message: needsCalibration 
        ? `Calibration ready: ${stats.resolved} resolved signals`
        : `Need ${MIN_SIGNALS_FOR_CALIBRATION - stats.resolved} more resolved signals`
    };

  } catch (error) {
    console.error('Check calibration needed error:', error.message);
    return {
      needsCalibration: false,
      message: 'Failed to check calibration status'
    };
  }
}

/**
 * Generate calibration report
 * @returns {Object} - Detailed calibration report
 */
function generateCalibrationReport() {
  try {
    const status = checkCalibrationNeeded();
    const stats = getCalibrationStats();

    // Calculate reliability diagram data
    const reliabilityData = stats.overall.bins.map(bin => ({
      confidenceRange: `${bin.min}-${bin.max}%`,
      predictedAccuracy: Number(bin.predictedAccuracy.toFixed(2)),
      actualAccuracy: Number(bin.actualAccuracy.toFixed(2)),
      sampleSize: bin.total,
      isOverconfident: bin.actualAccuracy < bin.predictedAccuracy,
      isUnderconfident: bin.actualAccuracy > bin.predictedAccuracy
    }));

    // Identify problematic bins
    const problematicBins = reliabilityData.filter(bin => 
      Math.abs(bin.predictedAccuracy - bin.actualAccuracy) > 0.15
    );

    return {
      status,
      stats,
      reliabilityDiagram: reliabilityData,
      problematicBins,
      recommendations: generateCalibrationRecommendations(stats, problematicBins),
      message: `Calibration report: ${stats.message}`
    };

  } catch (error) {
    console.error('Generate calibration report error:', error.message);
    return {
      message: 'Failed to generate calibration report'
    };
  }
}

/**
 * Generate calibration recommendations
 * @param {Object} stats - Calibration statistics
 * @param {Array} problematicBins - Problematic confidence bins
 * @returns {Array<string>} - Recommendations
 */
function generateCalibrationRecommendations(stats, problematicBins) {
  const recommendations = [];

  if (stats.overall.overallCalibrationError > 0.2) {
    recommendations.push('High calibration error detected - consider recalibrating the model');
  }

  if (problematicBins.length > 0) {
    recommendations.push(`Review confidence ranges: ${problematicBins.map(b => b.confidenceRange).join(', ')}`);
  }

  const overconfidentBins = problematicBins.filter(b => b.isOverconfident);
  if (overconfidentBins.length > 0) {
    recommendations.push('Model is overconfident in some ranges - increase uncertainty estimates');
  }

  const underconfidentBins = problematicBins.filter(b => b.isUnderconfident);
  if (underconfidentBins.length > 0) {
    recommendations.push('Model is underconfident in some ranges - confidence can be increased');
  }

  if (recommendations.length === 0) {
    recommendations.push('Calibration looks good - model confidence is well-calibrated');
  }

  return recommendations;
}

module.exports = {
  calculateCalibrationMetrics,
  getCalibrationAdjustment,
  applyCalibration,
  getCalibrationStats,
  checkCalibrationNeeded,
  generateCalibrationReport
};
