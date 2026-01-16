const { classifyMarket } = require('./utils/classifier');

/**
 * Analyze trading patterns from user activity
 * Returns comprehensive trading behavior metrics
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
    preferredTimeframes: [],
    winRate: 0,
    avgWinSize: 0,
    avgLossSize: 0,
    profitFactor: 0,
    sharpeRatio: 0,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    recoveryFactor: 0
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

  // Analyze holding times and calculate win rate
  const holdTimes = [];
  const tradesByMarket = {};
  
  trades.forEach(trade => {
    const marketId = trade.conditionId || trade.asset;
    if (!tradesByMarket[marketId]) {
      tradesByMarket[marketId] = [];
    }
    tradesByMarket[marketId].push(trade);
  });

  // Calculate wins, losses, and hold times
  let wins = 0;
  let losses = 0;
  let totalWinAmount = 0;
  let totalLossAmount = 0;
  let consecutiveWins = 0;
  let consecutiveLosses = 0;
  let currentStreak = { type: null, count: 0 };
  const pnlHistory = [];

  Object.values(tradesByMarket).forEach(marketTrades => {
    const sorted = marketTrades.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const buyQueue = [];
    
    for (let i = 0; i < sorted.length; i++) {
      const trade = sorted[i];
      
      if (trade.side === 'BUY') {
        buyQueue.push({ 
          size: trade.size, 
          price: trade.price, 
          timestamp: trade.timestamp 
        });
      } else if (trade.side === 'SELL') {
        let remainingSell = trade.size;
        
        while (remainingSell > 0 && buyQueue.length > 0) {
          const buy = buyQueue[0];
          const matchSize = Math.min(remainingSell, buy.size);
          const pnl = matchSize * (trade.price - buy.price);
          
          // Track P&L
          pnlHistory.push(pnl);
          
          // Track wins/losses
          if (pnl > 0) {
            wins++;
            totalWinAmount += pnl;
            
            if (currentStreak.type === 'win') {
              currentStreak.count++;
            } else {
              consecutiveWins = Math.max(consecutiveWins, currentStreak.count);
              currentStreak = { type: 'win', count: 1 };
            }
          } else if (pnl < 0) {
            losses++;
            totalLossAmount += Math.abs(pnl);
            
            if (currentStreak.type === 'loss') {
              currentStreak.count++;
            } else {
              consecutiveLosses = Math.max(consecutiveLosses, currentStreak.count);
              currentStreak = { type: 'loss', count: 1 };
            }
          }
          
          // Calculate hold time
          if (buy.timestamp && trade.timestamp) {
            const holdTime = (trade.timestamp - buy.timestamp) / (1000 * 60 * 60); // hours
            if (holdTime >= 0) holdTimes.push(holdTime);
          }
          
          remainingSell -= matchSize;
          buy.size -= matchSize;
          if (buy.size <= 0) buyQueue.shift();
        }
      }
    }
  });

  // Finalize consecutive streaks
  consecutiveWins = Math.max(consecutiveWins, currentStreak.type === 'win' ? currentStreak.count : 0);
  consecutiveLosses = Math.max(consecutiveLosses, currentStreak.type === 'loss' ? currentStreak.count : 0);

  patterns.maxConsecutiveWins = consecutiveWins;
  patterns.maxConsecutiveLosses = consecutiveLosses;

  // Calculate win rate and related metrics
  const totalTrades = wins + losses;
  if (totalTrades > 0) {
    patterns.winRate = (wins / totalTrades) * 100;
    patterns.avgWinSize = wins > 0 ? totalWinAmount / wins : 0;
    patterns.avgLossSize = losses > 0 ? totalLossAmount / losses : 0;
    
    // Profit factor: total wins / total losses
    patterns.profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount > 0 ? 999 : 0;
    
    // Sharpe ratio (simplified: avg return / std dev of returns)
    if (pnlHistory.length > 1) {
      const avgPnl = pnlHistory.reduce((a, b) => a + b, 0) / pnlHistory.length;
      const variance = pnlHistory.reduce((sum, pnl) => sum + Math.pow(pnl - avgPnl, 2), 0) / pnlHistory.length;
      const stdDev = Math.sqrt(variance);
      patterns.sharpeRatio = stdDev > 0 ? avgPnl / stdDev : 0;
    }
    
    // Recovery factor: total profit / max drawdown
    const cumulativePnl = [];
    let runningTotal = 0;
    pnlHistory.forEach(pnl => {
      runningTotal += pnl;
      cumulativePnl.push(runningTotal);
    });
    
    let maxDrawdown = 0;
    let peak = cumulativePnl[0] || 0;
    cumulativePnl.forEach(value => {
      if (value > peak) peak = value;
      const drawdown = peak - value;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    });
    
    const totalProfit = pnlHistory.reduce((a, b) => a + b, 0);
    patterns.recoveryFactor = maxDrawdown > 0 ? totalProfit / maxDrawdown : totalProfit > 0 ? 999 : 0;
  }

  // Analyze hold times
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

    // Determine preferred timeframes
    if (patterns.scalpingTendency > 0.4) patterns.preferredTimeframes.push('scalping');
    if (patterns.swingTendency > 0.4) patterns.preferredTimeframes.push('swing');
    if (patterns.hodlTendency > 0.4) patterns.preferredTimeframes.push('position');
  }

  return patterns;
}

/**
 * Analyze performance by market category
 * Returns detailed metrics for each market category
 */
