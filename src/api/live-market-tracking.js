const WebSocket = require('ws');
const { getClobPrice } = require('../clob_price_cache');
const { fetchMarketById } = require('../fetcher');

// Store active market subscriptions
const marketSubscriptions = new Map();
const clientSubscriptions = new Map();

// Price history for change detection
const priceHistory = new Map();

/**
 * Initialize WebSocket server for live market tracking
 */
function initializeLiveTracking(server) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/ws/market-tracking'
  });

  wss.on('connection', (ws, req) => {
    const clientId = generateClientId();
    console.log(`[LIVE TRACKING] Client connected: ${clientId}`);
    
    clientSubscriptions.set(clientId, {
      ws,
      markets: new Set()
    });

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        handleClientMessage(clientId, data);
      } catch (error) {
        console.error('[LIVE TRACKING] Message parse error:', error);
        ws.send(JSON.stringify({ error: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      console.log(`[LIVE TRACKING] Client disconnected: ${clientId}`);
      handleClientDisconnect(clientId);
    });

    ws.on('error', (error) => {
      console.error(`[LIVE TRACKING] WebSocket error for ${clientId}:`, error);
    });

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      clientId,
      message: 'Connected to live market tracking'
    }));
  });

  // Start polling for market updates
  startMarketPolling();

  console.log('[LIVE TRACKING] WebSocket server initialized on /ws/market-tracking');
  return wss;
}

/**
 * Handle client messages
 */
function handleClientMessage(clientId, data) {
  const client = clientSubscriptions.get(clientId);
  if (!client) return;

  switch (data.type) {
    case 'subscribe':
      subscribeToMarket(clientId, data.marketId);
      break;
    case 'unsubscribe':
      unsubscribeFromMarket(clientId, data.marketId);
      break;
    case 'ping':
      client.ws.send(JSON.stringify({ type: 'pong' }));
      break;
    default:
      console.warn(`[LIVE TRACKING] Unknown message type: ${data.type}`);
  }
}

/**
 * Subscribe client to market updates
 */
function subscribeToMarket(clientId, marketId) {
  const client = clientSubscriptions.get(clientId);
  if (!client) return;

  client.markets.add(marketId);

  // Add to market subscriptions
  if (!marketSubscriptions.has(marketId)) {
    marketSubscriptions.set(marketId, new Set());
  }
  marketSubscriptions.get(marketId).add(clientId);

  console.log(`[LIVE TRACKING] Client ${clientId} subscribed to market ${marketId}`);

  // Send initial market data
  sendMarketUpdate(marketId, clientId);
}

/**
 * Unsubscribe client from market updates
 */
function unsubscribeFromMarket(clientId, marketId) {
  const client = clientSubscriptions.get(clientId);
  if (!client) return;

  client.markets.delete(marketId);

  const marketSubs = marketSubscriptions.get(marketId);
  if (marketSubs) {
    marketSubs.delete(clientId);
    if (marketSubs.size === 0) {
      marketSubscriptions.delete(marketId);
    }
  }

  console.log(`[LIVE TRACKING] Client ${clientId} unsubscribed from market ${marketId}`);
}

/**
 * Handle client disconnect
 */
function handleClientDisconnect(clientId) {
  const client = clientSubscriptions.get(clientId);
  if (!client) return;

  // Remove from all market subscriptions
  client.markets.forEach(marketId => {
    const marketSubs = marketSubscriptions.get(marketId);
    if (marketSubs) {
      marketSubs.delete(clientId);
      if (marketSubs.size === 0) {
        marketSubscriptions.delete(marketId);
      }
    }
  });

  clientSubscriptions.delete(clientId);
}

/**
 * Start polling for market updates
 */
function startMarketPolling() {
  setInterval(async () => {
    const marketIds = Array.from(marketSubscriptions.keys());
    
    for (const marketId of marketIds) {
      try {
        await checkMarketUpdates(marketId);
      } catch (error) {
        console.error(`[LIVE TRACKING] Error checking market ${marketId}:`, error);
      }
    }
  }, 5000); // Poll every 5 seconds
}

/**
 * Check for market updates and notify subscribers
 */
