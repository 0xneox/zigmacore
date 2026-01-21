/**
 * Order Book Integration Module
 * Fetches real-time order book data for accurate slippage estimation
 * Integrates with Polymarket's CLOB (Central Limit Order Book)
 */

const axios = require('axios');

const CLOB_API = process.env.CLOB_API_URL || 'https://clob.polymarket.com';
const GAMMA_API = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';

// Cache for order book data
const orderBookCache = new Map();
const CACHE_TTL_MS = 5000; // 5 seconds - order books change fast

/**
 * Fetch order book for a specific market
 * @param {string} tokenId - The token ID (YES or NO token)
 * @returns {Object} - Order book with bids and asks
 */
async function fetchOrderBook(tokenId) {
  // Check cache
  const cached = orderBookCache.get(tokenId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  
  try {
    const response = await axios.get(`${CLOB_API}/book`, {
      params: { token_id: tokenId },
      timeout: 5000,
      headers: {
        'User-Agent': 'Oracle-of-Poly/1.0'
      }
    });
    
    const orderBook = {
      bids: (response.data.bids || []).map(b => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size)
      })).sort((a, b) => b.price - a.price), // Highest bid first
      
      asks: (response.data.asks || []).map(a => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size)
      })).sort((a, b) => a.price - b.price), // Lowest ask first
      
      timestamp: Date.now()
    };
    
    // Cache it
    orderBookCache.set(tokenId, {
      data: orderBook,
      timestamp: Date.now()
    });
    
    return orderBook;
    
  } catch (error) {
    console.error(`[ORDERBOOK] Failed to fetch for ${tokenId}:`, error.message);
    return { bids: [], asks: [], timestamp: Date.now(), error: error.message };
  }
}

/**
 * Fetch order book by market slug or condition ID
 * @param {string} marketIdOrSlug - Market slug or condition ID
 * @returns {Object} - Order books for YES and NO tokens
 */
async function fetchMarketOrderBooks(marketIdOrSlug) {
  try {
    // First get market details from Gamma to extract token IDs
    const marketResponse = await axios.get(`${GAMMA_API}/markets?slug=${marketIdOrSlug}`, {
      timeout: 5000
    });
    
    let market = marketResponse.data;
    
    // If array returned, take first result
    if (Array.isArray(market)) {
      market = market[0];
    }
    
    if (!market) {
      // Try by condition ID
      const byIdResponse = await axios.get(`${GAMMA_API}/markets/${marketIdOrSlug}`, {
        timeout: 5000
      });
      market = byIdResponse.data;
    }
    
    if (!market) {
      console.error(`[ORDERBOOK] Market not found: ${marketIdOrSlug}`);
      return { yes: { bids: [], asks: [] }, no: { bids: [], asks: [] }, error: 'Market not found' };
    }
    
    // Parse clobTokenIds if it's a JSON string
    let tokens = market.clobTokenIds || market.tokens || [];
    if (typeof tokens === 'string') {
      try {
        tokens = JSON.parse(tokens);
      } catch (e) {
        console.error(`[ORDERBOOK] Failed to parse clobTokenIds: ${tokens}`);
        tokens = [];
      }
    }
    
    // Polymarket tokens: index 0 = YES, index 1 = NO
    const yesTokenId = tokens[0]?.token_id || tokens[0];
    const noTokenId = tokens[1]?.token_id || tokens[1];
    
    if (!yesTokenId) {
      console.error(`[ORDERBOOK] No token IDs for market: ${marketIdOrSlug}`);
      return { yes: { bids: [], asks: [] }, no: { bids: [], asks: [] }, error: 'No token IDs' };
    }
    
    const [yesBook, noBook] = await Promise.all([
      yesTokenId ? fetchOrderBook(yesTokenId) : { bids: [], asks: [] },
      noTokenId ? fetchOrderBook(noTokenId) : { bids: [], asks: [] }
    ]);
    
    return {
      yes: yesBook,
      no: noBook,
      market: {
        conditionId: market.conditionId,
        question: market.question,
        tokens: [yesTokenId, noTokenId]
      }
    };
    
  } catch (error) {
    console.error(`[ORDERBOOK] Failed to fetch market ${marketIdOrSlug}:`, error.message);
    return {
      yes: { bids: [], asks: [] },
      no: { bids: [], asks: [] },
      error: error.message
    };
  }
}

/**
 * Calculate real slippage for a trade using order book
 * @param {Object} orderBook - Order book with bids and asks
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} size - Trade size in dollars
 * @returns {Object} - Slippage analysis
 */