function analyzeCategoryPerformance(trades, positions) {
  const categoryStats = {};
  const processedMarkets = new Set();

  // Group trades by market to match BUY/SELL pairs
  const tradesByMarket = {};
  trades.forEach(trade => {
    const marketId = trade.conditionId || trade.asset;
    if (!tradesByMarket[marketId]) {
      tradesByMarket[marketId] = [];
    }
    tradesByMarket[marketId].push(trade);
  });

  // Calculate P&L and wins/losses per market
  Object.entries(tradesByMarket).forEach(([marketId, marketTrades]) => {
    const sorted = marketTrades.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    let marketPnl = 0;
    let marketWins = 0;
    let marketLosses = 0;
    let marketVolume = 0;
    let marketTradesCount = sorted.length;
    const buyQueue = [];

    sorted.forEach(trade => {
      const category = classifyMarket(trade.title || trade.market || '');
      if (!categoryStats[category]) {
        categoryStats[category] = {
          trades: 0,
          volume: 0,
          pnl: 0,
          wins: 0,
          losses: 0,
          markets: new Set(),
          avgTradeSize: 0,
          winningTrades: [],
          losingTrades: [],
          totalTradesInCategory: 0
        };
      }

      marketVolume += (trade.size * trade.price) || 0;

      if (trade.side === 'BUY') {
        buyQueue.push({ size: trade.size, price: trade.price });
      } else if (trade.side === 'SELL') {
        let remainingSell = trade.size;
        
        while (remainingSell > 0 && buyQueue.length > 0) {
          const buy = buyQueue[0];
          const matchSize = Math.min(remainingSell, buy.size);
          const pnl = matchSize * (trade.price - buy.price);
          marketPnl += pnl;

          if (pnl > 0) {
            marketWins++;
            categoryStats[category].winningTrades.push(pnl);
          } else if (pnl < 0) {
            marketLosses++;
            categoryStats[category].losingTrades.push(pnl);
          }

          remainingSell -= matchSize;
          buy.size -= matchSize;
          if (buy.size <= 0) buyQueue.shift();
        }
      }
    });

    // Add market totals to category
    const firstTrade = sorted[0];
    if (firstTrade) {
      const category = classifyMarket(firstTrade.title || firstTrade.market || '');
      if (categoryStats[category]) {
        categoryStats[category].trades += marketTradesCount;
        categoryStats[category].volume += marketVolume;
        categoryStats[category].pnl += marketPnl;
        categoryStats[category].wins += marketWins;
        categoryStats[category].losses += marketLosses;
        categoryStats[category].markets.add(marketId);
        processedMarkets.add(marketId);
      }
    }
  });

  // Add unrealized P&L from ACTIVE positions (only if not already processed)
  positions.forEach(pos => {
    const marketId = pos.conditionId || pos.asset;
    
    // Only add positions that weren't already processed from trades
    if (!processedMarkets.has(marketId)) {
      const category = classifyMarket(pos.title || pos.market || '');
      if (!categoryStats[category]) {
        categoryStats[category] = {
          trades: 0,
          volume: 0,
          pnl: 0,
          wins: 0,
          losses: 0,
          markets: new Set(),
          avgTradeSize: 0,
          winningTrades: [],
          losingTrades: [],
          totalTradesInCategory: 0
        };
      }
      
      const pnl = pos.cashPnl || 0;
      categoryStats[category].pnl += pnl;
      categoryStats[category].markets.add(marketId);

      // Count active positions as wins or losses based on current P&L
      if (pnl > 0) {
        categoryStats[category].wins++;
        categoryStats[category].winningTrades.push(pnl);
      } else if (pnl < 0) {
        categoryStats[category].losses++;
        categoryStats[category].losingTrades.push(pnl);
      }
    }
  });

  // Convert to array and calculate metrics
  return Object.entries(categoryStats).map(([category, stats]) => {
    const totalTrades = stats.wins + stats.losses;
    const avgWin = stats.winningTrades.length > 0 
      ? stats.winningTrades.reduce((a, b) => a + b, 0) / stats.winningTrades.length 
      : 0;
    const avgLoss = stats.losingTrades.length > 0 
      ? Math.abs(stats.losingTrades.reduce((a, b) => a + b, 0) / stats.losingTrades.length)
      : 0;

    return {
      category,
      trades: stats.trades,
      volume: stats.volume,
      pnl: stats.pnl,
      winRate: totalTrades > 0 ? (stats.wins / totalTrades) * 100 : 0,
      uniqueMarkets: stats.markets.size,
      avgTradeSize: stats.trades > 0 ? stats.volume / stats.trades : 0,
      avgWin,
      avgLoss,
      profitFactor: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 999 : 0,
      expectancy: totalTrades > 0 ? stats.pnl / totalTrades : 0
    };
  }).sort((a, b) => b.pnl - a.pnl);
}

/**
 * Analyze risk and concentration metrics
 * Returns comprehensive risk assessment
 */
