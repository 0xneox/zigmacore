/**
 * Analytics Module
 * Provides accuracy metrics, win/loss tracking, confidence calibration, category performance, and time-of-day analysis
 */

/**
 * Calculate accuracy metrics from signal history
 * @param {Array<Object>} signals - Array of signal objects with outcome and prediction
 * @returns {Object} - Accuracy metrics
 */
function calculateAccuracyMetrics(signals) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return {
      totalSignals: 0,
      correctSignals: 0,
      incorrectSignals: 0,
      accuracy: 0,
      precision: 0,
      recall: 0,
      f1Score: 0
    };
  }

  const resolvedSignals = signals.filter(s => s.outcome !== undefined && s.outcome !== null);
  const totalResolved = resolvedSignals.length;
  
  if (totalResolved === 0) {
    return {
      totalSignals: signals.length,
      correctSignals: 0,
      incorrectSignals: 0,
      accuracy: 0,
      precision: 0,
      recall: 0,
      f1Score: 0,
      message: 'No resolved signals yet'
    };
  }

  const correctSignals = resolvedSignals.filter(s => {
    const predictedYes = s.predictedProbability > 0.5;
    const actualYes = s.outcome === 'YES';
    return predictedYes === actualYes;
  }).length;

  const incorrectSignals = totalResolved - correctSignals;
  const accuracy = correctSignals / totalResolved;

  // Calculate precision (correct YES predictions / all YES predictions)
  const yesPredictions = signals.filter(s => s.predictedProbability > 0.5);
  const correctYesPredictions = yesPredictions.filter(s => s.outcome === 'YES').length;
  const precision = yesPredictions.length > 0 ? correctYesPredictions / yesPredictions.length : 0;

  // Calculate recall (correct YES predictions / all actual YES)
  const actualYes = signals.filter(s => s.outcome === 'YES');
  const recall = actualYes.length > 0 ? correctYesPredictions / actualYes.length : 0;

  // Calculate F1 score
  const f1Score = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    totalSignals: signals.length,
    resolvedSignals: totalResolved,
    correctSignals,
    incorrectSignals,
    accuracy: Number(accuracy.toFixed(4)),
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1Score: Number(f1Score.toFixed(4))
  };
}

/**
 * Calculate win/loss ratio from trade history
 * @param {Array<Object>} trades - Array of trade objects with pnl
 * @returns {Object} - Win/loss metrics
 */
function calculateWinLossRatio(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      winLossRatio: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0
    };
  }

  const winningTrades = trades.filter(t => t.pnl > 0);
  const losingTrades = trades.filter(t => t.pnl < 0);
  const totalWins = winningTrades.length;
  const totalLosses = losingTrades.length;
  const totalTrades = trades.length;

  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
  const winLossRatio = totalLosses > 0 ? totalWins / totalLosses : totalWins;

  const avgWin = totalWins > 0 
    ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / totalWins 
    : 0;
  const avgLoss = totalLosses > 0 
    ? losingTrades.reduce((sum, t) => sum + Math.abs(t.pnl), 0) / totalLosses 
    : 0;

  const totalProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
  const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

  return {
    totalTrades,
    winningTrades: totalWins,
    losingTrades: totalLosses,
    winRate: Number(winRate.toFixed(4)),
    winLossRatio: Number(winLossRatio.toFixed(2)),
    avgWin: Number(avgWin.toFixed(2)),
    avgLoss: Number(avgLoss.toFixed(2)),
    totalProfit: Number(totalProfit.toFixed(2)),
    totalLoss: Number(totalLoss.toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2))
  };
}

/**
 * Calculate confidence calibration
 * Measures how well predicted confidence matches actual accuracy
 * @param {Array<Object>} signals - Array of signal objects with confidence and outcome
 * @returns {Object} - Calibration metrics
 */
