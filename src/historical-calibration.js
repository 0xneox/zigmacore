/**
 * Historical Calibration System
 * Tracks resolved markets and calculates confidence calibration by bins
 * "When we say 80% confident, we're actually right X% of the time"
 */

const { supabase } = require('./supabase');

// Confidence bins for calibration analysis
const CONFIDENCE_BINS = [
  { min: 50, max: 60, label: '50-60%' },
  { min: 60, max: 70, label: '60-70%' },
  { min: 70, max: 80, label: '70-80%' },
  { min: 80, max: 90, label: '80-90%' },
  { min: 90, max: 100, label: '90-100%' }
];

const CALIBRATION_WINDOW_DAYS = 90; // Use 90 days of data
const MIN_SAMPLES_PER_BIN = 10; // Minimum samples to trust calibration

/**
 * Get resolved signals from database with confidence and outcome
 */
async function getResolvedSignals(days = CALIBRATION_WINDOW_DAYS) {
  try {
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    
    const { data, error } = await supabase
      .from('trade_signals')
      .select('id, market_id, confidence, was_correct, category, action, timestamp, resolved_at')
      .not('outcome', 'is', null)
      .not('was_correct', 'is', null)
      .gte('timestamp', cutoffDate)
      .order('resolved_at', { ascending: false });
    
    if (error) {
      console.error('[CALIBRATION] Failed to fetch resolved signals:', error.message);
      return [];
    }
    
    console.log(`[CALIBRATION] Loaded ${data?.length || 0} resolved signals from last ${days} days`);
    return data || [];
  } catch (error) {
    console.error('[CALIBRATION] Error fetching resolved signals:', error);
    return [];
  }
}

/**
 * Calculate win rate by confidence bin
 * Returns: { bin: '70-80%', predicted: 75%, actual: 68%, samples: 45, adjustment: 0.91 }
 */
async function calculateConfidenceBinCalibration(category = null) {
  const signals = await getResolvedSignals();
  
  if (signals.length === 0) {
    console.log('[CALIBRATION] No resolved signals available');
    return [];
  }
  
  // Filter by category if specified
  const filteredSignals = category 
    ? signals.filter(s => s.category === category)
    : signals;
  
  console.log(`[CALIBRATION] Analyzing ${filteredSignals.length} signals${category ? ` for ${category}` : ''}`);
  
  // Group signals into bins
  const binResults = CONFIDENCE_BINS.map(bin => {
    const binSignals = filteredSignals.filter(s => {
      const conf = s.confidence || 0;
      return conf >= bin.min && conf < bin.max;
    });
    
    const totalSignals = binSignals.length;
    const correctSignals = binSignals.filter(s => s.was_correct === 1).length;
    const actualWinRate = totalSignals > 0 ? correctSignals / totalSignals : 0;
    const predictedWinRate = (bin.min + bin.max) / 2 / 100; // Midpoint of bin
    
    // Calculate adjustment multiplier
    // If we say 75% but we're only right 60%, adjustment = 60/75 = 0.80
    const adjustment = predictedWinRate > 0 ? actualWinRate / predictedWinRate : 1.0;
    
    // Calibration error (absolute difference)
    const calibrationError = Math.abs(actualWinRate - predictedWinRate);
    
    return {
      bin: bin.label,
      minConfidence: bin.min,
      maxConfidence: bin.max,
      predictedWinRate: Number((predictedWinRate * 100).toFixed(1)),
      actualWinRate: Number((actualWinRate * 100).toFixed(1)),
      samples: totalSignals,
      correctPredictions: correctSignals,
      calibrationError: Number((calibrationError * 100).toFixed(1)),
      adjustment: Number(adjustment.toFixed(3)),
      isReliable: totalSignals >= MIN_SAMPLES_PER_BIN,
      status: totalSignals < MIN_SAMPLES_PER_BIN ? 'INSUFFICIENT_DATA' :
              calibrationError > 0.15 ? 'POORLY_CALIBRATED' :
              calibrationError > 0.10 ? 'NEEDS_IMPROVEMENT' : 'WELL_CALIBRATED'
    };
  });
  
  // Log results
  console.log(`\n[CALIBRATION] Confidence Bin Analysis${category ? ` - ${category}` : ' - ALL CATEGORIES'}:`);
  console.log('─'.repeat(100));
  console.log('Bin       | Predicted | Actual | Samples | Error  | Adjustment | Status');
  console.log('─'.repeat(100));
  
  binResults.forEach(result => {
    const statusEmoji = result.status === 'WELL_CALIBRATED' ? '✅' :
                       result.status === 'NEEDS_IMPROVEMENT' ? '⚠️' :
                       result.status === 'POORLY_CALIBRATED' ? '❌' : '⏳';
    
    console.log(
      `${result.bin.padEnd(9)} | ${String(result.predictedWinRate + '%').padEnd(9)} | ` +
      `${String(result.actualWinRate + '%').padEnd(6)} | ${String(result.samples).padEnd(7)} | ` +
      `${String(result.calibrationError + '%').padEnd(6)} | ${String(result.adjustment + 'x').padEnd(10)} | ` +
      `${statusEmoji} ${result.status}`
    );
  });
  console.log('─'.repeat(100) + '\n');
  
  return binResults;
}