function analyzeRiskAndConcentration(positions, metrics) {
  const risk = {
    concentrationScore: 0,
    topPositionExposure: 0,
    top3PositionExposure: 0,
    categoryConcentration: {},
    maxDrawdownRisk: 0,
    leverageRisk: 0,
    diversificationScore: 0,
    portfolioVolatility: 0,
    valueAtRisk: 0,
    betaToMarket: 0,
    correlationRisk: 0
  };

  if (positions.length === 0) return risk;

  // Calculate total portfolio value correctly
  const totalValue = positions.reduce((sum, p) => {
    const posValue = p.currentValue || (p.size * p.curPrice) || 0;
    return sum + posValue;
  }, 0);

  if (totalValue === 0) return risk;

  // Calculate position concentration
  const positionValues = positions.map(p => ({
    value: p.currentValue || (p.size * p.curPrice) || 0,
    pnl: p.cashPnl || 0,
    category: classifyMarket(p.title || p.market || '')
  })).filter(p => p.value > 0);

  positionValues.sort((a, b) => b.value - a.value);

  // Top position exposure
  if (positionValues.length > 0) {
    risk.topPositionExposure = (positionValues[0].value / totalValue) * 100;
    
    // Top 3 positions exposure
    const top3Value = positionValues.slice(0, 3).reduce((sum, p) => sum + p.value, 0);
    risk.top3PositionExposure = (top3Value / totalValue) * 100;
  }

  // Calculate Herfindahl-Hirschman Index for concentration
  const hhi = positionValues.reduce((sum, p) => sum + Math.pow(p.value / totalValue, 2), 0);
  risk.concentrationScore = hhi * 100;

  // Category concentration
  const categoryValue = {};
  positionValues.forEach(pos => {
    categoryValue[pos.category] = (categoryValue[pos.category] || 0) + pos.value;
  });

  Object.entries(categoryValue).forEach(([cat, val]) => {
    risk.categoryConcentration[cat] = (val / totalValue) * 100;
  });

  // Diversification score (inverse of concentration)
  risk.diversificationScore = Math.max(0, 100 - risk.concentrationScore);

  // Max drawdown risk (based on unrealized P&L)
  const totalUnrealizedLoss = positions.reduce((sum, p) => sum + Math.min(0, p.cashPnl || 0), 0);
  risk.maxDrawdownRisk = totalValue > 0 ? (Math.abs(totalUnrealizedLoss) / totalValue) * 100 : 0;

  // Portfolio volatility (standard deviation of position returns)
  const returns = positionValues.map(p => {
    const initialValue = p.value - p.pnl;
    return initialValue > 0 ? (p.pnl / initialValue) * 100 : 0;
  });

  if (returns.length > 1) {
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / returns.length;
    risk.portfolioVolatility = Math.sqrt(variance);
  }

  // Value at Risk (95% confidence - simplified)
  if (returns.length > 0) {
    const sortedReturns = [...returns].sort((a, b) => a - b);
    const var95Index = Math.floor(sortedReturns.length * 0.05);
    risk.valueAtRisk = Math.abs(sortedReturns[var95Index] || 0);
  }

  // Correlation risk (measure of category overlap)
  const numCategories = Object.keys(categoryValue).length;
  risk.correlationRisk = numCategories > 0 ? (1 / numCategories) * 100 : 100;

  return risk;
}

/**
 * Analyze market timing patterns
 * Returns optimal trading times and patterns
 */
function analyzeMarketTiming(trades) {
  const timing = {
    bestHour: null,
    worstHour: null,
    bestDayOfWeek: null,
    worstDayOfWeek: null,
    hourlyPnl: {},
    dailyPnl: {},
    avgEntryTiming: 0,
    weekendVsWeekday: { weekend: 0, weekday: 0 },
    morningVsAfternoon: { morning: 0, afternoon: 0, evening: 0 }
  };

  if (trades.length === 0) return timing;

  // Group trades by market for proper P&L calculation
  const tradesByMarket = {};
  trades.forEach(trade => {
    const marketId = trade.conditionId || trade.asset;
    if (!tradesByMarket[marketId]) {
      tradesByMarket[marketId] = [];
    }
    tradesByMarket[marketId].push(trade);
  });

  // Calculate actual P&L per trade with timestamp
  const tradePnls = [];
  Object.values(tradesByMarket).forEach(marketTrades => {
    const sorted = marketTrades.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const buyQueue = [];

    sorted.forEach(trade => {
      if (trade.side === 'BUY') {
        buyQueue.push({ size: trade.size, price: trade.price });
      } else if (trade.side === 'SELL' && trade.timestamp) {
        let remainingSell = trade.size;
        
        while (remainingSell > 0 && buyQueue.length > 0) {
          const buy = buyQueue[0];
          const matchSize = Math.min(remainingSell, buy.size);
          const pnl = matchSize * (trade.price - buy.price);
          
          tradePnls.push({
            timestamp: trade.timestamp,
            pnl: pnl
          });

          remainingSell -= matchSize;
          buy.size -= matchSize;
          if (buy.size <= 0) buyQueue.shift();
        }
      }
    });
  });

  // Analyze by hour, day, and time periods
  const hourlyStats = {};
  const dailyStats = {};
  let weekendPnl = 0, weekdayPnl = 0;
  let morningPnl = 0, afternoonPnl = 0, eveningPnl = 0;
  let weekendCount = 0, weekdayCount = 0;
  let morningCount = 0, afternoonCount = 0, eveningCount = 0;

  tradePnls.forEach(({ timestamp, pnl }) => {
    const date = new Date(timestamp);
    const hour = date.getHours();
    const day = date.getDay();

    if (!hourlyStats[hour]) hourlyStats[hour] = { pnl: 0, trades: 0 };
    if (!dailyStats[day]) dailyStats[day] = { pnl: 0, trades: 0 };

    hourlyStats[hour].pnl += pnl;
    hourlyStats[hour].trades++;
    dailyStats[day].pnl += pnl;
    dailyStats[day].trades++;

    // Weekend vs Weekday
    if (day === 0 || day === 6) {
      weekendPnl += pnl;
      weekendCount++;
    } else {
      weekdayPnl += pnl;
      weekdayCount++;
    }

    // Time of day
    if (hour >= 6 && hour < 12) {
      morningPnl += pnl;
      morningCount++;
    } else if (hour >= 12 && hour < 18) {
      afternoonPnl += pnl;
      afternoonCount++;
    } else {
      eveningPnl += pnl;
      eveningCount++;
    }
  });

  // Calculate averages
  timing.weekendVsWeekday = {
    weekend: weekendCount > 0 ? weekendPnl / weekendCount : 0,
    weekday: weekdayCount > 0 ? weekdayPnl / weekdayCount : 0
  };

  timing.morningVsAfternoon = {
    morning: morningCount > 0 ? morningPnl / morningCount : 0,
    afternoon: afternoonCount > 0 ? afternoonPnl / afternoonCount : 0,
    evening: eveningCount > 0 ? eveningPnl / eveningCount : 0
  };

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

  // Calculate average entry timing
  const entryTimings = tradePnls.map(({ timestamp }) => {
    const date = new Date(timestamp);
    return date.getHours() + date.getMinutes() / 60;
  });
  timing.avgEntryTiming = entryTimings.reduce((a, b) => a + b, 0) / entryTimings.length;

  return timing;
}

