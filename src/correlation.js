/**
 * Market Correlation Matrix Module
 * Analyzes correlations between markets for risk assessment
 */

// Constants for correlation calculations
const CORRELATION_THRESHOLD = 0.7; // Threshold for high correlation
const MIN_PRICE_HISTORY = 2; // Minimum data points for correlation
const MAX_MARKETS_FOR_FULL_MATRIX = 100; // Limit to prevent performance issues

// Cache for correlation calculations to avoid redundant computations
const correlationCache = new Map();

function getCacheKey(idA, idB) {
  return [idA, idB].sort().join('|');
}

/**
 * Calculate price correlation between two markets
 * @param {Array} pricesA - Price history for market A
 * @param {Array} pricesB - Price history for market B
 * @returns {number} - Correlation coefficient (-1 to 1)
 */
function calculateCorrelation(pricesA, pricesB) {
  if (!pricesA || !pricesB || pricesA.length < MIN_PRICE_HISTORY || pricesB.length < MIN_PRICE_HISTORY) {
    return 0;
  }

  // Align prices by timestamp and filter invalid values
  const minLen = Math.min(pricesA.length, pricesB.length);
  const alignedA = pricesA.slice(0, minLen)
    .map(p => p.price)
    .filter(p => typeof p === 'number' && Number.isFinite(p));
  const alignedB = pricesB.slice(0, minLen)
    .map(p => p.price)
    .filter(p => typeof p === 'number' && Number.isFinite(p));

  // Check if we have enough valid data points
  if (alignedA.length < MIN_PRICE_HISTORY || alignedB.length < MIN_PRICE_HISTORY) {
    return 0;
  }

  // Calculate means
  const meanA = alignedA.reduce((sum, p) => sum + p, 0) / alignedA.length;
  const meanB = alignedB.reduce((sum, p) => sum + p, 0) / alignedB.length;

  // Calculate covariance and standard deviations
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;

  for (let i = 0; i < alignedA.length; i++) {
    const diffA = alignedA[i] - meanA;
    const diffB = alignedB[i] - meanB;
    covariance += diffA * diffB;
    varianceA += diffA * diffA;
    varianceB += diffB * diffB;
  }

  covariance /= alignedA.length;
  varianceA /= alignedA.length;
  varianceB /= alignedB.length;

  // Avoid division by zero
  if (varianceA === 0 || varianceB === 0) {
    return 0;
  }

  const correlation = covariance / Math.sqrt(varianceA * varianceB);
  
  // Clamp to [-1, 1]
  return Math.max(-1, Math.min(1, correlation));
}

/**
 * Build correlation matrix for a set of markets
 * @param {Array} markets - Array of markets with price history
 * @returns {Object} - Correlation matrix
 */
async function buildCorrelationMatrix(markets) {
  if (!markets || markets.length < 2) {
    return {
      matrix: {},
      clusters: [],
      highCorrelations: []
    };
  }

  // Limit markets to prevent performance issues
  const limitedMarkets = markets.slice(0, MAX_MARKETS_FOR_FULL_MATRIX);
  const matrix = {};
  const n = limitedMarkets.length;

  // Clear cache for new calculation
  correlationCache.clear();

  // Calculate pairwise correlations with caching
  for (let i = 0; i < n; i++) {
    const marketA = limitedMarkets[i];
    matrix[marketA.id] = {};

    for (let j = i + 1; j < n; j++) {
      const marketB = limitedMarkets[j];
      
      // Check cache first
      const cacheKey = getCacheKey(marketA.id, marketB.id);
      let correlation = correlationCache.get(cacheKey);
      
      if (correlation === undefined) {
        correlation = calculateCorrelation(
          marketA.priceHistory || [],
          marketB.priceHistory || []
        );
        correlationCache.set(cacheKey, correlation);
      }
      
      matrix[marketA.id][marketB.id] = correlation;
      if (!matrix[marketB.id]) {
        matrix[marketB.id] = {};
      }
      matrix[marketB.id][marketA.id] = correlation;
    }
  }

  // Find high correlations (|correlation| > CORRELATION_THRESHOLD)
  const highCorrelations = [];
  const seen = new Set();

  Object.entries(matrix).forEach(([idA, correlations]) => {
    Object.entries(correlations).forEach(([idB, corr]) => {
      const key = [idA, idB].sort().join('-');
      if (seen.has(key)) return;
      seen.add(key);

      if (Math.abs(corr) > CORRELATION_THRESHOLD) {
        highCorrelations.push({
          marketA: idA,
          marketB: idB,
          correlation: corr,
          type: corr > 0 ? 'positive' : 'negative'
        });
      }
    });
  });

  // Cluster markets by correlation using BFS
  const clusters = findCorrelationClusters(limitedMarkets, matrix);

  return {
    matrix,
    clusters,
    highCorrelations,
    generatedAt: Date.now()
  };
}

/**
 * Find clusters of highly correlated markets
 * @param {Array} markets - Markets to cluster
 * @param {Object} matrix - Correlation matrix
 * @returns {Array} - Array of clusters
 */
