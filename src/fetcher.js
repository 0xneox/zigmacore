const axios = require('axios');
const axiosRetry = require('axios-retry').default || require('axios-retry');
require('dotenv').config();
const { analyzeUserProfile } = require('./user_analysis');
const {
  saveUserPerformanceSnapshot,
  getUserPerformanceHistory,
  getUserPerformanceTrend
} = require('./db');
const { getUserBenchmark } = require('./benchmarking');

// Create a custom axios instance with retry logic
const http = axios.create({
  timeout: parseInt(process.env.REQUEST_TIMEOUT) || 20000,  // Increased timeout to 20 seconds
  headers: {
    'User-Agent': 'Oracle-of-Poly/1.0',
    'Accept': 'application/json',
    'Cache-Control': 'no-cache'
  }
});

// Configure retry logic with exponential backoff
axiosRetry(http, { 
  retries: parseInt(process.env.MAX_RETRIES) || 3,
  retryDelay: (retryCount) => {
    const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff
    console.log(`Retry attempt ${retryCount}, retrying in ${delay}ms...`);
    return delay;
  },
  retryCondition: (error) => {
    // Retry on network errors, timeouts, and 5xx responses
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || 
           (error.code === 'ECONNABORTED') ||
           (error.response && error.response.status >= 500);
  }
});

const GAMMA = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';
const DATA_API = process.env.DATA_API_URL || 'https://data-api.polymarket.com';

/**
 * Fetch active Polymarket markets from Gamma API
 * - Includes retry logic with exponential backoff
 * - Normalizes response to a clean array
 * - Defensive against API shape changes
 * @param {number} limit - Maximum number of markets to fetch (default 500)
 * @param {number} offset - Pagination offset (default 0)
 * @returns {Promise<Array>} - Array of market objects
 */
async function fetchMarkets(limit = 500, offset = 0) {  // Reduced default limit
  const url = `${GAMMA}/markets?closed=false&limit=${limit}&offset=${offset}`;
  console.log(`🌐 FETCH: ${url} (Timeout: ${http.defaults.timeout}ms)`);

  try {
    const startTime = Date.now();
    const res = await http.get(url);
    const endTime = Date.now();
    
    console.log(`✅ Fetched ${res.data.length || 0} markets in ${endTime - startTime}ms`);

    let markets = [];

    // Gamma API (current): array
    if (Array.isArray(res.data)) {
      markets = res.data;
    }
    // { markets: [...] }
    else if (res.data?.markets && Array.isArray(res.data.markets)) {
      markets = res.data.markets;
    }
    // { data: [...] }
    else if (res.data?.data && Array.isArray(res.data.data)) {
      markets = res.data.data;
    }
    // Object with numeric keys
    else if (
      res.data &&
      typeof res.data === 'object' &&
      Object.keys(res.data).every(k => !isNaN(k))
    ) {
      markets = Object.values(res.data);
    } else {
      console.error(
        '❌ Unknown Gamma response shape:',
        typeof res.data === 'object' ? Object.keys(res.data).slice(0, 10) : typeof res.data
      );
      return [];
    }

    console.log(`✅ Fetched ${markets.length} markets`);

    // Hard sanity filter (cheap + safe)
    markets = markets.filter(m =>
      m &&
      m.question &&
      m.active === true &&
      m.closed === false
    );

    console.log(`📊 After sanity filter: ${markets.length}`);
    return markets;
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      console.error(`❌ Request timed out after ${http.defaults.timeout}ms`);
    } else if (err.response) {
      console.error(`❌ API Error: ${err.response.status} - ${err.response.statusText}`);
      if (err.response.data) {
        console.error('❌ Response data:', JSON.stringify(err.response.data).slice(0, 200));
      }
    } else if (err.request) {
      console.error('❌ Network Error: No response received from server');
    } else {
      console.error('❌ Error fetching markets:', err.message);
    }
    return [];
  }
}

/**
 * Fetch all active Polymarket markets by paginating through the API
 * - Prioritizes recent/new markets by sorting by startDate desc
 * - Includes rate limiting to avoid throttling
 */
