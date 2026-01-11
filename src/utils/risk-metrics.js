/**
 * Advanced Risk Metrics Module
 * Provides Sharpe Ratio, Sortino Ratio, Max Drawdown, VaR, and correlation calculations
 */

/**
 * Calculate Sharpe Ratio
 * Measures risk-adjusted return of an investment strategy
 * @param {Array<number>} returns - Array of periodic returns (e.g., daily, hourly)
 * @param {number} riskFreeRate - Annual risk-free rate (default 0.02 for 2%)
 * @param {number} periodsPerYear - Number of periods per year (252 for daily, 365 for hourly)
 * @returns {number} - Sharpe Ratio
 */
function calculateSharpeRatio(returns, riskFreeRate = 0.02, periodsPerYear = 252) {
  if (!Array.isArray(returns) || returns.length < 2) {
    return 0;
  }

  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  
  if (stdDev === 0) return 0;

  // Annualize returns and standard deviation
  const annualizedReturn = avgReturn * periodsPerYear;
  const annualizedStdDev = stdDev * Math.sqrt(periodsPerYear);
  
  const excessReturn = annualizedReturn - riskFreeRate;
  
  return excessReturn / annualizedStdDev;
}

/**
 * Calculate Sortino Ratio
 * Similar to Sharpe but only considers downside deviation
 * @param {Array<number>} returns - Array of periodic returns
 * @param {number} riskFreeRate - Annual risk-free rate (default 0.02)
 * @param {number} periodsPerYear - Number of periods per year
 * @returns {number} - Sortino Ratio
 */
function calculateSortinoRatio(returns, riskFreeRate = 0.02, periodsPerYear = 252) {
  if (!Array.isArray(returns) || returns.length < 2) {
    return 0;
  }

  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const minAcceptableReturn = riskFreeRate / periodsPerYear;
  
  // Calculate downside deviation (only returns below minimum acceptable return)
  const downsideReturns = returns.filter(r => r < minAcceptableReturn);
  const downsideVariance = downsideReturns.length > 0
    ? downsideReturns.reduce((sum, r) => sum + Math.pow(r - minAcceptableReturn, 2), 0) / downsideReturns.length
    : 0;
  const downsideDeviation = Math.sqrt(downsideVariance);
  
  if (downsideDeviation === 0) return 0;

  const annualizedReturn = avgReturn * periodsPerYear;
  const annualizedDownsideDev = downsideDeviation * Math.sqrt(periodsPerYear);
  
  const excessReturn = annualizedReturn - riskFreeRate;
  
  return excessReturn / annualizedDownsideDev;
}

/**
 * Calculate Maximum Drawdown
 * Maximum peak-to-trough decline in portfolio value
 * @param {Array<number>} values - Array of portfolio values or equity curve
 * @returns {Object} - Object with maxDrawdown, drawdownDuration, and recoveryDuration
 */
function calculateMaxDrawdown(values) {
  if (!Array.isArray(values) || values.length < 2) {
    return { maxDrawdown: 0, drawdownDuration: 0, recoveryDuration: 0, peakIndex: 0, troughIndex: 0 };
  }

  let peak = values[0];
  let maxDrawdown = 0;
  let drawdownDuration = 0;
  let recoveryDuration = 0;
  let peakIndex = 0;
  let troughIndex = 0;
  let currentDrawdownDuration = 0;
  let inDrawdown = false;

  for (let i = 1; i < values.length; i++) {
    const value = values[i];
    
    if (value > peak) {
      // New peak, reset drawdown
      peak = value;
      peakIndex = i;
      inDrawdown = false;
      currentDrawdownDuration = 0;
    } else {
      // Calculate current drawdown
      const drawdown = (peak - value) / peak;
      
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        troughIndex = i;
        drawdownDuration = currentDrawdownDuration;
      }
      
      inDrawdown = true;
      currentDrawdownDuration++;
      
      // Calculate recovery duration (from trough to new peak)
      if (i > troughIndex && value >= peak) {
        recoveryDuration = i - troughIndex;
      }
    }
  }

  return {
    maxDrawdown: maxDrawdown * 100, // Convert to percentage
    drawdownDuration,
    recoveryDuration,
    peakIndex,
    troughIndex
  };
}

/**
 * Calculate Value at Risk (VaR)
 * Maximum expected loss at a given confidence level
 * @param {Array<number>} returns - Array of periodic returns
 * @param {number} confidenceLevel - Confidence level (default 0.95 for 95%)
 * @param {number} portfolioValue - Current portfolio value (default 1)
 * @returns {Object} - Object with VaR amount, percentage, and method used
 */
