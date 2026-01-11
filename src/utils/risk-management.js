/**
 * Risk Management Module
 * Provides position concentration limits, sector exposure caps, slippage estimation, and spread impact calculations
 */

/**
 * Calculate position concentration limit
 * Ensures no single position exceeds a percentage of total portfolio
 * @param {number} positionSize - Size of the position in USD
 * @param {number} portfolioValue - Total portfolio value in USD
 * @param {number} maxConcentration - Maximum concentration as decimal (default 0.10 for 10%)
 * @returns {Object} - Object with allowed, adjustedPosition, and reason
 */
function checkPositionConcentration(positionSize, portfolioValue, maxConcentration = 0.10) {
  if (!portfolioValue || portfolioValue <= 0) {
    return {
      allowed: false,
      adjustedPosition: 0,
      reason: 'Invalid portfolio value'
    };
  }

  const concentration = positionSize / portfolioValue;
  const maxAllowedSize = portfolioValue * maxConcentration;

  if (concentration > maxConcentration) {
    return {
      allowed: false,
      adjustedPosition: maxAllowedSize,
      currentConcentration: concentration * 100,
      maxConcentration: maxConcentration * 100,
      reason: `Position concentration ${(concentration * 100).toFixed(2)}% exceeds maximum ${maxConcentration * 100}%`
    };
  }

  return {
    allowed: true,
    adjustedPosition: positionSize,
    currentConcentration: concentration * 100,
    maxConcentration: maxConcentration * 100,
    reason: 'Position within concentration limits'
  };
}

/**
 * Calculate sector exposure cap
 * Ensures total exposure to a sector doesn't exceed a percentage of portfolio
 * @param {Array<Object>} positions - Array of current positions with sector and size
 * @param {string} sector - Sector of the new position
 * @param {number} newPositionSize - Size of new position in USD
 * @param {number} portfolioValue - Total portfolio value in USD
 * @param {number} maxSectorExposure - Maximum sector exposure as decimal (default 0.30 for 30%)
 * @returns {Object} - Object with allowed, adjustedPosition, and reason
 */
function checkSectorExposure(positions, sector, newPositionSize, portfolioValue, maxSectorExposure = 0.30) {
  if (!portfolioValue || portfolioValue <= 0) {
    return {
      allowed: false,
      adjustedPosition: 0,
      reason: 'Invalid portfolio value'
    };
  }

  // Calculate current sector exposure
  const currentSectorExposure = positions
    .filter(p => p.sector === sector)
    .reduce((sum, p) => sum + (p.size || 0), 0);

  const totalSectorExposure = currentSectorExposure + newPositionSize;
  const sectorConcentration = totalSectorExposure / portfolioValue;
  const maxAllowedSectorSize = portfolioValue * maxSectorExposure;

  if (sectorConcentration > maxSectorExposure) {
    const availableSpace = maxAllowedSectorSize - currentSectorExposure;
    return {
      allowed: false,
      adjustedPosition: Math.max(0, availableSpace),
      currentSectorExposure: (currentSectorExposure / portfolioValue) * 100,
      newSectorExposure: sectorConcentration * 100,
      maxSectorExposure: maxSectorExposure * 100,
      reason: `Sector ${sector} exposure ${(sectorConcentration * 100).toFixed(2)}% exceeds maximum ${maxSectorExposure * 100}%`
    };
  }

  return {
    allowed: true,
    adjustedPosition: newPositionSize,
    currentSectorExposure: (currentSectorExposure / portfolioValue) * 100,
    newSectorExposure: sectorConcentration * 100,
    maxSectorExposure: maxSectorExposure * 100,
    reason: `Sector ${sector} exposure within limits`
  };
}

/**
 * Estimate slippage for a trade
 * Calculates expected price impact based on trade size and liquidity
 * @param {number} tradeSize - Trade size in USD
 * @param {number} liquidity - Market liquidity in USD
 * @param {number} price - Current market price
 * @param {string} side - Trade side ('BUY' or 'SELL')
 * @returns {Object} - Object with slippagePercent, adjustedPrice, and executionPrice
 */