/**
 * Get calibration adjustment for a specific confidence value
 * @param {number} confidence - Raw confidence (0-100)
 * @param {string} category - Market category (optional)
 * @returns {Object} - Adjusted confidence and metadata
 */
async function getConfidenceAdjustment(confidence, category = null) {
  // Get bin calibration data
  const binData = await calculateConfidenceBinCalibration(category);
  
  // Find the appropriate bin
  const bin = binData.find(b => confidence >= b.minConfidence && confidence < b.maxConfidence);
  
  if (!bin) {
    console.log(`[CALIBRATION] No bin found for confidence ${confidence}%`);
    return {
      adjustedConfidence: confidence,
      adjustment: 1.0,
      samples: 0,
      message: 'No calibration data available'
    };
  }
  
  // Don't apply adjustment if insufficient data
  if (!bin.isReliable) {
    console.log(`[CALIBRATION] Insufficient data for ${bin.bin} (${bin.samples} samples < ${MIN_SAMPLES_PER_BIN} required)`);
    return {
      adjustedConfidence: confidence,
      adjustment: 1.0,
      samples: bin.samples,
      message: `Insufficient data (${bin.samples} samples)`
    };
  }
  
  // Apply adjustment
  const adjustedConfidence = Math.max(1, Math.min(100, confidence * bin.adjustment));
  
  console.log(
    `[CALIBRATION] ${confidence}% → ${adjustedConfidence.toFixed(1)}% ` +
    `(${bin.adjustment}x multiplier, ${bin.samples} samples, ${bin.actualWinRate}% actual win rate)`
  );
  
  return {
    adjustedConfidence: Number(adjustedConfidence.toFixed(1)),
    rawConfidence: confidence,
    adjustment: bin.adjustment,
    samples: bin.samples,
    binLabel: bin.bin,
    predictedWinRate: bin.predictedWinRate,
    actualWinRate: bin.actualWinRate,
    calibrationError: bin.calibrationError,
    status: bin.status,
    message: `Adjusted based on ${bin.samples} historical signals (${bin.actualWinRate}% actual vs ${bin.predictedWinRate}% predicted)`
  };
}

/**
 * Get category-specific calibration
 */
async function getCategoryCalibration(category) {
  console.log(`\n[CALIBRATION] Calculating category-specific calibration for ${category}...`);
  return await calculateConfidenceBinCalibration(category);
}

/**
 * Get overall calibration summary
 */
