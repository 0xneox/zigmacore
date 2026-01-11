const { classifyMarket } = require('./utils/classifier');

/**
 * Analyze trading patterns from user activity
 */
function analyzeTradingPatterns(trades, positions) {
  const patterns = {
    avgHoldTime: 0,
    tradeFrequency: 0,
    buySellRatio: 0,
    avgPositionSize: 0,
    scalpingTendency: 0,
    swingTendency: 0,
    hodlTendency: 0,
    preferredTimeframes: []
  };

  if (trades.length === 0) return patterns;

  // Calculate buy/sell ratio
  const buys = trades.filter(t => t.side === 'BUY');
  const sells = trades.filter(t => t.side === 'SELL');
  patterns.buySellRatio = buys.length / (sells.length || 1);

  // Calculate average position size
  const totalVolume = trades.reduce((sum, t) => sum + (t.size * t.price || 0), 0);
  patterns.avgPositionSize = totalVolume / trades.length;

  // Calculate trade frequency (trades per day)
  if (trades.length > 1) {
    const timestamps = trades.map(t => t.timestamp || 0).filter(t => t > 0).sort((a, b) => a - b);
    if (timestamps.length > 1) {
      const daysDiff = (timestamps[timestamps.length - 1] - timestamps[0]) / (1000 * 60 * 60 * 24);
      patterns.tradeFrequency = daysDiff > 0 ? trades.length / daysDiff : 0;
    }
  }

  // Analyze holding times
  const holdTimes = [];
  const tradesByMarket = {};
  
  trades.forEach(trade => {
    const marketId = trade.conditionId || trade.asset;
    if (!tradesByMarket[marketId]) {
      tradesByMarket[marketId] = [];
    }
    tradesByMarket[marketId].push(trade);
  });

  Object.values(tradesByMarket).forEach(marketTrades => {
    const sorted = marketTrades.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].side === 'BUY' && sorted[i + 1].side === 'SELL') {
        const holdTime = (sorted[i + 1].timestamp - sorted[i].timestamp) / (1000 * 60 * 60); // hours
        holdTimes.push(holdTime);
      }
    }
  });

  if (holdTimes.length > 0) {
    patterns.avgHoldTime = holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;

    // Classify trading style based on hold time
    const shortHolds = holdTimes.filter(t => t < 1).length; // < 1 hour
    const mediumHolds = holdTimes.filter(t => t >= 1 && t < 24).length; // 1-24 hours
    const longHolds = holdTimes.filter(t => t >= 24).length; // > 24 hours
    const total = holdTimes.length;

    patterns.scalpingTendency = shortHolds / total;
    patterns.swingTendency = mediumHolds / total;
    patterns.hodlTendency = longHolds / total;
  }

  return patterns;
}

/**
 * Analyze performance by market category
 */
