// CLOB Price Cache - Polls CLOB every 3-5 seconds for faster price truth
const axios = require('axios');
const axiosRetry = require('axios-retry').default || require('axios-retry');
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
 * Fetch order book from CLOB API
 */
async function fetchOrderBook(marketId, tokenId) {
  try {
    const url = tokenId ? `${CLOB_BASE}/book?token_id=${tokenId}` : `${CLOB_BASE}/order-book/${marketId}`;
    const response = await clobHttp.get(url);

    if (response.data && response.data.bids && response.data.asks) {
      return {
        bids: response.data.bids,
        asks: response.data.asks
      };
    }
    return null;
  } catch (error) {
    // Silently fail - fallback to Gamma
    return null;
  }
}

/**
 * Calculate mid price from order book
 */
function calculateMidPrice(orderBook) {
  if (!orderBook || !orderBook.bids || !orderBook.asks) return null;

  const bestBid = orderBook.bids[0]?.price;
  const bestAsk = orderBook.asks[0]?.price;

  if (!bestBid || !bestAsk) return null;

  return (parseFloat(bestBid) + parseFloat(bestAsk)) / 2;
}

/**
 * Poll all monitored markets
 */
async function pollPrices(marketIds) {
  if (!marketIds || marketIds.length === 0) return;

  const promises = marketIds.map(async (marketId) => {
    try {
      const orderBook = await fetchOrderBook(marketId);
      if (orderBook) {
        const mid = calculateMidPrice(orderBook);
        if (mid) {
          clobPriceCache.set(marketId, {
            mid: mid,
            bid: parseFloat(orderBook.bids[0]?.price || 0),
            ask: parseFloat(orderBook.asks[0]?.price || 0),
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
    return cached.mid;
  }

  if (age >= 5000 && cached) {
    console.warn(`Stale CLOB price for ${marketId}: ${age}ms old`);
  }

  return gammaPrice;
}

/**
 * Get full order book data
 */
function getOrderBook(marketId) {
  return clobPriceCache.get(marketId) || null;
}

module.exports = {
  startPolling,
  stopPolling,
  getClobPrice,
  getOrderBook,
  fetchOrderBook,
  clobPriceCache
};