function calculateVaR(returns, confidenceLevel = 0.95, portfolioValue = 1) {
  if (!Array.isArray(returns) || returns.length < 10) {
    return { varAmount: 0, varPercentage: 0, method: 'insufficient_data' };
  }

  // Sort returns in ascending order
  const sortedReturns = [...returns].sort((a, b) => a - b);
  
  // Calculate percentile index
  const index = Math.floor((1 - confidenceLevel) * sortedReturns.length);
  const varReturn = sortedReturns[index];
  
  const varAmount = portfolioValue * Math.abs(varReturn);
  const varPercentage = Math.abs(varReturn) * 100;

  return {
    varAmount,
    varPercentage,
    method: 'historical',
    confidenceLevel,
    observations: returns.length
  };
}

/**
 * Calculate Conditional Value at Risk (CVaR) / Expected Shortfall
 * Average loss beyond VaR
 * @param {Array<number>} returns - Array of periodic returns
 * @param {number} confidenceLevel - Confidence level (default 0.95)
 * @param {number} portfolioValue - Current portfolio value (default 1)
 * @returns {Object} - Object with CVaR amount and percentage
 */
function calculateCVaR(returns, confidenceLevel = 0.95, portfolioValue = 1) {
  if (!Array.isArray(returns) || returns.length < 10) {
    return { cvarAmount: 0, cvarPercentage: 0, method: 'insufficient_data' };
  }

  const sortedReturns = [...returns].sort((a, b) => a - b);
  const index = Math.floor((1 - confidenceLevel) * sortedReturns.length);
  
  // Average of returns below VaR
  const tailReturns = sortedReturns.slice(0, index + 1);
  const avgTailReturn = tailReturns.reduce((sum, r) => sum + r, 0) / tailReturns.length;
  
  const cvarAmount = portfolioValue * Math.abs(avgTailReturn);
  const cvarPercentage = Math.abs(avgTailReturn) * 100;

  return {
    cvarAmount,
    cvarPercentage,
    method: 'historical',
    confidenceLevel,
    tailObservations: tailReturns.length
  };
}

/**
 * Calculate correlation matrix for multiple assets
 * @param {Array<Object>} data - Array of objects with asset returns
 * @param {string} valueKey - Key to extract returns from each object
 * @returns {Object} - Correlation matrix as object
 */
function calculateCorrelationMatrix(data, valueKey = 'returns') {
  if (!Array.isArray(data) || data.length < 2) {
    return {};
  }

  const assets = Object.keys(data[0]);
  const matrix = {};

  // Calculate mean for each asset
  const means = {};
  for (const asset of assets) {
    means[asset] = data.reduce((sum, d) => sum + d[valueKey][asset], 0) / data.length;
  }

  // Calculate covariance and standard deviation
  const stdDevs = {};
  const covariances = {};

  for (const asset1 of assets) {
    stdDevs[asset1] = Math.sqrt(
      data.reduce((sum, d) => sum + Math.pow(d[valueKey][asset1] - means[asset1], 2), 0) / data.length
    );
    covariances[asset1] = {};
  }

  for (const asset1 of assets) {
    for (const asset2 of assets) {
      const covariance = data.reduce((sum, d) => {
        return sum + (d[valueKey][asset1] - means[asset1]) * (d[valueKey][asset2] - means[asset2]);
      }, 0) / data.length;
      covariances[asset1][asset2] = covariance;
    }
  }

  // Calculate correlation matrix
  for (const asset1 of assets) {
    matrix[asset1] = {};
    for (const asset2 of assets) {
      const correlation = stdDevs[asset1] * stdDevs[asset2] > 0
        ? covariances[asset1][asset2] / (stdDevs[asset1] * stdDevs[asset2])
        : 0;
      matrix[asset1][asset2] = Math.max(-1, Math.min(1, correlation)); // Clamp to [-1, 1]
    }
  }

  return matrix;
}

/**
 * Calculate beta of an asset against a benchmark
 * @param {Array<number>} assetReturns - Returns of the asset
 * @param {Array<number>} benchmarkReturns - Returns of the benchmark
 * @returns {number} - Beta value
 */