/**
 * Generate actionable trading recommendations
 * Returns prioritized list of improvements
 */
function generateRecommendations(profile, patterns, categoryPerf, risk, timing, metrics) {
  const recommendations = [];
  const portfolioValue = metrics?.totalValue || profile?.balance || 0;

  // Position sizing recommendations
  if (risk.topPositionExposure > 25) {
    recommendations.push({
      type: 'risk',
      priority: 'high',
      title: 'Reduce Position Concentration',
      description: `Your largest position represents ${risk.topPositionExposure.toFixed(1)}% of your portfolio (recommended max: 25%). Consider reducing exposure to below $${(portfolioValue * 0.25).toFixed(2)} to minimize single-position risk.`,
      impact: 'high',
      actionable: true
    });
  }

  if (risk.top3PositionExposure > 60) {
    recommendations.push({
      type: 'risk',
      priority: 'high',
      title: 'Top 3 Positions Too Concentrated',
      description: `Your top 3 positions represent ${risk.top3PositionExposure.toFixed(1)}% of portfolio (recommended max: 50%). Diversify by adding 3-5 smaller positions across different categories.`,
      impact: 'high',
      actionable: true
    });
  }

  // Trading style recommendations
  if (patterns.scalpingTendency > 0.6 && patterns.winRate < 55) {
    recommendations.push({
      type: 'style',
      priority: 'high',
      title: 'Reduce Scalping Frequency',
      description: `You frequently hold positions for less than 1 hour (${(patterns.scalpingTendency * 100).toFixed(1)}% of trades) with only ${patterns.winRate.toFixed(1)}% win rate. Scalping requires 60%+ win rate. Consider holding 4-24 hours to improve edge.`,
      impact: 'medium',
      actionable: true
    });
  }

  if (patterns.hodlTendency > 0.7 && patterns.winRate < 50) {
    recommendations.push({
      type: 'style',
      priority: 'high',
      title: 'Review Long-Term Hold Strategy',
      description: `You hold ${(patterns.hodlTendency * 100).toFixed(1)}% of positions >24 hours but have ${patterns.winRate.toFixed(1)}% win rate. Set stop-losses at -15% and take profits at +25% to protect capital.`,
      impact: 'high',
      actionable: true
    });
  }

  // Profit factor recommendations
  if (patterns.profitFactor < 1.5 && patterns.profitFactor > 0) {
    recommendations.push({
      type: 'performance',
      priority: 'high',
      title: 'Improve Risk-Reward Ratio',
      description: `Your profit factor is ${patterns.profitFactor.toFixed(2)} (target: >2.0). Average win ($${patterns.avgWinSize.toFixed(2)}) should be 2x average loss ($${patterns.avgLossSize.toFixed(2)}). Cut losses faster and let winners run.`,
      impact: 'high',
      actionable: true
    });
  }

  // Category recommendations
  if (categoryPerf.length >= 2) {
    const bestCategory = categoryPerf[0];
    const worstCategory = categoryPerf[categoryPerf.length - 1];

    if (bestCategory && bestCategory.pnl > 0 && bestCategory.winRate > 55) {
      recommendations.push({
        type: 'category',
        priority: 'high',
        title: `Increase ${bestCategory.category} Allocation`,
        description: `${bestCategory.category} markets show strong performance: $${bestCategory.pnl.toFixed(2)} P&L, ${bestCategory.winRate.toFixed(1)}% win rate, ${bestCategory.profitFactor.toFixed(2)} profit factor. Allocate 30-40% of capital here.`,
        impact: 'high',
        actionable: true
      });
    }

    if (worstCategory && worstCategory.pnl < -50 && worstCategory.winRate < 45) {
      recommendations.push({
        type: 'category',
        priority: 'high',
        title: `Avoid ${worstCategory.category} Markets`,
        description: `${worstCategory.category} shows consistent losses: $${worstCategory.pnl.toFixed(2)} P&L, ${worstCategory.winRate.toFixed(1)}% win rate. Consider pausing trading in this category until you identify edge.`,
        impact: 'high',
        actionable: true
      });
    }
  }

  // Risk recommendations
  if (risk.concentrationScore > 40) {
    recommendations.push({
      type: 'risk',
      priority: 'high',
      title: 'Improve Portfolio Diversification',
      description: `Portfolio concentration score: ${risk.concentrationScore.toFixed(0)}/100 (target: <30). Add 4-6 positions across Politics, Crypto, Sports, Economics with <10% allocation each.`,
      impact: 'high',
      actionable: true
    });
  }

  if (risk.maxDrawdownRisk > 25) {
    recommendations.push({
      type: 'risk',
      priority: 'critical',
      title: 'Urgent: Reduce Drawdown Exposure',
      description: `Current unrealized losses: ${risk.maxDrawdownRisk.toFixed(1)}% of portfolio (critical threshold: 25%). Immediately cut positions with >20% loss. Set -15% stop-loss on all new positions.`,
      impact: 'critical',
      actionable: true
    });
  }

  if (risk.diversificationScore < 50) {
    recommendations.push({
      type: 'risk',
      priority: 'high',
      title: 'Build Diversified Portfolio',
      description: `Diversification score: ${risk.diversificationScore.toFixed(0)}% (target: >60%). Spread capital across 6+ markets in 4+ categories. Example allocation: Politics (25%), Crypto (25%), Sports (20%), Economics (15%), General (15%).`,
      impact: 'high',
      actionable: true
    });
  }

  // Volatility recommendations
  if (risk.portfolioVolatility > 30) {
    recommendations.push({
      type: 'risk',
      priority: 'medium',
      title: 'Reduce Portfolio Volatility',
      description: `Portfolio volatility: ${risk.portfolioVolatility.toFixed(1)}% (target: <20%). Add stable, low-volatility positions and reduce exposure to high-beta markets. Consider hedging with opposing positions.`,
      impact: 'medium',
      actionable: true
    });
  }

  // Timing recommendations
  if (timing.bestHour !== null && timing.worstHour !== null) {
    const bestHourPnl = timing.hourlyPnl[timing.bestHour] || 0;
    const worstHourPnl = timing.hourlyPnl[timing.worstHour] || 0;
    
    if (bestHourPnl > 5 && worstHourPnl < -5) {
      recommendations.push({
        type: 'timing',
        priority: 'medium',
        title: 'Optimize Trading Hours',
        description: `Best performance at ${timing.bestHour}:00 (avg ${bestHourPnl.toFixed(2)}/trade), worst at ${timing.worstHour}:00 (avg ${worstHourPnl.toFixed(2)}/trade). Focus trading during peak hours and avoid worst times.`,
        impact: 'medium',
        actionable: true
      });
    }
  }

  // Day of week recommendations
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (timing.bestDayOfWeek !== null && timing.worstDayOfWeek !== null) {
    const bestDayPnl = timing.dailyPnl[timing.bestDayOfWeek] || 0;
    const worstDayPnl = timing.dailyPnl[timing.worstDayOfWeek] || 0;
    
    if (bestDayPnl > 10 && worstDayPnl < -10) {
      recommendations.push({
        type: 'timing',
        priority: 'medium',
        title: 'Trade on Better Days',
        description: `${dayNames[timing.bestDayOfWeek]} shows best results (avg ${bestDayPnl.toFixed(2)}/trade) vs ${dayNames[timing.worstDayOfWeek]} (avg ${worstDayPnl.toFixed(2)}/trade). Consider reducing activity on poor-performing days.`,
        impact: 'medium',
        actionable: true
      });
    }
  }

  // Position sizing recommendations
  if (patterns.avgPositionSize > 0 && portfolioValue > 0) {
    const maxPositionSize = portfolioValue * 0.25; // 25% max
    
    if (patterns.avgPositionSize > maxPositionSize) {
      recommendations.push({
        type: 'risk',
        priority: 'high',
        title: 'Reduce Average Position Size',
        description: `Average position: ${patterns.avgPositionSize.toFixed(2)} exceeds recommended maximum of ${maxPositionSize.toFixed(2)} (25% of portfolio). Use position sizing: 5% for speculative, 15% for high-conviction, 25% max.`,
        impact: 'high',
        actionable: true
      });
    }
  }

  // Win rate recommendations
  if (patterns.winRate > 0 && patterns.winRate < 55) {
    recommendations.push({
      type: 'performance',
      priority: 'high',
      title: 'Improve Win Rate',
      description: `Current win rate: ${patterns.winRate.toFixed(1)}% (target: 60%+). Improve by: (1) Only trade with >10% edge, (2) Wait for clear entry signals, (3) Cut losses at -15%, (4) Avoid revenge trading.`,
      impact: 'high',
      actionable: true
    });
  }

  // Trade frequency recommendations
  if (patterns.tradeFrequency > 10) {
    recommendations.push({
      type: 'style',
      priority: 'medium',
      title: 'Reduce Overtrading',
      description: `Trading ${patterns.tradeFrequency.toFixed(1)} times/day may indicate overtrading. Target 2-4 high-quality setups daily with >10% edge. Quality over quantity improves long-term returns.`,
      impact: 'medium',
      actionable: true
    });
  } else if (patterns.tradeFrequency > 0 && patterns.tradeFrequency < 0.5 && patterns.winRate > 60) {
    recommendations.push({
      type: 'style',
      priority: 'low',
      title: 'Consider Increasing Activity',
      description: `You trade only ${patterns.tradeFrequency.toFixed(1)} times/day with ${patterns.winRate.toFixed(1)}% win rate. Your edge is strong - consider scaling to 2-3 trades/day to maximize returns while maintaining quality.`,
      impact: 'low',
      actionable: true
    });
  }

  // Consecutive loss recommendations
  if (patterns.maxConsecutiveLosses > 5) {
    recommendations.push({
      type: 'performance',
      priority: 'high',
      title: 'Implement Loss Limit Rules',
      description: `Max consecutive losses: ${patterns.maxConsecutiveLosses}. After 3 losses in a row, take a break and review strategy. Avoid revenge trading. Consider daily loss limit of 5% of portfolio.`,
      impact: 'high',
      actionable: true
    });
  }

  // Sharpe ratio recommendations
  if (patterns.sharpeRatio < 1 && patterns.sharpeRatio !== 0) {
    recommendations.push({
      type: 'performance',
      priority: 'medium',
      title: 'Improve Risk-Adjusted Returns',
      description: `Sharpe ratio: ${patterns.sharpeRatio.toFixed(2)} (target: >1.5). You're taking too much risk for the returns. Focus on high-probability setups and reduce position sizing in volatile markets.`,
      impact: 'medium',
      actionable: true
    });
  }

  // Recovery factor recommendations
  if (patterns.recoveryFactor < 2 && patterns.recoveryFactor > 0) {
    recommendations.push({
      type: 'performance',
      priority: 'medium',
      title: 'Reduce Drawdown Impact',
      description: `Recovery factor: ${patterns.recoveryFactor.toFixed(2)} (target: >3). Profits aren't sufficiently covering drawdowns. Implement tighter stop-losses and increase position size only on highest-conviction trades.`,
      impact: 'medium',
      actionable: true
    });
  }

  // Category concentration recommendations
  if (risk.categoryConcentration) {
    const topCategory = Object.entries(risk.categoryConcentration).sort((a, b) => b[1] - a[1])[0];
    if (topCategory && topCategory[1] > 50) {
      recommendations.push({
        type: 'risk',
        priority: 'high',
        title: 'Reduce Category Concentration',
        description: `${topCategory[1].toFixed(1)}% of portfolio in ${topCategory[0]} (max recommended: 40%). Diversify into at least 3 other categories with 15-20% allocation each to reduce correlation risk.`,
        impact: 'high',
        actionable: true
      });
    }
  }

  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return recommendations;
}