async function getCalibrationSummary() {
  const signals = await getResolvedSignals();
  
  if (signals.length === 0) {
    return {
      totalSignals: 0,
      resolvedSignals: 0,
      overallWinRate: 0,
      avgConfidence: 0,
      calibrationError: 0,
      message: 'No resolved signals available'
    };
  }
  
  const totalSignals = signals.length;
  const correctSignals = signals.filter(s => s.was_correct === 1).length;
  const overallWinRate = correctSignals / totalSignals;
  const avgConfidence = signals.reduce((sum, s) => sum + (s.confidence || 0), 0) / totalSignals / 100;
  const calibrationError = Math.abs(overallWinRate - avgConfidence);
  
  // Get bin calibration
  const binCalibration = await calculateConfidenceBinCalibration();
  
  // Calculate category breakdown
  const categoryMap = new Map();
  signals.forEach(s => {
    const cat = s.category || 'OTHER';
    if (!categoryMap.has(cat)) {
      categoryMap.set(cat, { total: 0, correct: 0, avgConf: 0 });
    }
    const stats = categoryMap.get(cat);
    stats.total++;
    if (s.was_correct === 1) stats.correct++;
    stats.avgConf += (s.confidence || 0);
  });
  
  const categoryBreakdown = Array.from(categoryMap.entries()).map(([cat, stats]) => ({
    category: cat,
    total: stats.total,
    winRate: Number((stats.correct / stats.total * 100).toFixed(1)),
    avgConfidence: Number((stats.avgConf / stats.total).toFixed(1)),
    calibrationError: Number((Math.abs((stats.correct / stats.total) - (stats.avgConf / stats.total / 100)) * 100).toFixed(1))
  })).sort((a, b) => b.total - a.total);
  
  return {
    totalSignals,
    resolvedSignals: totalSignals,
    overallWinRate: Number((overallWinRate * 100).toFixed(1)),
    avgConfidence: Number((avgConfidence * 100).toFixed(1)),
    calibrationError: Number((calibrationError * 100).toFixed(1)),
    binCalibration,
    categoryBreakdown,
    message: `Analyzed ${totalSignals} resolved signals`
  };
}

/**
 * Log calibration report to console
 */
async function logCalibrationReport() {
  console.log('\n' + '='.repeat(100));
  console.log('📊 HISTORICAL CALIBRATION REPORT');
  console.log('='.repeat(100));
  
  const summary = await getCalibrationSummary();
  
  console.log(`\n📈 Overall Performance:`);
  console.log(`   Total Resolved Signals: ${summary.totalSignals}`);
  console.log(`   Overall Win Rate: ${summary.overallWinRate}%`);
  console.log(`   Average Confidence: ${summary.avgConfidence}%`);
  console.log(`   Calibration Error: ${summary.calibrationError}%`);
  
  if (summary.calibrationError > 15) {
    console.log(`   ❌ POORLY CALIBRATED - Model is ${summary.avgConfidence > summary.overallWinRate ? 'overconfident' : 'underconfident'}`);
  } else if (summary.calibrationError > 10) {
    console.log(`   ⚠️ NEEDS IMPROVEMENT`);
  } else {
    console.log(`   ✅ WELL CALIBRATED`);
  }
  
  console.log(`\n📊 Category Breakdown:`);
  console.log('─'.repeat(80));
  console.log('Category          | Signals | Win Rate | Avg Conf | Cal Error | Status');
  console.log('─'.repeat(80));
  
  summary.categoryBreakdown.forEach(cat => {
    const status = cat.calibrationError > 15 ? '❌' : cat.calibrationError > 10 ? '⚠️' : '✅';
    console.log(
      `${cat.category.padEnd(17)} | ${String(cat.total).padEnd(7)} | ` +
      `${String(cat.winRate + '%').padEnd(8)} | ${String(cat.avgConfidence + '%').padEnd(8)} | ` +
      `${String(cat.calibrationError + '%').padEnd(9)} | ${status}`
    );
  });
  console.log('─'.repeat(80));
  
  console.log('\n' + '='.repeat(100) + '\n');
}

module.exports = {
  getResolvedSignals,
  calculateConfidenceBinCalibration,
  getConfidenceAdjustment,
  getCategoryCalibration,
  getCalibrationSummary,
  logCalibrationReport
};
