// CLOB Price Cache - Polls CLOB every 3-5 seconds for faster price truth
const axios = require('axios');
const axiosRetry = require('axios-retry').default || require('axios-retry');
const { fetchOrderBook, getAuthToken } = require('./fetcher');
require('dotenv').config();

// CLOB API configuration
const CLOB_BASE = process.env.CLOB_API_URL || 'https://clob.polymarket.com';

// Create axios instance with retry
const clobHttp = axios.create({
  timeout: 5000,
  headers: {
    'User-Agent': 'Oracle-of-Poly/1.0'
  }
});

axiosRetry(clobHttp, {
  retries: 2,
  retryDelay: () => 1000
});

// Global price cache
const clobPriceCache = new Map();

// Poll interval (3-5 seconds)
const POLL_INTERVAL = 4000;

// Active polling flag
let isPolling = false;

/**
 * Enhanced order book fetching with authentication
 */
async function fetchClobOrderBook(marketId, tokenId) {
  try {
    const token = await getAuthToken();
    if (!token) {
      console.log(`[CLOB] No auth token available for ${marketId}`);
      return null;
    }

    const url = tokenId ? `${CLOB_BASE}/book?token_id=${tokenId}` : `${CLOB_BASE}/books/${marketId}`;
    const response = await clobHttp.get(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.data && response.data.bids && response.data.asks) {
      console.log(`[CLOB] ✅ Fetched order book for ${marketId}: ${response.data.bids.length} bids, ${response.data.asks.length} asks`);
      return {
        bids: response.data.bids,
        asks: response.data.asks
      };
    }
    return null;
  } catch (error) {
    console.error(`[CLOB] ❌ Error fetching order book for ${marketId}:`, error.message);
    return null;
  }
}

/**
 * Calculate mid price from order book
 */
function calculateMidPrice(orderBook) {
  if (!orderBook || !orderBook.bids || !orderBook.asks) return null;

  const bestBid = parseFloat(orderBook.bids[0]?.price || 0);
  const bestAsk = parseFloat(orderBook.asks[0]?.price || 0);

  if (!bestBid || !bestAsk) return null;

  return (bestBid + bestAsk) / 2;
}

/**
 * Calculate spread from order book
 */
function calculateSpread(orderBook) {
  if (!orderBook || !orderBook.bids || !orderBook.asks) return null;
  
  const bestBid = parseFloat(orderBook.bids[0]?.price || 0);
  const bestAsk = parseFloat(orderBook.asks[0]?.price || 0);
  
  if (!bestBid || !bestAsk) return null;
  
  return bestAsk - bestBid;
}

/**
 * Calculate liquidity from order book depth
 */
function calculateLiquidity(orderBook, depth = 5) {
  if (!orderBook) return 0;
  
  let totalLiquidity = 0;
  
  // Sum liquidity from top N levels of bids and asks
  if (orderBook.bids) {
    for (let i = 0; i < Math.min(depth, orderBook.bids.length); i++) {
      totalLiquidity += parseFloat(orderBook.bids[i].size || 0);
    }
  }
  
  if (orderBook.asks) {
    for (let i = 0; i < Math.min(depth, orderBook.asks.length); i++) {
      totalLiquidity += parseFloat(orderBook.asks[i].size || 0);
    }
  }
  
  return totalLiquidity;
}

/**
 * Poll all monitored markets
 */
async function pollPrices(marketIds) {
  if (!marketIds || marketIds.length === 0) return;

  const promises = marketIds.map(async (marketId) => {
    try {
      const orderBook = await fetchClobOrderBook(marketId);
      if (orderBook) {
        const mid = calculateMidPrice(orderBook);
        if (mid) {
          clobPriceCache.set(marketId, {
            mid: mid,
            bid: parseFloat(orderBook.bids[0]?.price || 0),
            ask: parseFloat(orderBook.asks[0]?.price || 0),
            spread: calculateSpread(orderBook),
            liquidity: calculateLiquidity(orderBook),
            bids: orderBook.bids,
            asks: orderBook.asks,
            ts: Date.now()
          });
        }
      }
    } catch (error) {
      // Continue with other markets
    }
  });

  await Promise.allSettled(promises);
}

/**
 * Start polling for given market IDs
 */
function startPolling(marketIds) {
  if (isPolling) return;

  isPolling = true;

  const poll = async () => {
    if (!isPolling) return;

    try {
      await pollPrices(marketIds);
    } catch (error) {
      // Continue polling
    }

    // Schedule next poll
    setTimeout(poll, POLL_INTERVAL);
  };

  // Start first poll
  poll();
}

/**
 * Stop polling
 */
function stopPolling() {
  isPolling = false;
}

/**
 * Get cached price (with fallback to gammaPrice)
 */
function getClobPrice(marketId, gammaPrice = null) {
  const cached = clobPriceCache.get(marketId);
  const age = cached ? (Date.now() - cached.ts) : Infinity;

  if (cached && age < 5000) { // Reduced to 5 seconds
    console.log(`[CLOB] ✅ Using fresh cached price for ${marketId}: ${cached.mid}`);
    return {
      mid: cached.mid,
      bid: cached.bid,
      ask: cached.ask,
      spread: cached.spread,
      liquidity: cached.liquidity,
      orderBook: cached
    };
  }

  if (age >= 5000 && cached) {
    console.warn(`[CLOB] ⚠️ Stale CLOB price for ${marketId}: ${age}ms old`);
  }

  console.log(`[CLOB] Using fallback gamma price for ${marketId}: ${gammaPrice}`);
  return {
    mid: gammaPrice,
    bid: null,
    ask: null,
    spread: null,
    liquidity: null,
    orderBook: null
  };
}

/**
 * Get full order book data
 */
function getOrderBook(marketId) {
  const cached = clobPriceCache.get(marketId);
  return cached || null;
}

module.exports = {
  startPolling,
  stopPolling,
  getClobPrice,
  getOrderBook,
  fetchOrderBook: fetchClobOrderBook,
  calculateMidPrice,
  calculateSpread,
  calculateLiquidity,
  clobPriceCache
};