/**
 * Calculate portfolio health score
 * Returns comprehensive health assessment with detailed breakdown
 */
function calculatePortfolioHealth(metrics, patterns, risk, categoryPerf) {
  let score = 100;
  const factors = [];

  // Win rate impact (20 points)
  const winRateScore = Math.min(20, (patterns.winRate / 60) * 20);
  const winRateImpact = winRateScore - 20;
  score += winRateImpact;
  factors.push({ 
    name: 'Win Rate', 
    impact: winRateImpact, 
    value: patterns.winRate,
    weight: 20,
    description: winRateImpact < 0 ? 'Below 60% target' : 'At or above target'
  });

  // P&L efficiency impact (25 points)
  const totalVolume = metrics?.totalVolume || 1;
  const realizedPnl = metrics?.realizedPnl || 0;
  const pnlRatio = realizedPnl / totalVolume;
  const pnlScore = Math.min(25, Math.max(-25, pnlRatio * 500));
  score += pnlScore;
  factors.push({ 
    name: 'P&L Efficiency', 
    impact: pnlScore, 
    value: pnlRatio * 100,
    weight: 25,
    description: pnlScore > 0 ? 'Profitable trading' : 'Net losses'
  });

  // Diversification impact (20 points)
  const divScore = Math.min(20, risk.diversificationScore / 5);
  const divImpact = divScore - 20;
  score += divImpact;
  factors.push({ 
    name: 'Diversification', 
    impact: divImpact, 
    value: risk.diversificationScore,
    weight: 20,
    description: divImpact < -10 ? 'Highly concentrated' : divImpact < 0 ? 'Needs improvement' : 'Well diversified'
  });

  // Concentration penalty (15 points)
  const concPenalty = Math.min(15, risk.concentrationScore / 4);
  score -= concPenalty;
  factors.push({ 
    name: 'Concentration Risk', 
    impact: -concPenalty, 
    value: risk.concentrationScore,
    weight: 15,
    description: concPenalty > 10 ? 'Dangerously concentrated' : concPenalty > 5 ? 'Moderate concentration' : 'Acceptable'
  });

  // Drawdown risk (15 points)
  const drawdownPenalty = Math.min(15, risk.maxDrawdownRisk / 3);
  score -= drawdownPenalty;
  factors.push({ 
    name: 'Drawdown Risk', 
    impact: -drawdownPenalty, 
    value: risk.maxDrawdownRisk,
    weight: 15,
    description: drawdownPenalty > 10 ? 'Critical drawdown' : drawdownPenalty > 5 ? 'Elevated risk' : 'Manageable'
  });

  // Profit factor bonus (10 points)
  if (patterns.profitFactor > 0) {
    const profitFactorBonus = Math.min(10, (patterns.profitFactor - 1) * 5);
    score += profitFactorBonus;
    factors.push({ 
      name: 'Profit Factor', 
      impact: profitFactorBonus, 
      value: patterns.profitFactor,
      weight: 10,
      description: patterns.profitFactor > 2 ? 'Excellent' : patterns.profitFactor > 1.5 ? 'Good' : 'Needs improvement'
    });
  }

  // Sharpe ratio bonus (5 points)
  if (patterns.sharpeRatio !== 0) {
    const sharpeBonus = Math.min(5, Math.max(-5, patterns.sharpeRatio * 2));
    score += sharpeBonus;
    factors.push({ 
      name: 'Sharpe Ratio', 
      impact: sharpeBonus, 
      value: patterns.sharpeRatio,
      weight: 5,
      description: patterns.sharpeRatio > 1.5 ? 'Strong risk-adjusted returns' : patterns.sharpeRatio > 1 ? 'Adequate' : 'Poor risk-adjusted returns'
    });
  }

  const finalScore = Math.max(0, Math.min(100, score));

  return {
    score: finalScore,
    grade: getHealthGrade(finalScore),
    factors,
    interpretation: getHealthInterpretation(finalScore),
    actionPriority: getActionPriority(finalScore)
  };
}