async function fetchAllMarkets() {
  const baseUrl = `${GAMMA}/markets`;
  const params = {
    closed: 'false',
    limit: 500,
    order: 'startDate',
    sort: 'desc'
  };
  const MAX_MARKETS = parseInt(process.env.MAX_MARKETS) || 100;
  let offset = 0;
  let allMarkets = [];

  while (true) {
    if (allMarkets.length >= MAX_MARKETS) break;
    params.offset = offset;

    const url = `${baseUrl}?${new URLSearchParams(params)}`;
    console.log(`🌐 FETCH PAGE: ${url} (Offset: ${offset})`);

    try {
      const startTime = Date.now();
      const res = await http.get(url);
      const endTime = Date.now();

      let markets = [];
      if (Array.isArray(res.data)) {
        markets = res.data;
      } else if (res.data?.markets && Array.isArray(res.data.markets)) {
        markets = res.data.markets;
      } else if (res.data?.data && Array.isArray(res.data.data)) {
        markets = res.data.data;
      } else if (
        res.data &&
        typeof res.data === 'object' &&
        Object.keys(res.data).every(k => !isNaN(k))
      ) {
        markets = Object.values(res.data);
      } else {
        console.error('❌ Unknown response shape for page');
        break;
      }

      console.log(`✅ Fetched ${markets.length} markets in ${endTime - startTime}ms (Total so far: ${allMarkets.length + markets.length})`);

      if (markets.length === 0) break;

      // Apply sanity filter
      markets = markets.filter(m =>
        m &&
        m.question &&
        m.closed !== true &&
        (m.active !== false)
      );

      const remainingSlots = Math.max(0, MAX_MARKETS - allMarkets.length);
      if (remainingSlots <= 0) break;

      allMarkets.push(...markets.slice(0, remainingSlots));
      console.log(`📈 Accumulator length: ${allMarkets.length}`);
      offset += params.limit;

      // Rate limiting delay
      if (markets.length === 500) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1s delay between pages
      }
    } catch (err) {
      console.error('❌ Error fetching page:', err.message);
      offset += params.limit;
      continue;
    }
  }

  console.log(`✅ Total markets fetched: ${allMarkets.length} (cap ${MAX_MARKETS})`);
  return allMarkets;
}

/**
 * Fetch available tags/categories from Polymarket API
 */
async function fetchTags() {
  const url = `${GAMMA}/tags`;
  console.log(`🌐 FETCH: ${url}`);

  try {
    const res = await http.get(url);
    console.log(`✅ Fetched ${res.data?.length || 0} tags`);
    return res.data || [];
  } catch (err) {
    console.error('❌ Error fetching tags:', err.message);
    return [];
  }
}

/**
 * Fetch closed (resolved) Polymarket markets for backtesting
 */
async function fetchClosedMarkets(limit = 200, offset = 0) {
  const allMarkets = [];
  let currentOffset = offset;

  while (allMarkets.length < 100) {  // Cap at 1000 for backtesting
    const url = `${GAMMA}/markets?closed=true&limit=${limit}&offset=${currentOffset}`;
    console.log(`🌐 FETCH CLOSED: ${url}`);

    try {
      const startTime = Date.now();
      const res = await http.get(url);
      const endTime = Date.now();

      console.log(`✅ Fetched ${res.data.length || 0} closed markets in ${endTime - startTime}ms`);

      let markets = res.data || [];

      if (markets.length === 0) break;

      // Filter to ensure closed
      markets = markets.filter(m =>
        m &&
        m.question &&
        m.closed === true
      );

      allMarkets.push(...markets);
      console.log(`📈 Closed markets accumulated: ${allMarkets.length}`);
      currentOffset += limit;

      // Rate limiting
      if (markets.length === limit) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err) {
      console.error('❌ Error fetching closed page:', err.message);
      currentOffset += limit;
      continue;
    }
  }

  console.log(`✅ Total closed markets fetched: ${allMarkets.length}`);
  return allMarkets;
}

async function fetchSearchMarkets(query) {
  const url = `${GAMMA}/events?query=${encodeURIComponent(query)}&closed=false&active=true&limit=1`;
  try {
    const res = await http.get(url);
    const events = res.data;
    if (!events || events.length === 0) return null;
    const event = events[0];
    if (!event.markets || event.markets.length === 0) return null;
    return { market: event.markets[0], event };
  } catch (error) {
    console.error('Error fetching search markets:', error);
    return null;
  }
}

async function fetchEventBySlug(slug) {
  if (!slug) return null;
  try {
    const url = `${GAMMA}/events/slug/${slug}`;
    const res = await http.get(url);
    return res.data || null;
  } catch (error) {
    console.error('Error fetching event by slug:', error.message);
    return null;
  }
}

