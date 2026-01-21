/**
 * Hypothetical P&L Module
 * Calculates what P&L would have been if signals were followed with given position sizing
 */

/**
 * Calculate hypothetical P&L for a signal
 * @param {Object} signal - Signal object with predictedProbability, marketOdds, outcome
 * @param {number} positionSize - Position size in USD
 * @param {string} side - 'YES' or 'NO' (default: based on prediction)
 * @returns {Object} - P&L calculation result
 */
function calculateSignalPnL(signal, positionSize = 100, side = null) {
  if (!signal || !signal.marketOdds) {
    return {
      positionSize,
      side: null,
      entryPrice: 0,
      exitPrice: 0,
      pnl: 0,
      pnlPercent: 0,
      outcome: 'UNKNOWN',
      settled: false,
      brierScore: null
    };
  }

  // Determine side based on prediction if not specified
  const tradeSide = side || (signal.predictedProbability > 0.5 ? 'YES' : 'NO');
  
  // Entry price (market odds at signal time)
  const entryPrice = signal.marketOdds;
  
  // Calculate Brier score (probability calibration metric)
  let brierScore = null;
  if (signal.outcome && typeof signal.predictedProbability === 'number') {
    const actualOutcome = signal.outcome === 'YES' ? 1 : 0;
    brierScore = Math.pow(signal.predictedProbability - actualOutcome, 2);
  }
  
  // If not settled, return pending
  if (!signal.outcome) {
    return {
      positionSize,
      side: tradeSide,
      entryPrice,
      exitPrice: entryPrice,
      pnl: 0,
      pnlPercent: 0,
      outcome: 'PENDING',
      settled: false,
      brierScore
    };
  }

  // Calculate exit price based on outcome
  // If YES wins and we bought YES, price goes to 1.00
  // If NO wins and we bought NO, price goes to 1.00
  // Otherwise price goes to 0.00
  let exitPrice;
  if (signal.outcome === 'YES') {
    exitPrice = tradeSide === 'YES' ? 1.00 : 0.00;
  } else {
    exitPrice = tradeSide === 'NO' ? 1.00 : 0.00;
  }

  // Calculate P&L
  // For YES: (exit - entry) / entry * position
  // For NO: (exit - (1 - entry)) / (1 - entry) * position
  let pnl;
  if (tradeSide === 'YES') {
    pnl = ((exitPrice - entryPrice) / entryPrice) * positionSize;
  } else {
    const noEntryPrice = 1 - entryPrice;
    const noExitPrice = exitPrice === 1.00 ? 1.00 : 0.00;
    pnl = ((noExitPrice - noEntryPrice) / noEntryPrice) * positionSize;
  }

  const pnlPercent = (pnl / positionSize) * 100;

  return {
    positionSize,
    side: tradeSide,
    entryPrice: Number(entryPrice.toFixed(4)),
    exitPrice: Number(exitPrice.toFixed(4)),
    pnl: Number(pnl.toFixed(2)),
    pnlPercent: Number(pnlPercent.toFixed(2)),
    outcome: signal.outcome,
    settled: true,
    correct: (tradeSide === 'YES' && signal.outcome === 'YES') || (tradeSide === 'NO' && signal.outcome === 'NO'),
    brierScore: Number(brierScore?.toFixed(4) || 0)
  };
}

/**
 * Calculate aggregate P&L for multiple signals
 * @param {Array<Object>} signals - Array of signal objects
 * @param {number} positionSize - Position size per signal in USD
 * @returns {Object} - Aggregate P&L metrics
 */