function analyzeCategoryPerformance(trades, positions) {
  const categoryStats = {};

  // Group trades by market for P&L calculation
  const tradesByMarket = {};
  trades.forEach(trade => {
    const marketId = trade.conditionId || trade.asset;
    if (!tradesByMarket[marketId]) {
      tradesByMarket[marketId] = [];
    }
    tradesByMarket[marketId].push(trade);
  });

  // Calculate P&L for each market using FIFO matching
  Object.entries(tradesByMarket).forEach(([marketId, marketTrades]) => {
    const sorted = marketTrades.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const buyQueue = [];
    let marketPnl = 0;
    let marketWins = 0;
    let marketLosses = 0;
    let marketVolume = 0;
    let marketTradesCount = 0;

    sorted.forEach(trade => {
      const category = classifyMarket(trade.title);
      if (!categoryStats[category]) {
        categoryStats[category] = {
          trades: 0,
          volume: 0,
          pnl: 0,
          wins: 0,
          losses: 0,
          markets: new Set()
        };
      }

      marketTradesCount++;
      marketVolume += trade.size * trade.price || 0;
      categoryStats[category].markets.add(marketId);

      if (trade.side === 'BUY') {
        buyQueue.push({ size: trade.size, price: trade.price });
      } else if (trade.side === 'SELL') {
        let remainingSell = trade.size;
        while (remainingSell > 0 && buyQueue.length > 0) {
          const buy = buyQueue[0];
          const matchSize = Math.min(remainingSell, buy.size);
          const pnl = matchSize * (trade.price - buy.price);
          marketPnl += pnl;

          if (pnl > 0) marketWins++;
          else if (pnl < 0) marketLosses++;

          remainingSell -= matchSize;
          buy.size -= matchSize;
          if (buy.size <= 0) buyQueue.shift();
        }
      }
    });

    // Add market totals to category
    const firstTrade = sorted[0];
    if (firstTrade) {
      const category = classifyMarket(firstTrade.title);
      if (categoryStats[category]) {
        categoryStats[category].trades += marketTradesCount;
        categoryStats[category].volume += marketVolume;
        categoryStats[category].pnl += marketPnl;
        categoryStats[category].wins += marketWins;
        categoryStats[category].losses += marketLosses;
      }
    }
  });

  // Add unrealized P&L from active positions
  positions.forEach(pos => {
    const category = classifyMarket(pos.title);
    if (!categoryStats[category]) {
      categoryStats[category] = {
        trades: 0,
        volume: 0,
        pnl: 0,
        wins: 0,
        losses: 0,
        markets: new Set()
      };
    }
    categoryStats[category].pnl += pos.cashPnl || 0;
    categoryStats[category].markets.add(pos.conditionId || pos.asset);
  });

  // Convert to array and calculate metrics
  return Object.entries(categoryStats).map(([category, stats]) => ({
    category,
    trades: stats.trades,
    volume: stats.volume,
    pnl: stats.pnl,
    winRate: (stats.wins + stats.losses) > 0 ? (stats.wins / (stats.wins + stats.losses)) * 100 : 0,
    uniqueMarkets: stats.markets.size
  })).sort((a, b) => b.pnl - a.pnl);
}

/**
 * Analyze risk and concentration
 */
function analyzeRiskAndConcentration(positions, metrics) {
  const risk = {
    concentrationScore: 0,
    topPositionExposure: 0,
    categoryConcentration: {},
    maxDrawdownRisk: 0,
    leverageRisk: 0,
    diversificationScore: 0
  };

  if (positions.length === 0) return risk;

  const totalValue = metrics.unrealizedPnl || 0;
  if (totalValue === 0) return risk;

  // Calculate position concentration
  const positionValues = positions.map(p => p.currentValue || p.size * p.curPrice || 0);
  positionValues.sort((a, b) => b - a);
  risk.topPositionExposure = (positionValues[0] / totalValue) * 100;

  // Calculate Herfindahl-Hirschman Index for concentration
  const hhi = positionValues.reduce((sum, val) => sum + Math.pow(val / totalValue, 2), 0);
  risk.concentrationScore = hhi * 100;

  // Category concentration
  const categoryValue = {};
  positions.forEach(pos => {
    const category = classifyMarket(pos.title);
    const value = pos.currentValue || pos.size * pos.curPrice || 0;
    categoryValue[category] = (categoryValue[category] || 0) + value;
  });

  Object.entries(categoryValue).forEach(([cat, val]) => {
    risk.categoryConcentration[cat] = (val / totalValue) * 100;
  });

  // Diversification score (inverse of concentration)
  risk.diversificationScore = Math.max(0, 100 - risk.concentrationScore);

  // Max drawdown risk (based on unrealized P&L)
  const totalUnrealizedLoss = positions.reduce((sum, p) => sum + Math.min(0, p.cashPnl || 0), 0);
  risk.maxDrawdownRisk = totalValue > 0 ? (Math.abs(totalUnrealizedLoss) / totalValue) * 100 : 0;

  return risk;
}

/**
 * Analyze market timing
 */