async function fetchMarketBySlug(slug) {
  if (!slug) return null;
  try {
    const url = `${GAMMA}/markets/slug/${slug}`;
    const res = await http.get(url);
    return res.data || null;
  } catch (error) {
    return null;
  }
}

async function fetchMarketById(id) {
  if (!id) return null;
  try {
    const url = `${GAMMA}/markets/${id}`;
    const res = await http.get(url);
    return res.data || null;
  } catch (error) {
    console.error('Error fetching market by id:', error.message);
    return null;
  }
}

async function fetchUserPositions(maker, limit = 100) {
  if (!maker) return null;
  try {
    const url = `${DATA_API}/positions?user=${maker}&limit=${limit}`;
    console.log(`[USER PROFILE] Fetching positions from: ${url}`);
    const res = await http.get(url);
    const positions = res.data || [];
    console.log(`[USER PROFILE] Positions API returned ${positions.length} positions`);
    console.log(`[USER PROFILE] Positions API response type:`, Array.isArray(positions) ? 'array' : typeof positions);
    if (positions.length > 0) {
      console.log(`[USER PROFILE] Sample position keys:`, Object.keys(positions[0]));
      console.log(`[USER PROFILE] Sample position:`, JSON.stringify(positions[0], null, 2));
    } else {
      console.log(`[USER PROFILE] No positions returned. Response:`, res.data);
    }
    
    // Normalize position data with proper field mapping
    return positions.map(pos => ({
      conditionId: pos.condition_id || pos.conditionId,
      title: pos.title || pos.question,
      outcome: pos.outcome || pos.token_id,
      size: pos.shares || pos.size || 0,
      avgPrice: pos.avg_price || pos.avgPrice || 0,
      curPrice: pos.cur_price || pos.curPrice || 0,
      cashPnl: pos.cash_pnl || pos.cashPnl || 0,
      initialValue: pos.initial_value || pos.initialValue || 0,
      realizedPnl: pos.realized_pnl || pos.realizedPnl || 0,
      timestamp: pos.timestamp || pos.created_at || 0
    }));
  } catch (error) {
    console.error('Error fetching user positions:', error.message);
    return [];
  }
}

async function fetchUserActivity(maker, limit = 100) {
  if (!maker) return null;
  try {
    let allActivity = [];
    let offset = 0;
    const maxItems = 20000; // Increased cap to 20,000 items to get more complete history
    
    while (allActivity.length < maxItems) {
      const url = `${DATA_API}/activity?user=${maker}&limit=${limit}&offset=${offset}`;
      console.log(`[USER PROFILE] Fetching activity from: ${url} (offset: ${offset})`);
      
      const res = await http.get(url);
      const activityBatch = res.data || [];
      
      console.log(`[USER PROFILE] Activity API returned ${activityBatch.length} items (total so far: ${allActivity.length})`);
      
      if (activityBatch.length === 0) break;
      
      allActivity.push(...activityBatch);
      offset += limit;
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`[USER PROFILE] Total activity fetched: ${allActivity.length}`);
    
    if (allActivity.length > 0) {
      console.log(`[USER PROFILE] Sample activity keys:`, Object.keys(allActivity[0]));
      console.log(`[USER PROFILE] Sample activity proxyWallet:`, allActivity[0].proxyWallet);
    }
    
    return processActivity(allActivity);
  } catch (error) {
    console.error('Error fetching user activity:', error.message);
    return [];
  }
}

function processActivity(activity) {
  return activity.map(item => {
    // Try multiple timestamp field names
    let timestamp = item.timestamp || item.created_at || item.block_time || item.created_time || item.time || 0;
    
    // Convert to milliseconds if timestamp is in seconds (less than 10000000000)
    if (timestamp > 0 && timestamp < 10000000000) {
      timestamp = timestamp * 1000;
    }
    
    return {
      conditionId: item.condition_id || item.conditionId || item.asset,
      title: item.title || item.question || item.market_question,
      outcome: item.outcome || item.token_id || item.asset_name,
      type: item.type,
      side: item.side,
      size: item.shares || item.size || item.amount || 0,
      price: item.price || 0,
      timestamp: timestamp
    };
  });
}

async function fetchPublicProfile(address) {
  if (!address) return null;
  try {
    const url = `${GAMMA}/public-profile?address=${address}`;
    console.log(`[USER PROFILE] Fetching public profile from: ${url}`);
    const res = await http.get(url);
    console.log(`[USER PROFILE] Public profile fetched:`, res.data);
    return res.data || null;
  } catch (error) {
    console.error('Error fetching public profile:', error.message);
    return null;
  }
}