function estimateSlippage(tradeSize, liquidity, price, side = 'BUY') {
  if (!liquidity || liquidity <= 0) {
    return {
      slippagePercent: 10, // 10% slippage for illiquid markets
      adjustedPrice: side === 'BUY' ? price * 1.10 : price * 0.90,
      executionPrice: side === 'BUY' ? price * 1.10 : price * 0.90,
      reason: 'No liquidity data, assuming 10% slippage'
    };
  }

  // Calculate trade impact ratio
  const impactRatio = tradeSize / liquidity;
  
  // Slippage model: exponential increase with trade size
  // Small trades (<1% of liquidity): minimal slippage
  // Medium trades (1-5%): linear increase
  // Large trades (>5%): exponential increase
  let slippagePercent;
  
  if (impactRatio < 0.01) {
    // Less than 1% of liquidity: 0.1% - 0.5% slippage
    slippagePercent = 0.1 + (impactRatio * 40);
  } else if (impactRatio < 0.05) {
    // 1-5% of liquidity: 0.5% - 2% slippage
    slippagePercent = 0.5 + ((impactRatio - 0.01) * 37.5);
  } else if (impactRatio < 0.10) {
    // 5-10% of liquidity: 2% - 5% slippage
    slippagePercent = 2 + ((impactRatio - 0.05) * 60);
  } else if (impactRatio < 0.20) {
    // 10-20% of liquidity: 5% - 10% slippage
    slippagePercent = 5 + ((impactRatio - 0.10) * 50);
  } else {
    // >20% of liquidity: 10%+ slippage (exponential)
    slippagePercent = 10 + Math.pow(impactRatio - 0.20, 2) * 100;
  }

  // Cap slippage at 50% for extreme cases
  slippagePercent = Math.min(50, slippagePercent);

  // Calculate adjusted price
  const slippageMultiplier = slippagePercent / 100;
  let adjustedPrice, executionPrice;

  if (side === 'BUY') {
    adjustedPrice = price * (1 + slippageMultiplier);
    executionPrice = adjustedPrice;
  } else {
    adjustedPrice = price * (1 - slippageMultiplier);
    executionPrice = adjustedPrice;
  }

  return {
    slippagePercent: Number(slippagePercent.toFixed(2)),
    adjustedPrice: Number(adjustedPrice.toFixed(6)),
    executionPrice: Number(executionPrice.toFixed(6)),
    impactRatio: Number(impactRatio.toFixed(4)),
    reason: `Trade is ${impactRatio.toFixed(2)}% of market liquidity`
  };
}

/**
 * Calculate spread impact on trade
 * Accounts for bid-ask spread in trade execution
 * @param {number} spread - Bid-ask spread in percentage
 * @param {number} tradeSize - Trade size in USD
 * @param {number} price - Mid price
 * @param {string} side - Trade side ('BUY' or 'SELL')
 * @returns {Object} - Object with spreadCost, adjustedPrice, and effectivePrice
 */
function calculateSpreadImpact(spread, tradeSize, price, side = 'BUY') {
  if (!spread || spread <= 0) {
    return {
      spreadCost: 0,
      adjustedPrice: price,
      effectivePrice: price,
      reason: 'No spread data'
    };
  }

  const spreadMultiplier = spread / 200; // Half spread for each side
  const spreadCost = tradeSize * spreadMultiplier;

  let adjustedPrice, effectivePrice;

  if (side === 'BUY') {
    adjustedPrice = price * (1 + spreadMultiplier);
    effectivePrice = adjustedPrice;
  } else {
    adjustedPrice = price * (1 - spreadMultiplier);
    effectivePrice = adjustedPrice;
  }

  return {
    spreadCost: Number(spreadCost.toFixed(2)),
    adjustedPrice: Number(adjustedPrice.toFixed(6)),
    effectivePrice: Number(effectivePrice.toFixed(6)),
    spreadPercent: Number(spread.toFixed(2)),
    reason: `Bid-ask spread is ${spread.toFixed(2)}%`
  };
}

/**
 * Calculate total trade cost including slippage and spread
 * @param {number} tradeSize - Trade size in USD
 * @param {number} liquidity - Market liquidity in USD
 * @param {number} price - Current market price
 * @param {number} spread - Bid-ask spread in percentage
 * @param {string} side - Trade side ('BUY' or 'SELL')
 * @returns {Object} - Object with totalCost, slippage, spread, and effectivePrice
 */
function calculateTotalTradeCost(tradeSize, liquidity, price, spread, side = 'BUY') {
  const slippageResult = estimateSlippage(tradeSize, liquidity, price, side);
  const spreadResult = calculateSpreadImpact(spread, tradeSize, slippageResult.adjustedPrice, side);

  // Total cost = slippage cost + spread cost
  const slippageCost = Math.abs(price - slippageResult.adjustedPrice) * (tradeSize / price);
  const spreadCost = spreadResult.spreadCost;
  const totalCost = slippageCost + spreadCost;

  return {
    totalCost: Number(totalCost.toFixed(2)),
    slippageCost: Number(slippageCost.toFixed(2)),
    spreadCost: Number(spreadCost.toFixed(2)),
    slippage: slippageResult,
    spread: spreadResult,
    effectivePrice: spreadResult.effectivePrice,
    totalCostPercent: Number((totalCost / tradeSize * 100).toFixed(2))
  };
}

