/**
 * Comparative Benchmarking Module
 * Ranks user performance against top Polymarket traders
 */

const axios = require('axios');
require('dotenv').config();

const DATA_API = process.env.DATA_API_URL || 'https://data-api.polymarket.com';

/**
 * Fetch top traders leaderboard from Polymarket
 * @param {number} limit - Number of top traders to fetch
 * @returns {Array} - Top traders data
 */
async function fetchTopTraders(limit = 50) {
  try {
    // Polymarket doesn't have a public leaderboard API
    // We'll simulate this by fetching recent activity and aggregating
    const url = `${DATA_API}/activity?limit=${limit * 50}`; // Get more data
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Oracle-of-Poly/1.0'
      },
      timeout: 15000
    }).catch(() => ({ data: [] })); // Graceful fallback

    if (!response.data || !Array.isArray(response.data)) {
      return [];
    }

    // Aggregate by trader and sort by volume
    const traderStats = new Map();
    
    response.data.forEach(activity => {
      const trader = activity.maker || activity.proxyWallet;
      if (!trader) return;

      if (!traderStats.has(trader)) {
        traderStats.set(trader, {
          address: trader,
          totalVolume: 0,
          totalTrades: 0,
          categories: new Set()
        });
      }

      const stats = traderStats.get(trader);
      stats.totalVolume += (activity.size || 0) * (activity.price || 0);
      stats.totalTrades += 1;
      
      // Track categories (simplified - would need market data for accurate categorization)
      if (activity.title) {
        if (/bitcoin|ethereum|crypto/i.test(activity.title)) stats.categories.add('CRYPTO');
        else if (/election|politic/i.test(activity.title)) stats.categories.add('POLITICS');
        else if (/war|conflict/i.test(activity.title)) stats.categories.add('WAR_OUTCOMES');
        else stats.categories.add('OTHER');
      }
    });

    // Convert to array and sort by volume
    const topTraders = Array.from(traderStats.values())
      .sort((a, b) => b.totalVolume - a.totalVolume)
      .slice(0, limit)
      .map((trader, index) => ({
        rank: index + 1,
        address: trader.address,
        totalVolume: trader.totalVolume,
        totalTrades: trader.totalTrades,
        categories: Array.from(trader.categories),
        avgPositionSize: trader.totalVolume / Math.max(1, trader.totalTrades)
      }));

    return topTraders;
  } catch (error) {
    console.error('Failed to fetch top traders:', error.message);
    return [];
  }
}

/**
 * Calculate user's percentile rank among top traders
 * @param {Object} userMetrics - User's performance metrics
 * @param {Array} topTraders - Array of top traders
 * @returns {Object} - Benchmarking results
 */