async function fetchHoldingsValue(maker) {
  if (!maker) return null;
  try {
    const url = `${DATA_API}/value?user=${maker}`;
    console.log(`[USER PROFILE] Fetching holdings value from: ${url}`);
    const res = await http.get(url);
    const value = res.data[0]?.value || 0;
    console.log(`[USER PROFILE] Holdings value: ${value}`);
    return value;
  } catch (error) {
    console.error('Error fetching holdings value:', error.message);
    return 0;
  }
}

function calculateUserMetricsWithRedemptions(positions = [], activity = [], balance = 0) {
  const metrics = {
    totalPositions: positions.length,
    totalTrades: 0,
    uniqueMarkets: 0,
    realizedPnl: 0,
    unrealizedPnl: balance,
    totalVolume: 0,
    winRate: 0,
    averagePositionSize: 0,
    topMarkets: [],
    recentActivity: []
  };

  // Count unique markets from ALL activity types, not just trades
  const allMarketIds = new Set();
  activity.forEach(item => {
    if (item.conditionId || item.asset) {
      allMarketIds.add(item.conditionId || item.asset);
    }
  });
  metrics.uniqueMarkets = allMarketIds.size;

  // Separate trades and redemptions
  const trades = activity.filter(item => item.type === 'TRADE');
  const redemptions = activity.filter(item => item.type === 'REDEEM');
  
  metrics.totalTrades = trades.length;

  console.log(`[USER PROFILE] Activity breakdown: ${activity.length} total, ${trades.length} trades, ${redemptions.length} redemptions`);
  console.log(`[USER PROFILE] Activity types:`, [...new Set(activity.map(a => a.type))]);
  if (redemptions.length > 0) {
    console.log(`[USER PROFILE] Sample redemption:`, JSON.stringify(redemptions[0], null, 2));
  }

  if (positions.length > 0) {
    metrics.averagePositionSize = positions.reduce((sum, pos) => sum + (pos.initialValue || 0), 0) / positions.length;

    const marketPnl = {};
    positions.forEach(pos => {
      const marketId = pos.conditionId || 'unknown';
      if (!marketPnl[marketId]) {
        marketPnl[marketId] = { pnl: 0, title: pos.title || 'Unknown Market' };
      }
      marketPnl[marketId].pnl += pos.cashPnl || 0;
    });

    metrics.topMarkets = Object.entries(marketPnl)
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .slice(0, 5)
      .map(([id, data]) => ({ marketId: id, ...data }));
  }

  // Calculate realized P&L from trade history (matching BUY/SELL pairs)
  // This captures P&L from closed positions that are no longer in positions API
  if (trades.length > 0) {
    const tradesByMarket = {};
    trades.forEach(trade => {
      const marketId = trade.conditionId || trade.asset || 'unknown';
      if (!tradesByMarket[marketId]) {
        tradesByMarket[marketId] = { buys: [], sells: [], title: trade.title || 'Unknown Market' };
      }
      if (trade.side === 'BUY') {
        tradesByMarket[marketId].buys.push(trade);
      } else if (trade.side === 'SELL') {
        tradesByMarket[marketId].sells.push(trade);
      }
    });

    let totalRealizedPnl = 0;
    let profitablePositions = 0;
    let closedPositions = 0;

    Object.entries(tradesByMarket).forEach(([marketId, data]) => {
      const { buys, sells, title } = data;

      // Sort by timestamp
      buys.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      sells.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      let buyIndex = 0;
      let sellIndex = 0;

      // Match buys and sells using FIFO
      while (buyIndex < buys.length && sellIndex < sells.length) {
        const buy = buys[buyIndex];
        const sell = sells[sellIndex];
        const matchedSize = Math.min(buy.size, sell.size);

        // P&L = (sellPrice - buyPrice) * matchedSize
        const pnl = (sell.price - buy.price) * matchedSize;
        totalRealizedPnl += pnl;
        closedPositions++;
        if (pnl > 0) profitablePositions++;

        // Reduce remaining sizes
        buy.size -= matchedSize;
        sell.size -= matchedSize;

        // Move to next trade if size is exhausted
        if (buy.size < 0.0001) buyIndex++;
        if (sell.size < 0.0001) sellIndex++;
      }
    });

    metrics.realizedPnl = totalRealizedPnl;
    metrics.winRate = closedPositions > 0 ? (profitablePositions / closedPositions) * 100 : 0;

    console.log(`[USER PROFILE] Realized P&L calculated from trade history: ${metrics.realizedPnl}`);
    console.log(`[USER PROFILE] Closed positions: ${closedPositions}, Profitable: ${profitablePositions}, Win rate: ${metrics.winRate.toFixed(2)}%`);

    // Calculate total volume from trades
    metrics.totalVolume = trades.reduce((sum, trade) => sum + (trade.size * trade.price || 0), 0);

    // Recent activity from all types
    metrics.recentActivity = activity
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 10)
      .map(item => ({
        type: item.type,
        side: item.side,
        size: item.size,
        price: item.price,
        timestamp: item.timestamp,
        title: item.title,
        outcome: item.outcome
      }));
  }

  return metrics;
}