function calculateRealSlippage(orderBook, side, size) {
  const orders = side === 'BUY' ? orderBook.asks : orderBook.bids;
  
  if (!orders || orders.length === 0) {
    return {
      canExecute: false,
      reason: 'No liquidity on this side',
      slippagePercent: null,
      avgPrice: null
    };
  }
  
  const bestPrice = orders[0].price;
  let remainingSize = size;
  let totalCost = 0;
  let totalShares = 0;
  const fills = [];
  
  for (const order of orders) {
    if (remainingSize <= 0) break;
    
    const sharePrice = order.price;
    const availableShares = order.size;
    const availableDollars = availableShares * sharePrice;
    
    const fillDollars = Math.min(remainingSize, availableDollars);
    const fillShares = fillDollars / sharePrice;
    
    fills.push({
      price: sharePrice,
      shares: fillShares,
      dollars: fillDollars
    });
    
    totalCost += fillDollars;
    totalShares += fillShares;
    remainingSize -= fillDollars;
  }
  
  if (remainingSize > 0) {
    return {
      canExecute: false,
      reason: `Insufficient liquidity: only $${(size - remainingSize).toFixed(2)} available of $${size}`,
      partialFill: {
        filled: size - remainingSize,
        unfilled: remainingSize,
        fillPercent: ((size - remainingSize) / size * 100).toFixed(1)
      },
      fills
    };
  }
  
  const avgPrice = totalCost / totalShares;
  const slippagePercent = ((avgPrice - bestPrice) / bestPrice) * 100 * (side === 'BUY' ? 1 : -1);
  
  return {
    canExecute: true,
    bestPrice: Number(bestPrice.toFixed(4)),
    avgPrice: Number(avgPrice.toFixed(4)),
    worstPrice: Number(fills[fills.length - 1].price.toFixed(4)),
    slippagePercent: Number(Math.abs(slippagePercent).toFixed(3)),
    totalShares: Number(totalShares.toFixed(2)),
    totalCost: Number(totalCost.toFixed(2)),
    fills,
    depthLevels: fills.length
  };
}

/**
 * Get bid-ask spread from order book
 * @param {Object} orderBook - Order book with bids and asks
 * @returns {Object} - Spread analysis
 */
function getSpread(orderBook) {
  const { bids, asks } = orderBook;
  
  if (!bids || bids.length === 0 || !asks || asks.length === 0) {
    return {
      hasSpread: false,
      reason: 'Missing bid or ask side'
    };
  }
  
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const midPrice = (bestBid + bestAsk) / 2;
  const spreadAbsolute = bestAsk - bestBid;
  const spreadPercent = (spreadAbsolute / midPrice) * 100;
  
  return {
    hasSpread: true,
    bestBid: Number(bestBid.toFixed(4)),
    bestAsk: Number(bestAsk.toFixed(4)),
    midPrice: Number(midPrice.toFixed(4)),
    spreadAbsolute: Number(spreadAbsolute.toFixed(4)),
    spreadPercent: Number(spreadPercent.toFixed(2)),
    isWide: spreadPercent > 2, // >2% is wide
    isTight: spreadPercent < 0.5 // <0.5% is tight
  };
}

/**
 * Calculate market depth at various price levels
 * @param {Object} orderBook - Order book with bids and asks
 * @param {Array} priceDeltas - Price deltas to check (e.g., [0.01, 0.02, 0.05])
 * @returns {Object} - Depth analysis
 */
function calculateMarketDepth(orderBook, priceDeltas = [0.01, 0.02, 0.05, 0.10]) {
  const { bids, asks } = orderBook;
  const spread = getSpread(orderBook);
  
  if (!spread.hasSpread) {
    return { hasDepth: false, reason: spread.reason };
  }
  
  const midPrice = spread.midPrice;
  const depth = {
    bids: {},
    asks: {},
    total: {}
  };
  
  for (const delta of priceDeltas) {
    // Bid depth (within delta below mid)
    const bidThreshold = midPrice - delta;
    const bidDepth = bids
      .filter(b => b.price >= bidThreshold)
      .reduce((sum, b) => sum + (b.price * b.size), 0);
    
    // Ask depth (within delta above mid)
    const askThreshold = midPrice + delta;
    const askDepth = asks
      .filter(a => a.price <= askThreshold)
      .reduce((sum, a) => sum + (a.price * a.size), 0);
    
    depth.bids[`${(delta * 100).toFixed(0)}%`] = Number(bidDepth.toFixed(2));
    depth.asks[`${(delta * 100).toFixed(0)}%`] = Number(askDepth.toFixed(2));
    depth.total[`${(delta * 100).toFixed(0)}%`] = Number((bidDepth + askDepth).toFixed(2));
  }
  
  // Calculate imbalance
  const totalBids = bids.reduce((sum, b) => sum + (b.price * b.size), 0);
  const totalAsks = asks.reduce((sum, a) => sum + (a.price * a.size), 0);
  const imbalance = (totalBids - totalAsks) / (totalBids + totalAsks);
  
  return {
    hasDepth: true,
    depth,
    totalBidLiquidity: Number(totalBids.toFixed(2)),
    totalAskLiquidity: Number(totalAsks.toFixed(2)),
    imbalance: Number(imbalance.toFixed(3)),
    imbalanceDirection: imbalance > 0.1 ? 'BID_HEAVY' : imbalance < -0.1 ? 'ASK_HEAVY' : 'BALANCED'
  };
}