async function checkMarketUpdates(marketId) {
  try {
    // Get current price from CLOB cache
    const clobPrice = getClobPrice(marketId);
    const currentPrice = clobPrice?.mid || null;

    if (!currentPrice) {
      // Try to fetch market data
      const market = await fetchMarketById(marketId);
      if (!market) return;
      
      const price = market.yesPrice || 0.5;
      updateMarketData(marketId, price, market);
      return;
    }

    // Get historical data
    const history = priceHistory.get(marketId) || {
      prices: [],
      lastUpdate: Date.now(),
      lastPrice: currentPrice,
      volume: 0,
      liquidity: 0
    };

    // Calculate price change
    const priceChange = currentPrice - history.lastPrice;
    const priceChangePercent = (priceChange / history.lastPrice) * 100;

    // Detect significant changes
    const isSignificantChange = Math.abs(priceChangePercent) >= 5;
    const isPriceUp = priceChange > 0;

    // Update history
    history.prices.push({
      price: currentPrice,
      timestamp: Date.now()
    });

    // Keep only last 100 prices
    if (history.prices.length > 100) {
      history.prices.shift();
    }

    // Calculate 5-minute change
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const recentPrices = history.prices.filter(p => p.timestamp >= fiveMinutesAgo);
    const fiveMinChange = recentPrices.length > 0
      ? ((currentPrice - recentPrices[0].price) / recentPrices[0].price) * 100
      : 0;

    // Update stored history
    history.lastUpdate = Date.now();
    history.lastPrice = currentPrice;
    priceHistory.set(marketId, history);

    // Broadcast update to subscribers
    const update = {
      type: 'market_update',
      marketId,
      data: {
        currentPrice,
        priceChange,
        priceChangePercent,
        fiveMinChange,
        isSignificantChange,
        isPriceUp,
        timestamp: Date.now(),
        spread: clobPrice?.spread,
        volume: history.volume,
        liquidity: history.liquidity
      }
    };

    broadcastToMarketSubscribers(marketId, update);

    // Send alert for significant changes
    if (isSignificantChange) {
      const alert = {
        type: 'price_alert',
        marketId,
        data: {
          message: `Price ${isPriceUp ? 'increased' : 'decreased'} by ${Math.abs(priceChangePercent).toFixed(2)}%`,
          currentPrice,
          priceChangePercent,
          timestamp: Date.now()
        }
      };
      broadcastToMarketSubscribers(marketId, alert);
    }

  } catch (error) {
    console.error(`[LIVE TRACKING] Error in checkMarketUpdates for ${marketId}:`, error);
  }
}

/**
 * Update market data (volume, liquidity)
 */
function updateMarketData(marketId, price, market) {
  const history = priceHistory.get(marketId) || {
    prices: [],
    lastUpdate: Date.now(),
    lastPrice: price,
    volume: 0,
    liquidity: 0
  };

  history.volume = parseFloat(market.volume24hr) || 0;
  history.liquidity = parseFloat(market.liquidity) || 0;
  
  priceHistory.set(marketId, history);
}

/**
 * Send market update to specific client
 */
async function sendMarketUpdate(marketId, clientId) {
  const client = clientSubscriptions.get(clientId);
  if (!client || client.ws.readyState !== WebSocket.OPEN) return;

  try {
    const clobPrice = getClobPrice(marketId);
    const market = await fetchMarketById(marketId);
    
    if (!market) return;

    const update = {
      type: 'initial_data',
      marketId,
      data: {
        question: market.question,
        currentPrice: clobPrice?.mid || market.yesPrice || 0.5,
        volume: parseFloat(market.volume24hr) || 0,
        liquidity: parseFloat(market.liquidity) || 0,
        spread: clobPrice?.spread || 0,
        timestamp: Date.now()
      }
    };

    client.ws.send(JSON.stringify(update));
  } catch (error) {
    console.error(`[LIVE TRACKING] Error sending initial data for ${marketId}:`, error);
  }
}

/**
 * Broadcast update to all subscribers of a market
 */
function broadcastToMarketSubscribers(marketId, update) {
  const subscribers = marketSubscriptions.get(marketId);
  if (!subscribers) return;

  const message = JSON.stringify(update);
  
  subscribers.forEach(clientId => {
    const client = clientSubscriptions.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  });
}

/**
 * Generate unique client ID
 */
function generateClientId() {
  return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = {
  initializeLiveTracking,
  marketSubscriptions,
  priceHistory
};