function analyzeMarketTiming(trades) {
  const timing = {
    bestHour: null,
    worstHour: null,
    bestDayOfWeek: null,
    worstDayOfWeek: null,
    hourlyPnl: {},
    dailyPnl: {},
    avgEntryTiming: 0
  };

  if (trades.length === 0) return timing;

  // Analyze by hour
  const hourlyStats = {};
  const dailyStats = {};

  trades.forEach(trade => {
    if (!trade.timestamp) return;
    
    const date = new Date(trade.timestamp);
    const hour = date.getHours();
    const day = date.getDay();

    if (!hourlyStats[hour]) hourlyStats[hour] = { pnl: 0, trades: 0 };
    if (!dailyStats[day]) dailyStats[day] = { pnl: 0, trades: 0 };

    const pnl = trade.side === 'SELL' ? (trade.price * trade.size) : -(trade.price * trade.size);
    hourlyStats[hour].pnl += pnl;
    hourlyStats[hour].trades++;
    dailyStats[day].pnl += pnl;
    dailyStats[day].trades++;
  });

  // Find best/worst hours
  Object.entries(hourlyStats).forEach(([hour, stats]) => {
    if (stats.trades > 0) {
      timing.hourlyPnl[hour] = stats.pnl / stats.trades;
    }
  });

  const sortedHours = Object.entries(timing.hourlyPnl).sort((a, b) => b[1] - a[1]);
  if (sortedHours.length > 0) {
    timing.bestHour = parseInt(sortedHours[0][0]);
    timing.worstHour = parseInt(sortedHours[sortedHours.length - 1][0]);
  }

  // Find best/worst days
  Object.entries(dailyStats).forEach(([day, stats]) => {
    if (stats.trades > 0) {
      timing.dailyPnl[day] = stats.pnl / stats.trades;
    }
  });

  const sortedDays = Object.entries(timing.dailyPnl).sort((a, b) => b[1] - a[1]);
  if (sortedDays.length > 0) {
    timing.bestDayOfWeek = parseInt(sortedDays[0][0]);
    timing.worstDayOfWeek = parseInt(sortedDays[sortedDays.length - 1][0]);
  }

  return timing;
}

/**
 * Generate actionable trading recommendations
 */
function generateRecommendations(profile, patterns, categoryPerf, risk, timing) {
  const recommendations = [];

  // Trading style recommendations
  if (patterns.scalpingTendency > 0.6) {
    recommendations.push({
      type: 'style',
      priority: 'medium',
      title: 'Reduce Scalping Frequency',
      description: 'You frequently hold positions for less than an hour. Consider longer timeframes to reduce transaction costs and improve win rate.'
    });
  }

  if (patterns.hodlTendency > 0.7 && patterns.winRate < 50) {
    recommendations.push({
      type: 'style',
      priority: 'high',
      title: 'Review Long-term Positions',
      description: 'You hold positions for extended periods but have a sub-50% win rate. Consider setting tighter stop-losses.'
    });
  }

  // Category recommendations
  const bestCategory = categoryPerf[0];
  const worstCategory = categoryPerf[categoryPerf.length - 1];

  if (bestCategory && worstCategory && bestCategory.pnl > 0 && worstCategory.pnl < 0) {
    recommendations.push({
      type: 'category',
      priority: 'high',
      title: `Focus on ${bestCategory.category} Markets`,
      description: `You perform best in ${bestCategory.category} (${bestCategory.pnl > 0 ? '+' : ''}$${bestCategory.pnl.toFixed(2)}) but lose in ${worstCategory.category}. Consider reallocating capital.`
    });
  }

  // Risk recommendations
  if (risk.concentrationScore > 50) {
    recommendations.push({
      type: 'risk',
      priority: 'high',
      title: 'Diversify Your Portfolio',
      description: `${risk.topPositionExposure.toFixed(1)}% of your portfolio is in a single position. Consider spreading risk across more markets.`
    });
  }

  if (risk.maxDrawdownRisk > 30) {
    recommendations.push({
      type: 'risk',
      priority: 'high',
      title: 'Manage Drawdown Risk',
      description: `Your current unrealized losses represent ${risk.maxDrawdownRisk.toFixed(1)}% of portfolio value. Consider cutting losing positions.`
    });
  }

  // Timing recommendations
  if (timing.bestHour !== null && timing.worstHour !== null) {
    if (timing.hourlyPnl[timing.bestHour] > 0 && timing.hourlyPnl[timing.worstHour] < 0) {
      recommendations.push({
        type: 'timing',
        priority: 'medium',
        title: `Optimize Trading Hours`,
        description: `You perform best during ${timing.bestHour}:00 but worst at ${timing.worstHour}:00. Consider timing your trades accordingly.`
      });
    }
  }

  return recommendations;
}