/**
 * Get optimal entry price recommendation
 * @param {Object} orderBook - Order book
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} size - Trade size in dollars
 * @returns {Object} - Entry recommendation
 */
function getOptimalEntry(orderBook, side, size) {
  const spread = getSpread(orderBook);
  const slippage = calculateRealSlippage(orderBook, side, size);
  
  if (!spread.hasSpread || !slippage.canExecute) {
    return {
      canTrade: false,
      reason: spread.reason || slippage.reason
    };
  }
  
  // Determine if market order or limit order is better
  const marketOrderCost = slippage.totalCost;
  const limitPrice = side === 'BUY' ? spread.midPrice : spread.midPrice;
  
  // Estimate fill probability for limit order at mid
  const depth = calculateMarketDepth(orderBook);
  const fillProbability = side === 'BUY' 
    ? (depth.imbalance < 0 ? 0.7 : 0.4) // More asks = higher chance bid fills
    : (depth.imbalance > 0 ? 0.7 : 0.4); // More bids = higher chance ask fills
  
  return {
    canTrade: true,
    recommendation: slippage.slippagePercent > 1 ? 'USE_LIMIT_ORDER' : 'MARKET_ORDER_OK',
    marketOrder: {
      price: slippage.avgPrice,
      slippage: slippage.slippagePercent,
      certainty: 100
    },
    limitOrder: {
      suggestedPrice: Number(limitPrice.toFixed(4)),
      estimatedFillProbability: Number((fillProbability * 100).toFixed(0)),
      potentialSavings: Number(((slippage.avgPrice - limitPrice) / limitPrice * 100).toFixed(2))
    },
    spread,
    depth: depth.imbalanceDirection
  };
}

/**
 * Check if market has sufficient liquidity for a trade
 * @param {string} conditionId - Market condition ID
 * @param {string} side - 'BUY_YES', 'BUY_NO', 'SELL_YES', 'SELL_NO'
 * @param {number} size - Trade size in dollars
 * @returns {Object} - Liquidity check result
 */
async function checkTradeLiquidity(conditionId, side, size) {
  const books = await fetchMarketOrderBooks(conditionId);
  
  if (books.error) {
    return { sufficient: false, reason: books.error };
  }
  
  // Determine which book and direction
  let orderBook, direction;
  if (side === 'BUY_YES' || side === 'SELL_NO') {
    orderBook = books.yes;
    direction = side === 'BUY_YES' ? 'BUY' : 'SELL';
  } else {
    orderBook = books.no;
    direction = side === 'BUY_NO' ? 'BUY' : 'SELL';
  }
  
  const slippage = calculateRealSlippage(orderBook, direction, size);
  const spread = getSpread(orderBook);
  const depth = calculateMarketDepth(orderBook);
  
  const sufficient = slippage.canExecute && slippage.slippagePercent < 5;
  
  return {
    sufficient,
    slippage: slippage.canExecute ? slippage.slippagePercent : null,
    spread: spread.spreadPercent,
    depth: depth.totalBidLiquidity + depth.totalAskLiquidity,
    recommendation: sufficient 
      ? (slippage.slippagePercent < 1 ? 'GOOD_LIQUIDITY' : 'ACCEPTABLE_LIQUIDITY')
      : 'INSUFFICIENT_LIQUIDITY',
    details: {
      slippage,
      spread,
      depth
    }
  };
}

/**
 * Clear order book cache
 */
function clearOrderBookCache() {
  orderBookCache.clear();
}

module.exports = {
  fetchOrderBook,
  fetchMarketOrderBooks,
  calculateRealSlippage,
  getSpread,
  calculateMarketDepth,
  getOptimalEntry,
  checkTradeLiquidity,
  clearOrderBookCache
};