function findCorrelationClusters(markets, matrix) {
  const clusters = [];
  const visited = new Set();

  // Use BFS to find transitive correlation clusters
  for (const market of markets) {
    if (visited.has(market.id)) continue;

    const cluster = [];
    const queue = [market.id];
    visited.add(market.id);

    // BFS to find all transitively correlated markets
    while (queue.length > 0) {
      const currentId = queue.shift();
      cluster.push(currentId);

      // Find all markets highly correlated with current market
      const correlations = matrix[currentId] || {};
      for (const [otherId, corr] of Object.entries(correlations)) {
        if (!visited.has(otherId) && Math.abs(corr) > CORRELATION_THRESHOLD) {
          visited.add(otherId);
          queue.push(otherId);
        }
      }
    }

    if (cluster.length > 1) {
      clusters.push({
        markets: cluster,
        avgCorrelation: calculateClusterAvgCorrelation(cluster, matrix)
      });
    }
  }

  return clusters.sort((a, b) => b.avgCorrelation - a.avgCorrelation);
}

/**
 * Calculate average correlation within a cluster
 * @param {Array} cluster - Array of market IDs
 * @param {Object} matrix - Correlation matrix
 * @returns {number} - Average correlation
 */
function calculateClusterAvgCorrelation(cluster, matrix) {
  let sum = 0;
  let count = 0;

  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      const corr = matrix[cluster[i]]?.[cluster[j]] || 0;
      sum += Math.abs(corr);
      count++;
    }
  }

  return count > 0 ? sum / count : 0;
}

/**
 * Assess concentration risk based on correlation matrix
 * @param {Object} correlationData - Correlation matrix data
 * @param {Array} positions - User's positions
 * @returns {Object} - Risk assessment
 */
function assessConcentrationRisk(correlationData, positions) {
  if (!positions || positions.length === 0) {
    return {
      riskLevel: 'LOW',
      score: 0,
      insights: []
    };
  }

  const positionIds = positions.map(p => p.conditionId || p.asset);
  const { matrix, highCorrelations, clusters } = correlationData;

  // Check if user has positions in highly correlated markets
  let correlatedPositions = 0;
  const correlatedPairs = [];

  highCorrelations.forEach(({ marketA, marketB, correlation }) => {
    if (positionIds.includes(marketA) && positionIds.includes(marketB)) {
      correlatedPositions++;
      correlatedPairs.push({ marketA, marketB, correlation });
    }
  });

  // Calculate risk score
  const correlationRiskScore = correlatedPairs.length / Math.max(1, positionIds.length);
  const clusterRiskScore = clusters.reduce((max, cluster) => {
    const overlap = cluster.markets.filter(id => positionIds.includes(id)).length;
    return Math.max(max, overlap / cluster.markets.length);
  }, 0);

  const overallRiskScore = (correlationRiskScore * 0.6) + (clusterRiskScore * 0.4);

  // Determine risk level
  let riskLevel = 'LOW';
  if (overallRiskScore > 0.6) riskLevel = 'HIGH';
  else if (overallRiskScore > 0.3) riskLevel = 'MEDIUM';

  // Generate insights
  const insights = [];
  if (correlatedPairs.length > 0) {
    insights.push({
      type: 'warning',
      title: 'High Correlation Detected',
      description: `${correlatedPairs.length} pairs of your positions show >70% correlation`
    });
  }

  if (clusterRiskScore > 0.5) {
    insights.push({
      type: 'warning',
      title: 'Cluster Exposure',
      description: `You have significant exposure to correlated market clusters`
    });
  }

  return {
    riskLevel,
    score: overallRiskScore,
    correlatedPairs,
    insights
  };
}

/**
 * Get diversification recommendations based on correlation
 * @param {Object} correlationData - Correlation matrix data
 * @param {Array} positions - User's positions
 * @returns {Array} - Recommendations
 */
function getDiversificationRecommendations(correlationData, positions) {
  const recommendations = [];
  const positionIds = positions.map(p => p.conditionId || p.asset);
  const { matrix, highCorrelations } = correlationData;

  // Find correlated positions to consider reducing
  highCorrelations.forEach(({ marketA, marketB, correlation }) => {
    if (positionIds.includes(marketA) && positionIds.includes(marketB)) {
      const posA = positions.find(p => (p.conditionId || p.asset) === marketA);
      const posB = positions.find(p => (p.conditionId || p.asset) === marketB);

      if (posA && posB) {
        const totalExposure = (posA.cashPnl || 0) + (posB.cashPnl || 0);
        
        if (totalExposure > 0) {
          recommendations.push({
            type: correlation > 0 ? 'positive_correlation' : 'negative_correlation',
            priority: totalExposure > 100 ? 'high' : 'medium',
            title: correlation > 0 ? 'Reduce Positive Correlation' : 'Reduce Negative Correlation',
            description: `Consider reducing exposure to correlated markets: ${posA.title.slice(0, 30)}... and ${posB.title.slice(0, 30)}... (${(correlation * 100).toFixed(0)}% correlation)`,
            markets: [marketA, marketB]
          });
        }
      }
    }
  });

  return recommendations.slice(0, 5); // Top 5 recommendations
}

module.exports = {
  calculateCorrelation,
  buildCorrelationMatrix,
  findCorrelationClusters,
  assessConcentrationRisk,
  getDiversificationRecommendations
};