/**
 * Calculate portfolio health score
 */
function calculatePortfolioHealth(metrics, patterns, risk, categoryPerf) {
  let score = 100;
  const factors = [];

  // Win rate impact (20 points)
  const winRateScore = (metrics.winRate / 100) * 20;
  score -= (20 - winRateScore);
  factors.push({ name: 'Win Rate', impact: 20 - winRateScore, value: metrics.winRate });

  // P&L impact (30 points)
  const pnlRatio = metrics.realizedPnl / (metrics.totalVolume || 1);
  const pnlScore = Math.min(30, Math.max(-30, pnlRatio * 100));
  score += pnlScore;
  factors.push({ name: 'P&L Efficiency', impact: pnlScore, value: pnlRatio * 100 });

  // Diversification impact (20 points)
  const divScore = risk.diversificationScore / 5;
  score -= (20 - divScore);
  factors.push({ name: 'Diversification', impact: 20 - divScore, value: risk.diversificationScore });

  // Concentration penalty (15 points)
  const concPenalty = Math.min(15, risk.concentrationScore / 3);
  score -= concPenalty;
  factors.push({ name: 'Concentration Risk', impact: -concPenalty, value: risk.concentrationScore });

  // Drawdown risk (15 points)
  const drawdownPenalty = Math.min(15, risk.maxDrawdownRisk / 2);
  score -= drawdownPenalty;
  factors.push({ name: 'Drawdown Risk', impact: -drawdownPenalty, value: risk.maxDrawdownRisk });

  return {
    score: Math.max(0, Math.min(100, score)),
    grade: getHealthGrade(Math.max(0, Math.min(100, score))),
    factors
  };
}

function getHealthGrade(score) {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

/**
 * Main analysis function
 */
function analyzeUserProfile(profile, positions, activity, metrics) {
  const trades = activity.filter(a => a.type === 'TRADE');

  const patterns = analyzeTradingPatterns(trades, positions);
  const categoryPerf = analyzeCategoryPerformance(trades, positions);
  const risk = analyzeRiskAndConcentration(positions, metrics);
  const timing = analyzeMarketTiming(trades);
  const recommendations = generateRecommendations(profile, patterns, categoryPerf, risk, timing);
  const health = calculatePortfolioHealth(metrics, patterns, risk, categoryPerf);

  return {
    patterns,
    categoryPerformance: categoryPerf,
    risk,
    timing,
    recommendations,
    health,
    summary: generateAnalysisSummary(patterns, categoryPerf, risk, health)
  };
}

function generateAnalysisSummary(patterns, categoryPerf, risk, health) {
  const parts = [];

  // Trading style
  if (patterns.scalpingTendency > 0.5) {
    parts.push('Active scalper');
  } else if (patterns.hodlTendency > 0.5) {
    parts.push('Position trader');
  } else {
    parts.push('Swing trader');
  }

  // Best category
  if (categoryPerf.length > 0 && categoryPerf[0].pnl > 0) {
    parts.push(`strong in ${categoryPerf[0].category}`);
  }

  // Risk level
  if (risk.concentrationScore > 50) {
    parts.push('high concentration risk');
  } else if (risk.diversificationScore > 70) {
    parts.push('well-diversified');
  }

  // Health
  parts.push(`portfolio health: ${health.grade}`);

  return parts.join(', ');
}

module.exports = {
  analyzeUserProfile,
  analyzeTradingPatterns,
  analyzeCategoryPerformance,
  analyzeRiskAndConcentration,
  analyzeMarketTiming,
  generateRecommendations,
  calculatePortfolioHealth
};