/**
 * Check if trade passes all risk limits
 * @param {Object} trade - Trade object with size, sector, etc.
 * @param {Object} portfolio - Portfolio object with value and positions
 * @param {Object} market - Market object with liquidity and spread
 * @param {Object} config - Risk configuration
 * @returns {Object} - Object with allowed, adjustments, and violations
 */
function checkTradeRisk(trade, portfolio, market, config = {}) {
  const {
    maxConcentration = 0.10,
    maxSectorExposure = 0.30,
    maxSlippage = 5,
    maxSpread = 2
  } = config;

  const violations = [];
  const adjustments = {};

  // 1. Check position concentration
  const concentrationCheck = checkPositionConcentration(
    trade.size,
    portfolio.value,
    maxConcentration
  );
  if (!concentrationCheck.allowed) {
    violations.push({
      type: 'concentration',
      reason: concentrationCheck.reason,
      current: concentrationCheck.currentConcentration,
      limit: concentrationCheck.maxConcentration
    });
    adjustments.adjustedSize = concentrationCheck.adjustedPosition;
  }

  // 2. Check sector exposure
  const sectorCheck = checkSectorExposure(
    portfolio.positions || [],
    trade.sector,
    trade.size,
    portfolio.value,
    maxSectorExposure
  );
  if (!sectorCheck.allowed) {
    violations.push({
      type: 'sector_exposure',
      reason: sectorCheck.reason,
      current: sectorCheck.currentSectorExposure,
      limit: sectorCheck.maxSectorExposure
    });
    adjustments.adjustedSize = Math.min(
      adjustments.adjustedSize || trade.size,
      sectorCheck.adjustedPosition
    );
  }

  // 3. Check slippage
  const slippageCheck = estimateSlippage(
    trade.size,
    market.liquidity,
    trade.price,
    trade.side
  );
  if (slippageCheck.slippagePercent > maxSlippage) {
    violations.push({
      type: 'slippage',
      reason: `Slippage ${slippageCheck.slippagePercent}% exceeds maximum ${maxSlippage}%`,
      current: slippageCheck.slippagePercent,
      limit: maxSlippage
    });
  }

  // 4. Check spread
  if (market.spread && market.spread > maxSpread) {
    violations.push({
      type: 'spread',
      reason: `Spread ${market.spread}% exceeds maximum ${maxSpread}%`,
      current: market.spread,
      limit: maxSpread
    });
  }

  // Calculate total trade cost
  const totalCost = calculateTotalTradeCost(
    trade.size,
    market.liquidity,
    trade.price,
    market.spread || 0,
    trade.side
  );

  return {
    allowed: violations.length === 0,
    violations,
    adjustments,
    slippage: slippageCheck,
    totalCost,
    recommendedSize: adjustments.adjustedSize || trade.size
  };
}

/**
 * Calculate portfolio-level risk metrics
 * @param {Array<Object>} positions - Array of positions
 * @param {number} portfolioValue - Total portfolio value
 * @returns {Object} - Portfolio risk metrics
 */
function calculatePortfolioRisk(positions, portfolioValue) {
  if (!portfolioValue || portfolioValue <= 0) {
    return {
      concentration: 0,
      sectorDiversification: 0,
      maxPositionSize: 0,
      sectorExposure: {}
    };
  }

  // Calculate position concentrations
  const positionConcentrations = positions.map(p => ({
    id: p.id,
    size: p.size,
    concentration: (p.size / portfolioValue) * 100
  }));

  // Calculate sector exposure
  const sectorExposure = {};
  positions.forEach(p => {
    const sector = p.sector || 'UNKNOWN';
    sectorExposure[sector] = (sectorExposure[sector] || 0) + p.size;
  });

  Object.keys(sectorExposure).forEach(sector => {
    sectorExposure[sector] = (sectorExposure[sector] / portfolioValue) * 100;
  });

  // Calculate diversification score (inverse of Herfindahl-Hirschman Index)
  const sectorShares = Object.values(sectorExposure).map(s => s / 100);
  const hhi = sectorShares.reduce((sum, s) => sum + s * s, 0);
  const diversification = (1 - hhi) * 100;

  return {
    concentration: positionConcentrations,
    sectorExposure,
    sectorDiversification: Number(diversification.toFixed(2)),
    maxPositionSize: Math.max(...positionConcentrations.map(p => p.concentration), 0),
    positionCount: positions.length,
    sectorCount: Object.keys(sectorExposure).length
  };
}

module.exports = {
  checkPositionConcentration,
  checkSectorExposure,
  estimateSlippage,
  calculateSpreadImpact,
  calculateTotalTradeCost,
  checkTradeRisk,
  calculatePortfolioRisk
};