function calculateAggregatePnL(signals, positionSize = 100) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return {
      totalSignals: 0,
      settledSignals: 0,
      pendingSignals: 0,
      totalPnL: 0,
      totalPnLPercent: 0,
      winningSignals: 0,
      losingSignals: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      maxWin: 0,
      maxLoss: 0,
      sharpeRatio: 0,
      trades: []
    };
  }

  const trades = signals.map(signal => calculateSignalPnL(signal, positionSize));
  const settledTrades = trades.filter(t => t.settled);
  const pendingTrades = trades.filter(t => !t.settled);

  const totalPnL = settledTrades.reduce((sum, t) => sum + t.pnl, 0);
  const totalPnLPercent = settledTrades.length > 0 
    ? settledTrades.reduce((sum, t) => sum + t.pnlPercent, 0) / settledTrades.length 
    : 0;

  const winningTrades = settledTrades.filter(t => t.pnl > 0);
  const losingTrades = settledTrades.filter(t => t.pnl < 0);
  const winRate = settledTrades.length > 0 ? winningTrades.length / settledTrades.length : 0;

  const avgWin = winningTrades.length > 0 
    ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length 
    : 0;
  const avgLoss = losingTrades.length > 0 
    ? losingTrades.reduce((sum, t) => sum + Math.abs(t.pnl), 0) / losingTrades.length 
    : 0;

  const totalProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
  const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

  const maxWin = winningTrades.length > 0 
    ? Math.max(...winningTrades.map(t => t.pnl)) 
    : 0;
  const maxLoss = losingTrades.length > 0 
    ? Math.min(...losingTrades.map(t => t.pnl)) 
    : 0;

  // Calculate aggregate Brier score (lower is better, <0.2 is excellent)
  const validBrierScores = settledTrades.map(t => t.brierScore).filter(score => score !== null && !isNaN(score));
  const avgBrierScore = validBrierScores.length > 0 
    ? validBrierScores.reduce((sum, score) => sum + score, 0) / validBrierScores.length 
    : 0;

  // Calculate Sharpe Ratio
  const returns = settledTrades.map(t => t.pnlPercent / 100);
  const sharpeRatio = returns.length > 1 
    ? calculateSharpeRatioFromReturns(returns) 
    : 0;

  // Calculate rolling metrics (30d/60d/90d windows)
  const now = Date.now();
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = now - (60 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000);

  const calculateWindowMetrics = (since) => {
    const windowTrades = settledTrades.filter(t => {
      const tradeTime = new Date(t.settled ? t.settled : now).getTime();
      return tradeTime >= since;
    });
    
    if (windowTrades.length === 0) {
      return { roi: 0, winRate: 0, sharpe: 0 };
    }

    const windowPnL = windowTrades.reduce((sum, t) => sum + t.pnl, 0);
    const windowWinners = windowTrades.filter(t => t.pnl > 0);
    const windowWinRate = windowWinners.length / windowTrades.length;
    const windowReturns = windowTrades.map(t => t.pnlPercent / 100);
    const windowSharpe = windowReturns.length > 1 
      ? calculateSharpeRatioFromReturns(windowReturns) 
      : 0;

    return {
      roi: Number((windowPnL / (windowTrades.length * positionSize) * 100).toFixed(2)),
      winRate: Number(windowWinRate.toFixed(4)),
      sharpe: Number(windowSharpe.toFixed(3))
    };
  };

  const rollingMetrics = {
    '30d': calculateWindowMetrics(thirtyDaysAgo),
    '60d': calculateWindowMetrics(sixtyDaysAgo),
    '90d': calculateWindowMetrics(ninetyDaysAgo)
  };

  // Calculate benchmark (buy-and-hold comparison)
  const calculateBenchmark = () => {
    if (settledTrades.length === 0) {
      return { buyAndHold: 0, zigmaAlpha: 0, alphaPercent: 0 };
    }

    // Simulate buy-and-hold: random 50/50 on each trade
    const buyAndHoldTrades = settledTrades.map(t => {
      const randomSide = Math.random() > 0.5 ? 'YES' : 'NO';
      let exitPrice;
      if (t.outcome === 'YES') {
        exitPrice = randomSide === 'YES' ? 1.00 : 0.00;
      } else {
        exitPrice = randomSide === 'NO' ? 1.00 : 0.00;
      }
      
      let pnl;
      if (randomSide === 'YES') {
        pnl = ((exitPrice - t.entryPrice) / t.entryPrice) * positionSize;
      } else {
        const noEntryPrice = 1 - t.entryPrice;
        const noExitPrice = exitPrice === 1.00 ? 1.00 : 0.00;
        pnl = ((noExitPrice - noEntryPrice) / noEntryPrice) * positionSize;
      }
      return pnl;
    });

    const buyAndHoldPnL = buyAndHoldTrades.reduce((sum, pnl) => sum + pnl, 0);
    const buyAndHoldRoi = (buyAndHoldPnL / (settledTrades.length * positionSize)) * 100;
    const zigmaAlpha = totalPnL;
    const alphaPercent = buyAndHoldRoi !== 0 
      ? ((totalPnL - buyAndHoldPnL) / Math.abs(buyAndHoldPnL)) * 100 
      : totalPnL > 0 ? 100 : -100;

    return {
      buyAndHold: Number(buyAndHoldRoi.toFixed(2)),
      zigmaAlpha: Number((totalPnL / (settledTrades.length * positionSize) * 100).toFixed(2)),
      alphaPercent: Number(alphaPercent.toFixed(2))
    };
  };

  const benchmark = calculateBenchmark();

  // Format detailed trades for frontend
  const detailedTrades = trades.map(t => ({
    market: signals.find(s => s.marketOdds === t.entryPrice)?.question || 'Unknown Market',
    action: t.side === 'YES' ? 'BUY YES' : 'BUY NO',
    entryPrice: Number(t.entryPrice.toFixed(6)),
    exitPrice: Number(t.exitPrice.toFixed(6)),
    pnl: Number(t.pnl.toFixed(2)),
    roi: Number(t.pnlPercent.toFixed(2)),
    edge: 0, // Will need to be calculated from signal data
    confidence: 0, // Will need to be calculated from signal data
    timestamp: new Date().toISOString(),
    outcome: t.pnl > 0 ? 'WIN' : t.pnl < 0 ? 'LOSS' : 'PENDING'
  }));

  return {
    totalSignals: signals.length,
    settledSignals: settledTrades.length,
    pendingSignals: pendingTrades.length,
    totalPnL: Number(totalPnL.toFixed(2)),
    totalPnLPercent: Number(totalPnLPercent.toFixed(2)),
    winningSignals: winningTrades.length,
    losingSignals: losingTrades.length,
    winRate: Number(winRate.toFixed(4)),
    avgWin: Number(avgWin.toFixed(2)),
    avgLoss: Number(avgLoss.toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2)),
    maxWin: Number(maxWin.toFixed(2)),
    maxLoss: Number(maxLoss.toFixed(2)),
    sharpeRatio: Number(sharpeRatio.toFixed(3)),
    avgBrierScore: Number(avgBrierScore.toFixed(4)),
    rollingMetrics,
    benchmark,
    trades: detailedTrades
  };
}