function calculateBeta(assetReturns, benchmarkReturns) {
  if (!Array.isArray(assetReturns) || !Array.isArray(benchmarkReturns) || 
      assetReturns.length !== benchmarkReturns.length || assetReturns.length < 2) {
    return 0;
  }

  const n = assetReturns.length;
  const meanAsset = assetReturns.reduce((sum, r) => sum + r, 0) / n;
  const meanBenchmark = benchmarkReturns.reduce((sum, r) => sum + r, 0) / n;

  let covariance = 0;
  let benchmarkVariance = 0;

  for (let i = 0; i < n; i++) {
    covariance += (assetReturns[i] - meanAsset) * (benchmarkReturns[i] - meanBenchmark);
    benchmarkVariance += Math.pow(benchmarkReturns[i] - meanBenchmark, 2);
  }

  covariance /= n;
  benchmarkVariance /= n;

  return benchmarkVariance > 0 ? covariance / benchmarkVariance : 0;
}

/**
 * Calculate Information Ratio
 * Measures active return per unit of active risk
 * @param {Array<number>} activeReturns - Returns of the strategy
 * @param {Array<number>} benchmarkReturns - Returns of the benchmark
 * @param {number} periodsPerYear - Number of periods per year
 * @returns {number} - Information Ratio
 */
function calculateInformationRatio(activeReturns, benchmarkReturns, periodsPerYear = 252) {
  if (!Array.isArray(activeReturns) || !Array.isArray(benchmarkReturns) || 
      activeReturns.length !== benchmarkReturns.length || activeReturns.length < 2) {
    return 0;
  }

  const n = activeReturns.length;
  const excessReturns = activeReturns.map((r, i) => r - benchmarkReturns[i]);
  
  const avgExcessReturn = excessReturns.reduce((sum, r) => sum + r, 0) / n;
  const trackingError = Math.sqrt(
    excessReturns.reduce((sum, r) => sum + Math.pow(r - avgExcessReturn, 2), 0) / n
  );

  if (trackingError === 0) return 0;

  const annualizedExcessReturn = avgExcessReturn * periodsPerYear;
  const annualizedTrackingError = trackingError * Math.sqrt(periodsPerYear);

  return annualizedExcessReturn / annualizedTrackingError;
}

/**
 * Ensemble model averaging
 * Combines multiple probability estimates with weights
 * @param {Array<Object>} models - Array of model predictions with probability and weight
 * @returns {Object} - Ensemble prediction with weighted probability and confidence
 */
function ensembleAverage(models) {
  if (!Array.isArray(models) || models.length === 0) {
    return { probability: 0.5, confidence: 0, method: 'no_models' };
  }

  // Normalize weights
  const totalWeight = models.reduce((sum, m) => sum + (m.weight || 1), 0);
  const normalizedModels = models.map(m => ({
    ...m,
    weight: (m.weight || 1) / totalWeight
  }));

  // Calculate weighted probability
  const weightedProbability = normalizedModels.reduce((sum, m) => {
    return sum + (m.probability || 0.5) * m.weight;
  }, 0);

  // Calculate weighted confidence
  const weightedConfidence = normalizedModels.reduce((sum, m) => {
    return sum + (m.confidence || 0.5) * m.weight;
  }, 0);

  // Calculate disagreement (inverse of confidence)
  const probabilities = normalizedModels.map(m => m.probability || 0.5);
  const avgProbability = probabilities.reduce((sum, p) => sum + p, 0) / probabilities.length;
  const disagreement = Math.sqrt(
    probabilities.reduce((sum, p) => sum + Math.pow(p - avgProbability, 2), 0) / probabilities.length
  );

  // Adjust confidence based on disagreement
  const adjustedConfidence = weightedConfidence * (1 - Math.min(disagreement, 0.5));

  return {
    probability: weightedProbability,
    confidence: Math.max(0, Math.min(1, adjustedConfidence)),
    disagreement,
    modelCount: models.length,
    method: 'weighted_average'
  };
}

/**
 * Calculate Calmar Ratio
 * Annual return divided by maximum drawdown
 * @param {Array<number>} returns - Array of periodic returns
 * @param {Array<number>} values - Array of portfolio values
 * @param {number} periodsPerYear - Number of periods per year
 * @returns {number} - Calmar Ratio
 */
function calculateCalmarRatio(returns, values, periodsPerYear = 252) {
  if (!Array.isArray(returns) || !Array.isArray(values) || returns.length < 2) {
    return 0;
  }

  const { maxDrawdown } = calculateMaxDrawdown(values);
  
  if (maxDrawdown === 0) return 0;

  const totalReturn = (values[values.length - 1] - values[0]) / values[0];
  const annualizedReturn = totalReturn * (periodsPerYear / returns.length);

  return annualizedReturn / maxDrawdown;
}

module.exports = {
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateMaxDrawdown,
  calculateVaR,
  calculateCVaR,
  calculateCorrelationMatrix,
  calculateBeta,
  calculateInformationRatio,
  ensembleAverage,
  calculateCalmarRatio
};