function getHealthGrade(score) {
  if (score >= 90) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 80) return 'A-';
  if (score >= 75) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 65) return 'B-';
  if (score >= 60) return 'C+';
  if (score >= 55) return 'C';
  if (score >= 50) return 'C-';
  if (score >= 45) return 'D+';
  if (score >= 40) return 'D';
  return 'F';
}

function getHealthInterpretation(score) {
  if (score >= 90) return 'Exceptional portfolio health. Your trading strategy is working well across all metrics.';
  if (score >= 80) return 'Strong portfolio health. Minor optimizations could improve performance.';
  if (score >= 70) return 'Good portfolio health. Focus on addressing medium-priority recommendations.';
  if (score >= 60) return 'Acceptable portfolio health. Several areas need improvement to optimize returns.';
  if (score >= 50) return 'Below average health. Prioritize high-priority recommendations immediately.';
  if (score >= 40) return 'Poor portfolio health. Significant changes needed to avoid further losses.';
  return 'Critical portfolio health. Stop trading and restructure your entire approach.';
}

function getActionPriority(score) {
  if (score >= 80) return 'low';
  if (score >= 60) return 'medium';
  return 'high';
}

/**
 * Main analysis function
 * Orchestrates all analysis modules and returns comprehensive insights
 */
function analyzeUserProfile(profile, positions, activity, metrics) {
  // Input validation
  if (!Array.isArray(activity)) activity = [];
  if (!Array.isArray(positions)) positions = [];
  if (!metrics) metrics = {};

  const trades = activity.filter(a => a && a.type === 'TRADE');

  const patterns = analyzeTradingPatterns(trades, positions);
  const categoryPerf = analyzeCategoryPerformance(trades, positions);
  const risk = analyzeRiskAndConcentration(positions, metrics);
  const timing = analyzeMarketTiming(trades);
  const recommendations = generateRecommendations(profile, patterns, categoryPerf, risk, timing, metrics);
  const health = calculatePortfolioHealth(metrics, patterns, risk, categoryPerf);

  return {
    patterns,
    categoryPerformance: categoryPerf,
    risk,
    timing,
    recommendations,
    health,
    summary: generateAnalysisSummary(patterns, categoryPerf, risk, health),
    insights: generateKeyInsights(patterns, categoryPerf, risk, timing, health),
    metadata: {
      analyzedAt: new Date().toISOString(),
      totalTrades: trades.length,
      totalPositions: positions.length,
      dataQuality: assessDataQuality(trades, positions, metrics)
    }
  };
}