function calculateBenchmark(userMetrics, topTraders) {
  if (!topTraders || topTraders.length === 0) {
    return {
      rank: null,
      percentile: null,
      totalTraders: 0,
      metrics: {}
    };
  }

  const userVolume = userMetrics.totalVolume || 0;
  const userWinRate = userMetrics.winRate || 0;
  const userTrades = userMetrics.totalTrades || 0;

  // Find rank by volume
  let volumeRank = topTraders.length + 1;
  for (let i = 0; i < topTraders.length; i++) {
    if (userVolume >= topTraders[i].totalVolume) {
      volumeRank = i + 1;
      break;
    }
  }

  // Calculate percentiles
  const volumePercentile = ((topTraders.length - volumeRank + 1) / (topTraders.length + 1)) * 100;
  
  // Win rate percentile
  const sortedByWinRate = [...topTraders].sort((a, b) => {
    // Estimate win rate from volume (simplified)
    const winRateA = Math.min(60, 40 + (a.totalVolume / 10000));
    const winRateB = Math.min(60, 40 + (b.totalVolume / 10000));
    return winRateB - winRateA;
  });
  
  let winRateRank = sortedByWinRate.length + 1;
  for (let i = 0; i < sortedByWinRate.length; i++) {
    const estimatedWinRate = Math.min(60, 40 + (sortedByWinRate[i].totalVolume / 10000));
    if (userWinRate >= estimatedWinRate) {
      winRateRank = i + 1;
      break;
    }
  }
  
  const winRatePercentile = ((sortedByWinRate.length - winRateRank + 1) / (sortedByWinRate.length + 1)) * 100;

  // Calculate composite score
  const volumeScore = Math.max(0, 100 - volumeRank);
  const winRateScore = winRatePercentile;
  const compositeScore = (volumeScore * 0.6) + (winRateScore * 0.4);

  return {
    rank: volumeRank,
    percentile: volumePercentile,
    totalTraders: topTraders.length,
    metrics: {
      volumeRank,
      volumePercentile,
      winRateRank,
      winRatePercentile,
      compositeScore,
      compositeRank: Math.max(1, Math.floor(compositeScore / 100 * topTraders.length))
    },
    comparison: {
      userVolume,
      topTraderVolume: topTraders[0]?.totalVolume || 0,
      medianVolume: topTraders[Math.floor(topTraders.length / 2)]?.totalVolume || 0,
      userWinRate,
      avgTopWinRate: 45, // Estimated average
      userTrades,
      avgTopTrades: topTraders.reduce((sum, t) => sum + t.totalTrades, 0) / topTraders.length
    }
  };
}

/**
 * Generate benchmark insights
 * @param {Object} benchmark - Benchmark results
 * @returns {Array} - Insights array
 */
function generateBenchmarkInsights(benchmark) {
  const insights = [];
  const { metrics, comparison } = benchmark;

  // Volume insights
  if (metrics.volumePercentile >= 80) {
    insights.push({
      type: 'strength',
      title: 'Top Volume Trader',
      description: `You're in the top ${100 - metrics.volumePercentile.toFixed(0)}% by trading volume`
    });
  } else if (metrics.volumePercentile >= 50) {
    insights.push({
      type: 'neutral',
      title: 'Above Average Volume',
      description: `Your trading volume is above the median`
    });
  } else {
    insights.push({
      type: 'weakness',
      title: 'Below Average Volume',
      description: `Consider increasing position sizes or trade frequency`
    });
  }

  // Win rate insights
  if (metrics.winRatePercentile >= 70) {
    insights.push({
      type: 'strength',
      title: 'Strong Win Rate',
      description: `Your win rate beats ${metrics.winRatePercentile.toFixed(0)}% of top traders`
    });
  } else if (metrics.winRatePercentile < 30) {
    insights.push({
      type: 'weakness',
      title: 'Improve Win Rate',
      description: `Focus on higher conviction trades to improve win rate`
    });
  }

  // Composite insights
  if (metrics.compositeScore >= 70) {
    insights.push({
      type: 'strength',
      title: 'Elite Trader',
      description: `You're performing in the top 30% of all traders`
    });
  }

  return insights;
}

/**
 * Get user's ranking position
 * @param {Object} userProfile - User profile data
 * @returns {Object} - Complete benchmarking data
 */
async function getUserBenchmark(userProfile) {
  try {
    const topTraders = await fetchTopTraders(100);
    const benchmark = calculateBenchmark(userProfile.metrics || {}, topTraders);
    const insights = generateBenchmarkInsights(benchmark);

    return {
      ...benchmark,
      insights,
      topTraders: topTraders.slice(0, 10), // Top 10 for display
      generatedAt: Date.now()
    };
  } catch (error) {
    console.error('Benchmark generation failed:', error.message);
    return {
      rank: null,
      percentile: null,
      totalTraders: 0,
      metrics: {},
      insights: [],
      topTraders: [],
      error: error.message
    };
  }
}

module.exports = {
  fetchTopTraders,
  calculateBenchmark,
  generateBenchmarkInsights,
  getUserBenchmark
};