async function fetchUserProfile(maker) {
  console.log(`[USER PROFILE] fetchUserProfile called with maker: "${maker}"`);
  console.log(`[USER PROFILE] maker type:`, typeof maker);
  console.log(`[USER PROFILE] maker length:`, maker?.length);
  
  if (!maker) return null;
  try {
    console.log(`[USER PROFILE] Starting parallel fetch for profile, positions, activity, and balance...`);
    const [profile, positions, activity, balance] = await Promise.all([
      fetchPublicProfile(maker),
      fetchUserPositions(maker, 500),
      fetchUserActivity(maker, 500),
      fetchHoldingsValue(maker)
    ]);

    console.log(`[USER PROFILE] Fetched profile:`, !!profile, `positions: ${positions.length}, activity: ${activity.length}, balance: ${balance}`);
    console.log(`[USER PROFILE] Calculating metrics with redemptions...`);

    // Calculate metrics using all activity (trades + redemptions)
    const metrics = await calculateUserMetricsWithRedemptions(positions, activity, balance);

    console.log(`[USER PROFILE] Metrics calculated:`, {
      totalPositions: metrics.totalPositions,
      totalTrades: metrics.totalTrades,
      uniqueMarkets: metrics.uniqueMarkets,
      realizedPnl: metrics.realizedPnl,
      unrealizedPnl: metrics.unrealizedPnl,
      totalVolume: metrics.totalVolume,
      winRate: metrics.winRate
    });

    // Generate intelligent analysis
    console.log(`[USER PROFILE] Generating intelligent analysis...`);
    const analysis = analyzeUserProfile(profile, positions, activity, metrics);
    console.log(`[USER PROFILE] Analysis generated:`, analysis.summary);

    // Save performance snapshot for historical tracking
    try {
      saveUserPerformanceSnapshot(maker, metrics, analysis.health?.score);
      console.log(`[USER PROFILE] Performance snapshot saved for ${maker}`);
    } catch (err) {
      console.warn(`[USER PROFILE] Failed to save performance snapshot:`, err.message);
    }

    // Get historical trend data
    let trend = null;
    try {
      trend = getUserPerformanceTrend(maker, 7); // 7-day trend
      console.log(`[USER PROFILE] Historical trend loaded:`, trend);
    } catch (err) {
      console.warn(`[USER PROFILE] Failed to load historical trend:`, err.message);
    }

    // Get benchmarking data (rank against top traders)
    let benchmark = null;
    try {
      const userProfileData = { maker, metrics, analysis, trend };
      benchmark = await getUserBenchmark(userProfileData);
      console.log(`[USER PROFILE] Benchmark loaded: Rank ${benchmark.rank}, Percentile ${benchmark.percentile?.toFixed(1)}%`);
    } catch (err) {
      console.warn(`[USER PROFILE] Failed to load benchmark:`, err.message);
    }

    return {
      maker,
      profile,
      positions,
      activity,  // Full activity (includes trades, redemptions, etc.)
      balance,   // Total holdings value
      metrics,
      analysis,  // Intelligent analysis insights
      trend,     // Historical performance trend (7-day)
      benchmark, // Comparative ranking against top traders
      fetchedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error fetching user profile:', error.message);
    return null;
  }
}

module.exports = {
  fetchMarkets,
  fetchAllMarkets,
  fetchTags,
  fetchClosedMarkets,
  fetchSearchMarkets,
  fetchEventBySlug,
  fetchMarketBySlug,
  fetchMarketById,
  fetchUserPositions,
  fetchUserActivity,
  fetchPublicProfile,
  fetchHoldingsValue,
  fetchUserProfile
};