function generateAnalysisSummary(patterns, categoryPerf, risk, health) {
  const parts = [];

  // Trading style
  if (patterns.scalpingTendency > 0.5) {
    parts.push('Active scalper');
  } else if (patterns.hodlTendency > 0.5) {
    parts.push('Position trader');
  } else if (patterns.swingTendency > 0.5) {
    parts.push('Swing trader');
  } else {
    parts.push('Mixed-style trader');
  }

  // Performance
  if (patterns.winRate > 60) {
    parts.push('high win rate');
  } else if (patterns.winRate > 50) {
    parts.push('moderate win rate');
  } else if (patterns.winRate > 0) {
    parts.push('below-target win rate');
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
  } else {
    parts.push('moderate diversification');
  }

  // Health
  parts.push(`portfolio health: ${health.grade}`);

  // Build improvement list
  const improvements = [];
  
  if (risk.topPositionExposure > 30) {
    improvements.push(`reduce top position from ${risk.topPositionExposure.toFixed(1)}% to <25%`);
  }
  
  if (risk.diversificationScore < 50) {
    improvements.push(`improve diversification from ${risk.diversificationScore.toFixed(0)}% to >60%`);
  }
  
  if (risk.maxDrawdownRisk > 25) {
    improvements.push(`reduce drawdown from ${risk.maxDrawdownRisk.toFixed(1)}% to <20%`);
  }
  
  if (patterns.winRate > 0 && patterns.winRate < 55) {
    improvements.push(`improve win rate from ${patterns.winRate.toFixed(1)}% to >60%`);
  }
  
  if (patterns.tradeFrequency > 10) {
    improvements.push(`reduce trade frequency from ${patterns.tradeFrequency.toFixed(1)}/day to 3-5/day`);
  }

  if (patterns.profitFactor > 0 && patterns.profitFactor < 1.5) {
    improvements.push(`improve profit factor from ${patterns.profitFactor.toFixed(2)} to >2.0`);
  }

  return {
    summary: parts.join(', '),
    improvements: improvements.length > 0 ? improvements : ['Maintain current strategy and monitor performance']
  };
}

