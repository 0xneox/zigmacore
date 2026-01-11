/**
 * Enhanced Entropy Calculation Module
 * Calculates market uncertainty using multiple factors
 */

/**
 * Calculate Shannon entropy from probability distribution
 * @param {Array<number>} probabilities - Array of probabilities
 * @returns {number} - Entropy value (0-1)
 */
function calculateShannonEntropy(probabilities) {
  if (!Array.isArray(probabilities) || probabilities.length === 0) return 0;
  
  // Normalize probabilities to sum to 1
  const sum = probabilities.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  
  const normalized = probabilities.map(p => p / sum);
  
  let entropy = 0;
  for (const p of normalized) {
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }
  
  // Normalize to 0-1 range (max entropy for n outcomes is log2(n))
  const maxEntropy = Math.log2(probabilities.length);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

/**
 * Calculate price volatility entropy
 * @param {Array<number>} priceHistory - Array of historical prices
 * @returns {number} - Volatility entropy (0-1)
 */
function calculateVolatilityEntropy(priceHistory) {
  if (!Array.isArray(priceHistory) || priceHistory.length < 2) return 0;
  
  // Calculate returns
  const returns = [];
  for (let i = 1; i < priceHistory.length; i++) {
    const ret = (priceHistory[i] - priceHistory[i-1]) / priceHistory[i-1];
    returns.push(ret);
  }
  
  if (returns.length === 0) return 0;
  
  // Calculate standard deviation of returns
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  
  // Normalize to 0-1 (assuming max reasonable stdDev is 0.1)
  return Math.min(1, stdDev / 0.1);
}

/**
 * Calculate volume distribution entropy
 * @param {Array<number>} volumeHistory - Array of historical volumes
 * @returns {number} - Volume entropy (0-1)
 */
function calculateVolumeEntropy(volumeHistory) {
  if (!Array.isArray(volumeHistory) || volumeHistory.length < 2) return 0;
  
  // Calculate volume changes
  const changes = [];
  for (let i = 1; i < volumeHistory.length; i++) {
    const change = Math.abs((volumeHistory[i] - volumeHistory[i-1]) / volumeHistory[i-1]);
    changes.push(change);
  }
  
  if (changes.length === 0) return 0;
  
  const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
  
  // Normalize to 0-1 (assuming max reasonable change is 100%)
  return Math.min(1, avgChange);
}

/**
 * Calculate order book entropy (spread-based)
 * @param {Object} orderBook - Order book with bids and asks
 * @returns {number} - Order book entropy (0-1)
 */
function calculateOrderBookEntropy(orderBook) {
  if (!orderBook || !Array.isArray(orderBook.bids) || !Array.isArray(orderBook.asks)) return 0;
  
  const bestBid = orderBook.bids[0]?.price || 0;
  const bestAsk = orderBook.asks[0]?.price || 0;
  
  if (bestBid === 0 || bestAsk === 0) return 0;
  
  // Calculate spread
  const spread = (bestAsk - bestBid) / bestBid;
  
  // Normalize to 0-1 (assuming max reasonable spread is 5%)
  return Math.min(1, spread / 0.05);
}

/**
 * Calculate time-based entropy (uncertainty increases with time)
 * @param {Date} endDate - Market end date
 * @returns {number} - Time entropy (0-1)
 */
function calculateTimeEntropy(endDate) {
  if (!endDate) return 0.5;
  
  const now = new Date();
  const end = new Date(endDate);
  const daysLeft = Math.max(0, (end - now) / (1000 * 60 * 60 * 24));
  
  // More uncertainty with more time left
  return Math.min(1, daysLeft / 365);
}

/**
 * Calculate news entropy (based on news volume and sentiment diversity)
 * @param {Array<Object>} news - Array of news items
 * @returns {number} - News entropy (0-1)
 */
function calculateNewsEntropy(news) {
  if (!Array.isArray(news) || news.length === 0) return 0;
  
  // Calculate sentiment diversity
  const sentiments = news.map(n => n.sentiment || 0);
  const uniqueSentiments = new Set(sentiments);
  const sentimentDiversity = uniqueSentiments.size / news.length;
  
  // Calculate recency diversity (mix of old and new news)
  const now = Date.now();
  const recentCount = news.filter(n => {
    const pubTime = n.publishedAt ? new Date(n.publishedAt).getTime() : 0;
    return (now - pubTime) < (24 * 60 * 60 * 1000); // Last 24 hours
  }).length;
  
  const recencyDiversity = Math.min(1, recentCount / news.length);
  
  // Combine factors
  return (sentimentDiversity * 0.6) + (recencyDiversity * 0.4);
}

/**
 * Calculate comprehensive market entropy
 * @param {Object} market - Market object with various attributes
 * @param {Object} options - Calculation options
 * @returns {Object} - Comprehensive entropy analysis
 */
function calculateMarketEntropy(market, options = {}) {
  try {
    const {
      priceHistory = [],
      volumeHistory = [],
      orderBook = null,
      news = [],
      endDate = null,
      outcomes = []
    } = options;

    // Calculate individual entropy components
    const priceEntropy = calculateVolatilityEntropy(priceHistory);
    const volumeEntropy = calculateVolumeEntropy(volumeHistory);
    const orderBookEntropy = calculateOrderBookEntropy(orderBook);
    const timeEntropy = calculateTimeEntropy(endDate);
    const newsEntropy = calculateNewsEntropy(news);
    
    // Calculate outcome entropy (from outcome prices)
    let outcomeEntropy = 0;
    if (Array.isArray(outcomes) && outcomes.length > 1) {
      outcomeEntropy = calculateShannonEntropy(outcomes);
    }

    // Weight the components based on market characteristics
    const weights = {
      price: 0.25,
      volume: 0.15,
      orderBook: 0.15,
      time: 0.15,
      news: 0.2,
      outcome: 0.1
    };

    // Adjust weights based on data availability
    let totalWeight = 0;
    let weightedEntropy = 0;

    if (priceHistory.length > 0) {
      weightedEntropy += priceEntropy * weights.price;
      totalWeight += weights.price;
    }
    if (volumeHistory.length > 0) {
      weightedEntropy += volumeEntropy * weights.volume;
      totalWeight += weights.volume;
    }
    if (orderBook) {
      weightedEntropy += orderBookEntropy * weights.orderBook;
      totalWeight += weights.orderBook;
    }
    if (endDate) {
      weightedEntropy += timeEntropy * weights.time;
      totalWeight += weights.time;
    }
    if (news.length > 0) {
      weightedEntropy += newsEntropy * weights.news;
      totalWeight += weights.news;
    }
    if (outcomes.length > 1) {
      weightedEntropy += outcomeEntropy * weights.outcome;
      totalWeight += weights.outcome;
    }

    const finalEntropy = totalWeight > 0 ? weightedEntropy / totalWeight : 0.5;

    // Determine uncertainty level
    let uncertaintyLevel = 'LOW';
    if (finalEntropy > 0.7) uncertaintyLevel = 'VERY_HIGH';
    else if (finalEntropy > 0.5) uncertaintyLevel = 'HIGH';
    else if (finalEntropy > 0.3) uncertaintyLevel = 'MODERATE';

    return {
      entropy: Number(finalEntropy.toFixed(4)),
      uncertaintyLevel,
      components: {
        price: Number(priceEntropy.toFixed(4)),
        volume: Number(volumeEntropy.toFixed(4)),
        orderBook: Number(orderBookEntropy.toFixed(4)),
        time: Number(timeEntropy.toFixed(4)),
        news: Number(newsEntropy.toFixed(4)),
        outcome: Number(outcomeEntropy.toFixed(4))
      },
      weights,
      message: `Market uncertainty: ${uncertaintyLevel} (entropy: ${(finalEntropy * 100).toFixed(1)}%)`
    };

  } catch (error) {
    console.error('Market entropy calculation error:', error.message);
    return {
      entropy: 0.5,
      uncertaintyLevel: 'MODERATE',
      components: {},
      weights: {},
      message: 'Entropy calculation failed, using default'
    };
  }
}

/**
 * Calculate entropy discount for edge calculation
 * @param {number} entropy - Entropy value (0-1)
 * @param {number} baseEdge - Base edge value
 * @returns {number} - Discounted edge
 */
function applyEntropyDiscount(entropy, baseEdge) {
  // Higher entropy = higher discount
  const discountFactor = 1 - (entropy * 0.3); // Max 30% discount
  return baseEdge * discountFactor;
}

module.exports = {
  calculateShannonEntropy,
  calculateVolatilityEntropy,
  calculateVolumeEntropy,
  calculateOrderBookEntropy,
  calculateTimeEntropy,
  calculateNewsEntropy,
  calculateMarketEntropy,
  applyEntropyDiscount
};