function calculateConfidenceCalibration(signals) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return {
      totalSignals: 0,
      avgPredictedConfidence: 0,
      avgActualAccuracy: 0,
      calibrationError: 0,
      reliabilityDiagram: []
    };
  }

  const resolvedSignals = signals.filter(s => s.outcome !== undefined && s.outcome !== null);
  
  if (resolvedSignals.length === 0) {
    return {
      totalSignals: signals.length,
      avgPredictedConfidence: 0,
      avgActualAccuracy: 0,
      calibrationError: 0,
      message: 'No resolved signals yet'
    };
  }

  // Create confidence bins
  const bins = [
    { min: 0, max: 10, predicted: 0, correct: 0 },
    { min: 10, max: 20, predicted: 0, correct: 0 },
    { min: 20, max: 30, predicted: 0, correct: 0 },
    { min: 30, max: 40, predicted: 0, correct: 0 },
    { min: 40, max: 50, predicted: 0, correct: 0 },
    { min: 50, max: 60, predicted: 0, correct: 0 },
    { min: 60, max: 70, predicted: 0, correct: 0 },
    { min: 70, max: 80, predicted: 0, correct: 0 },
    { min: 80, max: 90, predicted: 0, correct: 0 },
    { min: 90, max: 100, predicted: 0, correct: 0 }
  ];

  // Bin the signals
  resolvedSignals.forEach(signal => {
    const confidence = signal.confidence || 0;
    const binIndex = Math.min(Math.floor(confidence / 10), 9);
    bins[binIndex].predicted++;
    
    const predictedYes = signal.predictedProbability > 0.5;
    const actualYes = signal.outcome === 'YES';
    if (predictedYes === actualYes) {
      bins[binIndex].correct++;
    }
  });

  // Calculate calibration for each bin
  const reliabilityDiagram = bins.map(bin => {
    const actualAccuracy = bin.predicted > 0 ? bin.correct / bin.predicted : 0;
    const predictedAccuracy = (bin.min + bin.max) / 2 / 100;
    return {
      confidenceRange: `${bin.min}-${bin.max}%`,
      predictedAccuracy: Number(predictedAccuracy.toFixed(2)),
      actualAccuracy: Number(actualAccuracy.toFixed(2)),
      sampleSize: bin.predicted,
      calibrationError: Number(Math.abs(predictedAccuracy - actualAccuracy).toFixed(2))
    };
  });

  // Calculate overall calibration error
  const validBins = reliabilityDiagram.filter(bin => bin.sampleSize > 0);
  const calibrationError = validBins.length > 0
    ? validBins.reduce((sum, bin) => sum + bin.calibrationError, 0) / validBins.length
    : 0;

  // Calculate average predicted confidence
  const avgPredictedConfidence = signals.reduce((sum, s) => sum + (s.confidence || 0), 0) / signals.length;

  // Calculate average actual accuracy
  const avgActualAccuracy = resolvedSignals.reduce((sum, s) => {
    const predictedYes = s.predictedProbability > 0.5;
    const actualYes = s.outcome === 'YES';
    return sum + (predictedYes === actualYes ? 1 : 0);
  }, 0) / resolvedSignals.length;

  return {
    totalSignals: signals.length,
    resolvedSignals: resolvedSignals.length,
    avgPredictedConfidence: Number(avgPredictedConfidence.toFixed(2)),
    avgActualAccuracy: Number(avgActualAccuracy.toFixed(4)),
    calibrationError: Number(calibrationError.toFixed(4)),
    reliabilityDiagram
  };
}

/**
 * Calculate category performance
 * Analyzes performance by market category
 * @param {Array<Object>} signals - Array of signal objects with category and outcome
 * @returns {Object} - Category performance metrics
 */
function calculateCategoryPerformance(signals) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return {
      categories: {},
      bestCategory: null,
      worstCategory: null
    };
  }

  const categoryStats = {};

  signals.forEach(signal => {
    const category = signal.category || 'UNKNOWN';
    if (!categoryStats[category]) {
      categoryStats[category] = {
        totalSignals: 0,
        resolvedSignals: 0,
        correctSignals: 0,
        totalEdge: 0,
        avgConfidence: 0
      };
    }

    categoryStats[category].totalSignals++;
    categoryStats[category].totalEdge += signal.edge || 0;
    categoryStats[category].avgConfidence += signal.confidence || 0;

    if (signal.outcome !== undefined && signal.outcome !== null) {
      categoryStats[category].resolvedSignals++;
      const predictedYes = signal.predictedProbability > 0.5;
      const actualYes = signal.outcome === 'YES';
      if (predictedYes === actualYes) {
        categoryStats[category].correctSignals++;
      }
    }
  });

  // Calculate derived metrics
  Object.keys(categoryStats).forEach(category => {
    const stats = categoryStats[category];
    stats.accuracy = stats.resolvedSignals > 0 ? stats.correctSignals / stats.resolvedSignals : 0;
    stats.avgEdge = stats.totalSignals > 0 ? stats.totalEdge / stats.totalSignals : 0;
    stats.avgConfidence = stats.totalSignals > 0 ? stats.avgConfidence / stats.totalSignals : 0;
  });

  // Find best and worst categories
  const categoriesWithAccuracy = Object.entries(categoryStats)
    .filter(([_, stats]) => stats.resolvedSignals > 0)
    .map(([category, stats]) => ({ category, ...stats }));

  const bestCategory = categoriesWithAccuracy.length > 0
    ? categoriesWithAccuracy.reduce((best, current) => 
        current.accuracy > best.accuracy ? current : best
      )
    : null;

  const worstCategory = categoriesWithAccuracy.length > 0
    ? categoriesWithAccuracy.reduce((worst, current) => 
        current.accuracy < worst.accuracy ? current : worst
      )
    : null;

  return {
    categories: categoryStats,
    bestCategory: bestCategory ? { category: bestCategory.category, accuracy: bestCategory.accuracy } : null,
    worstCategory: worstCategory ? { category: worstCategory.category, accuracy: worstCategory.accuracy } : null
  };
}