/**
 * Generate key insights from analysis
 */
function generateKeyInsights(patterns, categoryPerf, risk, timing, health) {
  const insights = [];

  // Trading style insights
  if (patterns.avgHoldTime > 0) {
    insights.push({
      category: 'Trading Style',
      insight: `Average hold time: ${patterns.avgHoldTime.toFixed(1)} hours. ${
        patterns.scalpingTendency > 0.5 ? 'You prefer quick scalps' :
        patterns.hodlTendency > 0.5 ? 'You prefer long-term holds' :
        'You use swing trading approach'
      }.`,
      positive: patterns.avgHoldTime > 4 && patterns.avgHoldTime < 48
    });
  }

  // Performance insights
  if (patterns.winRate > 0) {
    insights.push({
      category: 'Performance',
      insight: `Win rate of ${patterns.winRate.toFixed(1)}% with ${patterns.profitFactor.toFixed(2)}x profit factor. ${
        patterns.profitFactor > 2 ? 'Excellent risk-reward management' :
        patterns.profitFactor > 1 ? 'Profitable but room for improvement' :
        'Need to improve win size or reduce loss size'
      }.`,
      positive: patterns.winRate > 55 && patterns.profitFactor > 1.5
    });
  }

  // Category insights
  if (categoryPerf.length > 0) {
    const best = categoryPerf[0];
    const worst = categoryPerf[categoryPerf.length - 1];
    
    if (best.pnl > 0) {
      insights.push({
        category: 'Market Selection',
        insight: `${best.category} is your strongest category with ${best.pnl.toFixed(2)} profit and ${best.winRate.toFixed(1)}% win rate across ${best.uniqueMarkets} markets.`,
        positive: true
      });
    }
    
    if (worst.pnl < -50) {
      insights.push({
        category: 'Market Selection',
        insight: `${worst.category} is causing losses: ${worst.pnl.toFixed(2)} with ${worst.winRate.toFixed(1)}% win rate. Consider avoiding this category.`,
        positive: false
      });
    }
  }

  // Risk insights
  if (risk.topPositionExposure > 0) {
    insights.push({
      category: 'Risk Management',
      insight: `Top position: ${risk.topPositionExposure.toFixed(1)}% of portfolio. ${
        risk.topPositionExposure > 30 ? 'Dangerously concentrated - reduce immediately' :
        risk.topPositionExposure > 20 ? 'Slightly overexposed - consider reducing' :
        'Well-sized position'
      }.`,
      positive: risk.topPositionExposure <= 20
    });
  }

  // Timing insights
  if (timing.bestHour !== null) {
    const bestPnl = timing.hourlyPnl[timing.bestHour] || 0;
    if (Math.abs(bestPnl) > 5) {
      insights.push({
        category: 'Timing',
        insight: `Best trading time: ${timing.bestHour}:00 with average ${bestPnl.toFixed(2)} per trade. Focus activity during this window.`,
        positive: bestPnl > 0
      });
    }
  }

  // Health insights
  insights.push({
    category: 'Overall Health',
    insight: `Portfolio health grade: ${health.grade} (${health.score.toFixed(0)}/100). ${health.interpretation}`,
    positive: health.score >= 70
  });

  return insights;
}

/**
 * Assess data quality for analysis reliability
 */
function assessDataQuality(trades, positions, metrics) {
  let quality = 'high';
  const issues = [];

  if (trades.length < 10) {
    quality = 'low';
    issues.push('Insufficient trade history (<10 trades)');
  } else if (trades.length < 30) {
    quality = 'medium';
    issues.push('Limited trade history (10-30 trades)');
  }

  const tradesWithTimestamp = trades.filter(t => t.timestamp).length;
  if (tradesWithTimestamp / trades.length < 0.8) {
    quality = quality === 'high' ? 'medium' : 'low';
    issues.push('Missing timestamps on some trades');
  }

  const tradesWithPrice = trades.filter(t => t.price && t.size).length;
  if (tradesWithPrice / trades.length < 0.9) {
    quality = quality === 'high' ? 'medium' : 'low';
    issues.push('Missing price/size data on some trades');
  }

  if (positions.length === 0) {
    issues.push('No active positions');
  }

  return {
    quality,
    issues,
    completeness: (tradesWithTimestamp / (trades.length || 1)) * 100
  };
}

module.exports = {
  analyzeUserProfile,
  analyzeTradingPatterns,
  analyzeCategoryPerformance,
  analyzeRiskAndConcentration,
  analyzeMarketTiming,
  generateRecommendations,
  calculatePortfolioHealth,
  generateKeyInsights,
  assessDataQuality
};