/**
 * Calculate Sharpe Ratio from returns array
 * @param {Array<number>} returns - Array of returns as decimals
 * @returns {number} - Sharpe Ratio
 */
function calculateSharpeRatioFromReturns(returns) {
  if (returns.length < 2) return 0;

  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  
  if (stdDev === 0) return 0;

  // Assume 0% risk-free rate for simplicity
  return avgReturn / stdDev;
}

/**
 * Calculate P&L by category
 * @param {Array<Object>} signals - Array of signal objects
 * @param {number} positionSize - Position size per signal in USD
 * @returns {Object} - P&L by category
 */
function calculatePnLByCategory(signals, positionSize = 100) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return {};
  }

  const categoryPnL = {};

  signals.forEach(signal => {
    const category = signal.category || 'UNKNOWN';
    if (!categoryPnL[category]) {
      categoryPnL[category] = {
        totalSignals: 0,
        settledSignals: 0,
        totalPnL: 0,
        winRate: 0,
        avgEdge: 0
      };
    }

    categoryPnL[category].totalSignals++;
    categoryPnL[category].avgEdge += signal.edge || 0;

    const pnl = calculateSignalPnL(signal, positionSize);
    if (pnl.settled) {
      categoryPnL[category].settledSignals++;
      categoryPnL[category].totalPnL += pnl.pnl;
    }
  });

  // Calculate derived metrics
  Object.keys(categoryPnL).forEach(category => {
    const stats = categoryPnL[category];
    stats.avgEdge = stats.totalSignals > 0 ? stats.avgEdge / stats.totalSignals : 0;
    
    // Calculate win rate for this category
    const categorySignals = signals.filter(s => (s.category || 'UNKNOWN') === category);
    const settledCategorySignals = categorySignals.filter(s => s.outcome);
    const correctCategorySignals = settledCategorySignals.filter(s => {
      const predictedYes = s.predictedProbability > 0.5;
      const actualYes = s.outcome === 'YES';
      return predictedYes === actualYes;
    });
    stats.winRate = settledCategorySignals.length > 0 
      ? correctCategorySignals.length / settledCategorySignals.length 
      : 0;

    stats.totalPnL = Number(stats.totalPnL.toFixed(2));
    stats.avgEdge = Number(stats.avgEdge.toFixed(2));
    stats.winRate = Number(stats.winRate.toFixed(4));
  });

  return categoryPnL;
}

/**
 * Calculate equity curve over time
 * @param {Array<Object>} signals - Array of signal objects with timestamps
 * @param {number} positionSize - Position size per signal in USD
 * @param {number} initialCapital - Starting capital
 * @returns {Array<Object>} - Equity curve points
 */
function calculateEquityCurve(signals, positionSize = 100, initialCapital = 1000) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return [{ timestamp: Date.now(), equity: initialCapital, trades: 0 }];
  }

  // Sort signals by timestamp
  const sortedSignals = [...signals].sort((a, b) => 
    new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime()
  );

  const equityCurve = [];
  let currentEquity = initialCapital;
  let tradeCount = 0;

  // Add initial point
  equityCurve.push({
    timestamp: sortedSignals[0].timestamp || Date.now(),
    equity: initialCapital,
    trades: 0
  });

  sortedSignals.forEach(signal => {
    const pnl = calculateSignalPnL(signal, positionSize);
    
    if (pnl.settled) {
      currentEquity += pnl.pnl;
      tradeCount++;
    }

    equityCurve.push({
      timestamp: signal.timestamp || Date.now(),
      equity: Number(currentEquity.toFixed(2)),
      trades: tradeCount
    });
  });

  return equityCurve;
}

module.exports = {
  calculateSignalPnL,
  calculateAggregatePnL,
  calculatePnLByCategory,
  calculateEquityCurve
};