/**
 * Calculate time-of-day analysis
 * Analyzes performance by hour of day
 * @param {Array<Object>} signals - Array of signal objects with timestamp and outcome
 * @returns {Object} - Time-of-day metrics
 */
function calculateTimeOfDayAnalysis(signals) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return {
      hours: {},
      bestHour: null,
      worstHour: null
    };
  }

  const hourStats = {};

  signals.forEach(signal => {
    const timestamp = signal.timestamp || Date.now();
    const hour = new Date(timestamp).getHours();
    
    if (!hourStats[hour]) {
      hourStats[hour] = {
        totalSignals: 0,
        resolvedSignals: 0,
        correctSignals: 0,
        totalEdge: 0
      };
    }

    hourStats[hour].totalSignals++;
    hourStats[hour].totalEdge += signal.edge || 0;

    if (signal.outcome !== undefined && signal.outcome !== null) {
      hourStats[hour].resolvedSignals++;
      const predictedYes = signal.predictedProbability > 0.5;
      const actualYes = signal.outcome === 'YES';
      if (predictedYes === actualYes) {
        hourStats[hour].correctSignals++;
      }
    }
  });

  // Calculate derived metrics
  Object.keys(hourStats).forEach(hour => {
    const stats = hourStats[hour];
    stats.accuracy = stats.resolvedSignals > 0 ? stats.correctSignals / stats.resolvedSignals : 0;
    stats.avgEdge = stats.totalSignals > 0 ? stats.totalEdge / stats.totalSignals : 0;
  });

  // Find best and worst hours
  const hoursWithAccuracy = Object.entries(hourStats)
    .filter(([_, stats]) => stats.resolvedSignals > 0)
    .map(([hour, stats]) => ({ hour: parseInt(hour), ...stats }));

  const bestHour = hoursWithAccuracy.length > 0
    ? hoursWithAccuracy.reduce((best, current) => 
        current.accuracy > best.accuracy ? current : best
      )
    : null;

  const worstHour = hoursWithAccuracy.length > 0
    ? hoursWithAccuracy.reduce((worst, current) => 
        current.accuracy < worst.accuracy ? current : worst
      )
    : null;

  return {
    hours: hourStats,
    bestHour: bestHour ? { hour: bestHour.hour, accuracy: bestHour.accuracy } : null,
    worstHour: worstHour ? { hour: worstHour.hour, accuracy: worstHour.accuracy } : null
  };
}

/**
 * Generate comprehensive analytics report
 * @param {Object} data - Object containing signals, trades, etc.
 * @returns {Object} - Complete analytics report
 */
function generateAnalyticsReport(data) {
  const { signals = [], trades = [] } = data;

  return {
    accuracy: calculateAccuracyMetrics(signals),
    winLoss: calculateWinLossRatio(trades),
    calibration: calculateConfidenceCalibration(signals),
    categoryPerformance: calculateCategoryPerformance(signals),
    timeOfDay: calculateTimeOfDayAnalysis(signals),
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  calculateAccuracyMetrics,
  calculateWinLossRatio,
  calculateConfidenceCalibration,
  calculateCategoryPerformance,
  calculateTimeOfDayAnalysis,
  generateAnalyticsReport
};
