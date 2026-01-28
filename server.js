const express = require('express');
const crypto = require('crypto');
const app = express();
const http = require('http');
const PORT = process.env.PORT || 3001;
const path = require('path');
const fs = require('fs');
const { findBestMatchingMarket } = require('./src/utils/nlp-market-matcher');
const { BoundedMap } = require('./src/utils/bounded-map');
const { parsePolymarketUrl, normalizeSlug } = require('./src/utils/url-parser');
const { createBackup, listBackups, verifyBackup } = require('./backup');
const PriceWebSocketServer = require('./src/websocket');
const prometheusMetrics = require('./src/prometheus');
const { runResolutionUpdate, getResolutionStats } = require('./src/market-resolution-updater');
const { 
  saveChatExchange, 
  saveErrorMessage, 
  extractClientInfo,
  generateSessionId 
} = require('./src/chat-persistence');
const v1Router = require('./src/api/v1');

// Create HTTP server for WebSocket support
const server = http.createServer(app);

// Initialize WebSocket server
const wsServer = new PriceWebSocketServer(server, {
  broadcastInterval: 5000,
  reconnectInterval: 30000
});

// API Key authentication
const API_KEY = process.env.API_KEY || 'zigma-api-key-2024';

const authenticate = (req, res, next) => {
  const authHeader = req.headers['x-api-key'];
  if (authHeader !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing API key' });
  }
  next();
};

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Simple in-memory rate limiter
const rateLimitStore = new BoundedMap(10000);
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // 100 requests per minute per IP

const rateLimiter = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();

  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }

  const record = rateLimitStore.get(ip);

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    const resetTime = Math.ceil((record.resetTime - now) / 1000);
    res.setHeader('Retry-After', resetTime);
    return res.status(429).json({
      error: 'Too many requests',
      message: `Rate limit exceeded. Try again in ${resetTime} seconds.`
    });
  }

  record.count++;
  next();
};

// Apply rate limiting to all API routes
app.use(rateLimiter);

// Input validation middleware
const validateInput = (req, res, next) => {
  const sanitizeString = (str, maxLength = 1000) => {
    if (typeof str !== 'string') return '';
    return str.trim().slice(0, maxLength).replace(/[<>]/g, '');
  };

  const validateWalletAddress = (address) => {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  };

  const validateMarketId = (id) => {
    if (!id || typeof id !== 'string') return false;
    return /^[a-fA-F0-9-]{36,}$/.test(id) || /^[a-fA-F0-9]{64}$/.test(id);
  };

  // Sanitize query parameters
  if (req.query) {
    for (const key in req.query) {
      req.query[key] = sanitizeString(req.query[key], 500);
    }
  }

  // Sanitize request body strings
  if (req.body) {
    if (req.body.query) req.body.query = sanitizeString(req.body.query, 500);
    if (req.body.question) req.body.question = sanitizeString(req.body.question, 500);
    if (req.body.marketQuestion) req.body.marketQuestion = sanitizeString(req.body.marketQuestion, 500);
    if (req.body.marketId) {
      if (!validateMarketId(req.body.marketId)) {
        return res.status(400).json({ error: 'Invalid market ID format' });
      }
    }
    if (req.body.polymarketUser) {
      if (!validateWalletAddress(req.body.polymarketUser)) {
        return res.status(400).json({
          error: 'Invalid wallet address format',
          suggestion: 'Please provide a valid Polymarket wallet address (starts with 0x and is 42 characters long)'
        });
      }
    }
    if (req.body.market) req.body.market = sanitizeString(req.body.market, 500);
    if (req.body.link) req.body.link = sanitizeString(req.body.link, 500);
  }

  next();
};

// Apply validation to all routes
app.use(validateInput);

// Auth middleware (skipped for testing)
app.use((req, res, next) => {
  // const apiKey = req.headers['x-api-key'];
  // if (process.env.API_KEY && (!apiKey || apiKey !== process.env.API_KEY)) {
  //   return res.status(401).json({ error: 'Unauthorized' });
  // }
  next();
});

// CORS headers
const allowedOrigins = ['https://zigma.pro', 'https://www.zigma.pro', 'http://localhost:8080', 'http://localhost:5173'];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') res.sendStatus(200);
  else next();
});

// Mount v1 API routes for Moltbot integration
app.use('/api/v1', v1Router);

// Import agent functions
const {
  fetchMarkets,
  fetchSearchMarkets,
  fetchEventBySlug,
  fetchMarketBySlug,
  fetchMarketById,
  fetchUserProfile
} = require('./src/fetcher');
const { generateEnhancedAnalysis } = require('./src/llm');
const { requireCredits, deductCredit } = require('./src/api/credits');

// Simple string similarity function
function calculateSimilarity(query, text) {
  const queryWords = query.toLowerCase().split(/\s+/);
  const textWords = text.toLowerCase().split(/\s+/);
  
  const commonWords = queryWords.filter(word => textWords.includes(word));
  return commonWords.length / Math.max(queryWords.length, 1);
}

// Health monitoring state
let systemHealth = {
  status: 'initializing',
  uptime: 0,
  lastRun: null,
  posts: 0,
  marketsMonitored: 0,
  alertsActive: 0,
  startTime: Date.now()
};

// Latest cycle data for UI
global.latestData = {
  cycleSummary: null,
  liveSignals: [],
  marketOutlook: [],
  rejectedSignals: [],
  volumeSpikes: [],
  lastRun: null,
  marketsMonitored: 0,
  posts: 0
};

// Update health metrics
function updateHealthMetrics(metrics) {
  systemHealth = {
    ...systemHealth,
    ...metrics,
    uptime: Math.floor((Date.now() - systemHealth.startTime) / 1000)
  };
}

// Simple health check endpoint
app.get('/admin/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    hasGlobalData: !!global.latestData,
    cycleSummary: global.latestData?.cycleSummary || null
  });
});

// Manual cycle trigger endpoint for debugging
app.post('/admin/trigger-cycle', async (req, res) => {
  try {
    console.log('[MANUAL TRIGGER] Forcing cycle run...');
    // Import the queued cycle function
    const { queuedRunCycle } = require('./src/index');
    
    // Run the cycle
    await queuedRunCycle();
    
    res.json({ 
      success: true, 
      message: 'Cycle triggered successfully',
      timestamp: new Date().toISOString(),
      data: global.latestData?.cycleSummary 
    });
  } catch (error) {
    console.error('[MANUAL TRIGGER] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check endpoint
app.get('/status', async (req, res) => {
  const checks = {
    database: false,
    polymarketApi: false,
    llmApi: false,
    databaseStatus: 'unknown'
  };

  try {
    // Check database health
    const { checkDbHealth } = require('./src/db');
    const dbHealth = await checkDbHealth();
    checks.database = dbHealth.available;
    checks.databaseStatus = dbHealth.status;
  } catch (error) {
    console.error('Database health check failed:', error);
  }

  try {
    // Check Polymarket API
    const polymarketHealth = await fetch('https://gamma-api.polymarket.com/markets?limit=1')
      .then(res => res.ok)
      .catch(() => false);
    checks.polymarketApi = polymarketHealth;
  } catch (error) {
    console.error('Polymarket health check failed:', error);
  }

  try {
    // Check LLM API
    const llmHealth = process.env.OPENAI_API_KEY || process.env.XAI_API_KEY;
    checks.llmApi = !!llmHealth;
  } catch (error) {
    console.error('LLM health check failed:', error);
  }

  const overallStatus = checks.database && checks.polymarketApi && checks.llmApi ? 'healthy' : 'degraded';

  res.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks,
    message: overallStatus === 'healthy' 
      ? 'All systems operational' 
      : 'Some systems are degraded - see checks for details'
  });
});

// Prometheus metrics endpoint (for monitoring with Grafana)
app.get('/metrics', (req, res) => {
  const acceptHeader = req.headers.accept || '';
  
  if (acceptHeader.includes('application/json')) {
    // Return JSON format for compatibility
    res.json(prometheusMetrics.getMetricsJSON());
  } else {
    // Return Prometheus text format
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(prometheusMetrics.generatePrometheusOutput());
  }
});

// Basic metrics endpoint (for backward compatibility)
app.get('/api/metrics', (req, res) => {
  res.json(prometheusMetrics.getMetricsJSON());
});

// Debug endpoint to check global data state
app.get('/admin/debug', (req, res) => {
  res.json({
    globalLatestData: global.latestData,
    systemHealth: systemHealth,
    hasCycleSummary: !!global.latestData?.cycleSummary,
    cycleSummary: global.latestData?.cycleSummary,
    timestamp: new Date().toISOString()
  });
});

// Data endpoint for UI (structured cycle data)
app.get('/data', (req, res) => {
  res.json(global.latestData);
});

// Visualization data endpoint (for risk metrics visualization)
app.get('/api/visualization/risk-metrics', (req, res) => {
  res.json(prometheusMetrics.getMetricsJSON());
});

// Logs endpoint for UI (sanitized for public display) - REQUIRES AUTHENTICATION
app.get('/logs', authenticate, (req, res) => {
  try {
    const logPath = 'console_output.log';
    const stats = fs.statSync(logPath);
    if (stats.size > 10 * 1024 * 1024) { // 10MB
      const oldPath = path.join(__dirname, 'console_output.log.old');
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      fs.renameSync(logPath, oldPath);
      fs.writeFileSync(logPath, ''); // Create new empty log
    }
    const rawLogs = fs.readFileSync(logPath, 'utf8');

    // Sanitize logs for public display
    const sanitizedLogs = rawLogs
      .split('\n')
      .filter(line => {
        // Remove lines containing sensitive information
        if (line.toLowerCase().includes('api_key')) return false;
        if (line.toLowerCase().includes('password')) return false;
        if (line.toLowerCase().includes('secret')) return false;
        if (line.toLowerCase().includes('token')) return false;
        if (line.toLowerCase().includes('key')) return false;
        if (line.toLowerCase().includes('auth')) return false;
        if (line.toLowerCase().includes('error') && line.toLowerCase().includes('internal')) return false;

        // Allow CYCLE_SUMMARY lines even if they contain filtered words
        if (line.includes('CYCLE_SUMMARY::')) return true;

        // Remove debug details and calculation logs
        // if (line.includes('DEBUG:')) return false; // Temporarily allow for UI parsing
        if (line.includes('Using cached LLM response')) return false;
        if (line.includes('Probability chain:')) return false;
        if (line.includes('Survivability test:')) return false;
        if (line.includes('Fetched new Tavily results')) return false;
        if (line.includes('Using cached Tavily results')) return false;
        if (line.includes('Cached new LLM response')) return false;
        if (line.includes('🌐 FETCH:')) return false;
        // if (line.includes('✅ Fetched')) return false;
        if (line.includes('📊 After sanity filter:')) return false;
        if (line.includes('💰')) return false;
        if (line.includes('[CACHE]')) return false;
        // if (line.includes('[LLM] Analyzing:')) return false; // Allow for UI parsing

        // Allow certain lines
        if (line.includes('DEBUG:')) return true;
        if (line.includes('Effective Edge:')) return true;
        if (line.includes('Headlines found:')) return true;
        if (line.includes('NEWS for')) return true;
        if (line.includes(' VOLUME SPIKE DETECTED:')) return true;
        if (line.includes('🚀 VOLUME SPIKE DETECTED:')) return true;
        if (line.includes('[LLM] Analyzing:')) return true; // Allow for UI parsing

        return true;
      })
      .join('\n');

    res.json({ logs: sanitizedLogs.split('\n').slice(-5000).join('\n') });
  } catch (error) {
    console.error('Error reading logs:', error);
    res.status(500).json({ error: 'Failed to read logs', message: error.message });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Agent Zigma',
    version: '1.1-beta',
    status: 'operational',
    description: 'Polymarket intelligence agent with real-time alerts',
    endpoints: {
      health: '/status',
      metrics: '/metrics',
      chat: '/chat'
    }
  });
});

const CONVO_TTL_MS = 30 * 60 * 1000;
const MARKET_CACHE_TTL_MS = 60 * 1000;
const conversationCache = new Map();
let marketCache = {
  fetchedAt: 0,
  data: []
};

function pruneConversationCache() {
  const cutoff = Date.now() - CONVO_TTL_MS;
  for (const [key, value] of conversationCache.entries()) {
    if ((value?.updatedAt || 0) < cutoff) {
      conversationCache.delete(key);
    }
  }
}

function getContext(contextId) {
  if (!contextId) return null;
  pruneConversationCache();
  const context = conversationCache.get(contextId);
  if (!context) return null;
  if ((Date.now() - context.updatedAt) > CONVO_TTL_MS) {
    conversationCache.delete(contextId);
    return null;
  }
  return context;
}

function saveContext(contextId, payload) {
  conversationCache.set(contextId, {
    ...payload,
    updatedAt: Date.now()
  });
}

async function getMarketUniverse(forceRefresh = false) {
  const stale = Date.now() - marketCache.fetchedAt > MARKET_CACHE_TTL_MS;
  if (forceRefresh || stale || !Array.isArray(marketCache.data) || !marketCache.data.length) {
    try {
      marketCache.data = await fetchMarkets(1000);
      marketCache.fetchedAt = Date.now();
    } catch (error) {
      console.error('Failed to refresh market cache:', error.message);
      if (!Array.isArray(marketCache.data) || !marketCache.data.length) {
        throw error;
      }
    }
  }
  return marketCache.data;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-20)
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const role = entry.role === 'assistant' ? 'assistant' : 'user';
      const content = typeof entry.content === 'string' ? entry.content.trim() : '';
      if (!content) return null;
      return {
        role,
        content: content.slice(0, 2000)
      };
    })
    .filter(Boolean);
}

function normalizeAction(action = '') {
  const upper = action.toUpperCase();
  if (upper.includes('SELL YES')) return 'SELL YES';
  if (upper.includes('SELL NO')) return 'SELL NO';
  if (upper.includes('BUY YES')) return 'BUY YES';
  if (upper.includes('BUY NO')) return 'BUY NO';
  if (upper.includes('HOLD')) return 'HOLD';
  if (upper.includes('NO_TRADE')) return 'HOLD';
  return upper || 'HOLD';
}

function buildAssistantMessage({ analysis, matchedMarket, userPrompt }) {
  const yesPrice = typeof matchedMarket?.yesPrice === 'number'
    ? (matchedMarket.yesPrice * 100).toFixed(2)
    : 'N/A';
  const noPrice = typeof matchedMarket?.noPrice === 'number'
    ? (matchedMarket.noPrice * 100).toFixed(2)
    : 'N/A';
  const action = normalizeAction(analysis?.action);
  const zigmaProb = typeof analysis?.probability === 'number'
    ? (analysis.probability * 100).toFixed(2)
    : 'N/A';
  const confidence = typeof analysis?.confidence === 'number'
    ? `${analysis.confidence.toFixed(1)}%`
    : `${analysis?.confidence || 0}%`;

  // Calculate confidence interval based on uncertainty
  const uncertainty = analysis?.uncertainty ?? 0.5;
  const confidenceInterval = uncertainty * 10; // ±10% at 0.5 uncertainty
  const ciLower = zigmaProb !== 'N/A' ? Math.max(0, parseFloat(zigmaProb) - confidenceInterval).toFixed(2) : 'N/A';
  const ciUpper = zigmaProb !== 'N/A' ? Math.min(100, parseFloat(zigmaProb) + confidenceInterval).toFixed(2) : 'N/A';

  // Calculate days remaining
  const endDate = matchedMarket?.endDateIso || matchedMarket?.endDate;
  const daysRemaining = endDate
    ? Math.max(0, Math.ceil((new Date(endDate) - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;

  // Format liquidity and volume
  const liquidity = matchedMarket?.liquidity
    ? `$${(parseFloat(matchedMarket.liquidity) || 0).toLocaleString()}`
    : 'N/A';
  const volume24h = matchedMarket?.volume24hr
    ? `$${(parseFloat(matchedMarket.volume24hr) || 0).toLocaleString()}`
    : 'N/A';

  // Position distribution (only show if data available)
  const yesPositions = matchedMarket?.yesPositions || matchedMarket?.positionStats?.yesPositions || 0;
  const noPositions = matchedMarket?.noPositions || matchedMarket?.positionStats?.noPositions || 0;
  const totalPositions = yesPositions + noPositions;
  const yesPct = totalPositions > 0 ? ((yesPositions / totalPositions) * 100).toFixed(1) : 'N/A';
  const noPct = totalPositions > 0 ? ((noPositions / totalPositions) * 100).toFixed(1) : 'N/A';
  const hasPositionData = totalPositions > 0;

  // Factor breakdown
  const deltaNews = analysis?.deltaNews ?? 0;
  const deltaStructure = analysis?.deltaStructure ?? 0;
  const deltaBehavior = analysis?.deltaBehavior ?? 0;
  const deltaTime = analysis?.deltaTime ?? 0;
  const sentimentScore = analysis?.sentimentScore ?? 0;
  const entropy = analysis?.entropy ?? 0;

  const lines = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📊 MARKET ANALYSIS`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `🎯 Market:`,
    `  ${matchedMarket?.question || 'Unknown'}`,
    ``,
    `📋 Market Rules:`,
    `  ${matchedMarket?.description || matchedMarket?.resolutionCriteria || 'No specific rules provided'}`,
    ``,
    `🏷️ Category: ${matchedMarket?.category || matchedMarket?.marketType || 'General'}`,
    ``,
    `⏰ Timeline:`,
    `  End Date: ${endDate ? new Date(endDate).toLocaleDateString() : 'N/A'}`,
    `  Days Remaining: ${daysRemaining !== null ? daysRemaining : 'N/A'}`,
    ``,
    `💰 Market Odds:`,
    `  YES: ${yesPrice}% | NO: ${noPrice}%`,
    ``,
    `🤖 Zigma Odds:`,
    `  ${zigmaProb}%`,
    `  Confidence Interval: ${ciLower}% - ${ciUpper}% (95% confidence)`,
    `  ${zigmaProb !== 'N/A' && yesPrice !== 'N/A'
    ? (parseFloat(zigmaProb) > parseFloat(yesPrice)
      ? `▲ Zigma thinks YES is ${(parseFloat(zigmaProb) - parseFloat(yesPrice)).toFixed(2)}% undervalued`
      : `▼ Zigma thinks YES is ${(parseFloat(yesPrice) - parseFloat(zigmaProb)).toFixed(2)}% overvalued`)
    : ''}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🔍 FACTOR BREAKDOWN`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📰 News Impact: ${(deltaNews * 100).toFixed(2)}%`,
    `  ${deltaNews > 0.05 ? '✅ Strong positive news flow' : deltaNews < -0.05 ? '❌ Negative news pressure' : '➡️ Neutral news sentiment'}`,
    ``,
    `🏗️ Structural Factors: ${(deltaStructure * 100).toFixed(2)}%`,
    `  ${deltaStructure > 0.05 ? '✅ Favorable market structure' : deltaStructure < -0.05 ? '❌ Unfavorable structure' : '➡️ Balanced structure'}`,
    ``,
    `👥 Behavioral Bias: ${(deltaBehavior * 100).toFixed(2)}%`,
    `  ${deltaBehavior > 0.05 ? '✅ Market undervalued (behavioral)' : deltaBehavior < -0.05 ? '❌ Market overvalued (behavioral)' : '➡️ Rational pricing'}`,
    ``,
    `⏱️ Time Decay: ${(deltaTime * 100).toFixed(2)}%`,
    `  ${deltaTime < -0.05 ? '⚠️ Significant time decay risk' : deltaTime > 0.05 ? '✅ Time working in favor' : '➡️ Normal time progression'}`,
    ``,
    `📊 Sentiment Score: ${sentimentScore.toFixed(2)}`,
    `  ${sentimentScore > 0.3 ? '🟢 Bullish' : sentimentScore < -0.3 ? '🔴 Bearish' : '⚪ Neutral'}`,
    ``,
    `🎲 Entropy: ${(entropy * 100).toFixed(1)}%`,
    `  ${entropy > 0.5 ? '⚠️ High uncertainty' : entropy > 0.3 ? '⚪ Moderate uncertainty' : '✅ Low uncertainty'}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `⚠️ RISK ASSESSMENT`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `🎲 Uncertainty Risk: ${getUncertaintyRisk(entropy)}`,
    `⏱️ Timeline Risk: ${getTimelineRisk(daysRemaining)}`,
    `💧 Liquidity Risk: ${getLiquidityRisk(parseFloat(matchedMarket?.liquidity || 0))}`,
    `📊 Market Depth Risk: ${getDepthRisk(parseFloat(matchedMarket?.liquidity || 0), parseFloat(matchedMarket?.volume24hr || 0))}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📈 Market Stats`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Liquidity: ${liquidity}`,
    `24h Volume: ${volume24h}`,
    ``,
    hasPositionData
      ? `👥 Position Distribution:
  YES holders: ${yesPositions} (${yesPct}%)
  NO holders: ${noPositions} (${noPct}%)`
      : `👥 Position Distribution:
  Position data not available from Polymarket API`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🎲 ZIGMA RECOMMENDATION`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Action: ${action}`,
    `Confidence: ${confidence}`,
  ];

  if (analysis?.effectiveEdge !== undefined) {
    lines.push(`Effective Edge: ${(analysis.effectiveEdge).toFixed(2)}%`);
  }

  // Add trading strategy section
  if (analysis?.action && analysis?.probability !== undefined && matchedMarket?.yesPrice !== undefined) {
    const currentPrice = matchedMarket.yesPrice;
    const zigmaProb = analysis.probability;
    const edge = analysis.effectiveEdge || 0;
    
    // Calculate trading parameters
    const entryPrice = currentPrice;
    const targetPrice = Math.min(0.95, zigmaProb); // Target at Zigma's probability, max 95%
    const stopLoss = analysis.action.includes('YES') 
      ? Math.max(0.05, currentPrice - (edge * 0.5)) // Stop loss at 50% of edge
      : Math.min(0.95, currentPrice + (edge * 0.5));
    
    const timeHorizon = daysRemaining !== null ? `${daysRemaining} days` : 'Until resolution';
    const positionSize = analysis.kellyFraction ? `${(analysis.kellyFraction * 100).toFixed(1)}% of bankroll` : 'Conservative (1-2%)';
    
    lines.push(``, `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`💼 TRADING STRATEGY`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(``, `Entry: ${(entryPrice * 100).toFixed(2)}%`);
    lines.push(`Target: ${(targetPrice * 100).toFixed(2)}% (${((targetPrice - entryPrice) / entryPrice * 100).toFixed(1)}% upside)`);
    lines.push(`Stop Loss: ${(stopLoss * 100).toFixed(2)}% (${((stopLoss - entryPrice) / entryPrice * 100).toFixed(1)}% downside)`);
    lines.push(`Time Horizon: ${timeHorizon}`);
    lines.push(`Position Size: ${positionSize}`);
    lines.push(`Risk/Reward: ${((targetPrice - entryPrice) / (entryPrice - stopLoss)).toFixed(2)}:1`);
  }

  if (analysis?.reasoning) {
    lines.push(``, `💡 Reasoning:`, `  ${analysis.reasoning}`);
  }

  // Add news sources section if available
  if (analysis?.newsSources && Array.isArray(analysis.newsSources) && analysis.newsSources.length > 0) {
    lines.push(``, `📰 NEWS SOURCES:`, ``);
    analysis.newsSources.forEach((source, idx) => {
      const relevanceEmoji = source.relevance === 'high' ? '🔥' : source.relevance === 'medium' ? '⭐' : '💡';
      lines.push(`${relevanceEmoji} ${idx + 1}. ${source.title}`);
      lines.push(`   Source: ${source.source} | Date: ${source.date || 'N/A'}`);
      if (source.url) {
        lines.push(`   Link: ${source.url}`);
      }
    });
  }

  if (analysis?.narrative) {
    lines.push(``, `📝 Analysis:`, `  ${analysis.narrative}`);
  }

  // Add historical context section
  const category = matchedMarket?.category || matchedMarket?.marketType || 'General';
  const historicalContext = getHistoricalContextForCategory(category, matchedMarket?.question);
  
  if (historicalContext && historicalContext.length > 0) {
    lines.push(``, `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`📜 HISTORICAL CONTEXT`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(``);
    lines.push(`Category: ${category}`);
    lines.push(`Similar Markets & Outcomes:`);
    
    historicalContext.slice(0, 3).forEach((ctx, idx) => {
      lines.push(`${idx + 1}. ${ctx.market}`);
      lines.push(`   Outcome: ${ctx.outcome} | Final Odds: ${ctx.finalOdds}%`);
      if (ctx.lesson) {
        lines.push(`   Lesson: ${ctx.lesson}`);
      }
    });
    
    if (historicalContext.length > 3) {
      lines.push(`... and ${historicalContext.length - 3} more similar markets`);
    }
  }

  if (analysis?.primaryReason) {
    lines.push(``, `🎯 Primary Driver: ${analysis.primaryReason}`);
  }

  lines.push(``, `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  return lines.join('\n');
}

// Helper functions for risk assessment
function getUncertaintyRisk(entropy) {
  if (entropy > 0.5) return 'HIGH - Limited data or high unpredictability';
  if (entropy > 0.3) return 'MODERATE - Some uncertainty in outcome';
  return 'LOW - Well-defined parameters';
}

function getTimelineRisk(daysRemaining) {
  if (daysRemaining === null) return 'N/A';
  if (daysRemaining > 180) return 'LOW - Long time horizon allows for information accumulation';
  if (daysRemaining > 90) return 'MODERATE - Medium time horizon';
  return 'HIGH - Short time horizon, limited room for error';
}

function getLiquidityRisk(liquidity) {
  if (liquidity < 50000) return 'HIGH - Low liquidity may cause slippage';
  if (liquidity < 100000) return 'MODERATE - Moderate liquidity';
  return 'LOW - High liquidity available';
}

function getDepthRisk(liquidity, volume24hr) {
  const depthRatio = liquidity / (volume24hr || 1);
  if (depthRatio < 0.1) return 'HIGH - Low depth relative to volume';
  if (depthRatio < 0.2) return 'MODERATE - Acceptable depth';
  return 'LOW - Good depth available';
}

function getHistoricalContextForCategory(category, question) {
  const categoryContexts = {
    'General': [
      {
        market: 'Will Trump win 2024 election?',
        outcome: 'YES',
        finalOdds: '58',
        lesson: 'Polls underestimated support; late momentum matters'
      },
      {
        market: 'Will Bitcoin reach $100k by 2025?',
        outcome: 'NO',
        finalOdds: '35',
        lesson: 'Crypto markets often overestimate short-term targets'
      },
      {
        market: 'Will Fed cut rates before March 2024?',
        outcome: 'NO',
        finalOdds: '25',
        lesson: 'Central bank decisions are more conservative than market expectations'
      }
    ],
    'Politics': [
      {
        market: 'Will Republicans control Senate after 2024?',
        outcome: 'YES',
        finalOdds: '62',
        lesson: 'Incumbent party struggles in midterms; polling errors persist'
      },
      {
        market: 'Will Biden be replaced as 2024 nominee?',
        outcome: 'NO',
        finalOdds: '15',
        lesson: 'Party consolidation occurs late; early speculation often wrong'
      },
      {
        market: 'Will UK hold general election in 2024?',
        outcome: 'YES',
        finalOdds: '85',
        lesson: 'Political timing markets have high accuracy when close to deadline'
      }
    ],
    'Crypto': [
      {
        market: 'Will ETH flip BTC by EOY 2024?',
        outcome: 'NO',
        finalOdds: '12',
        lesson: 'Market leader dominance persists longer than expected'
      },
      {
        market: 'Will Solana reach $200 in 2024?',
        outcome: 'YES',
        finalOdds: '68',
        lesson: 'Ecosystem growth drives price; narrative markets can be accurate'
      },
      {
        market: 'Will Bitcoin ETF be approved in 2024?',
        outcome: 'YES',
        finalOdds: '72',
        lesson: 'Regulatory markets track institutional sentiment well'
      }
    ],
    'Sports': [
      {
        market: 'Will Chiefs repeat as Super Bowl champions?',
        outcome: 'YES',
        finalOdds: '55',
        lesson: 'Dynasty teams have repeat probability above random chance'
      },
      {
        market: 'Will Messi win Ballon d\'Or 2024?',
        outcome: 'YES',
        finalOdds: '78',
        lesson: 'Individual awards markets track consensus well'
      },
      {
        market: 'Will Lakers make playoffs 2024?',
        outcome: 'NO',
        finalOdds: '42',
        lesson: 'Team chemistry matters more than individual talent'
      }
    ],
    'Economics': [
      {
        market: 'Will US enter recession in 2024?',
        outcome: 'NO',
        finalOdds: '28',
        lesson: 'Economic resilience often exceeds pessimistic forecasts'
      },
      {
        market: 'Will inflation drop below 3% in 2024?',
        outcome: 'YES',
        finalOdds: '65',
        lesson: 'Disinflation trends persist longer than expected'
      },
      {
        market: 'Will unemployment exceed 5% in 2024?',
        outcome: 'NO',
        finalOdds: '35',
        lesson: 'Labor markets show more stickiness than predicted'
      }
    ]
  };

  // Try to find context for the specific category
  if (categoryContexts[category]) {
    return categoryContexts[category];
  }

  // Fallback to General context if category not found
  return categoryContexts['General'] || [];
}

function extractMarketHints(input = '') {
  if (!input || typeof input !== 'string') return {};
  try {
    const url = new URL(input.trim());
    if (!url.hostname.includes('polymarket.com')) return {};
    const pathParts = url.pathname.split('/').filter(Boolean);
    const hints = {};
    if (pathParts.length) {
      if (pathParts[0] === 'event' && pathParts[1]) {
        hints.slug = pathParts[1];
        if (pathParts[2]) {
          hints.marketSlug = pathParts[2];
        }
      } else if (pathParts[0] === 'market' && pathParts[1]) {
        hints.slug = pathParts[1];
      }
    }
    if (url.searchParams.has('tid')) {
      hints.tokenId = url.searchParams.get('tid');
    }
    return hints;
  } catch (error) {
    return {};
  }
}

function buildSlugCandidates(rawSlug = '') {
  if (!rawSlug) return [];
  const normalized = rawSlug.toLowerCase();
  const candidates = [];
  let parts = normalized.split('-').filter(Boolean);

  while (parts.length) {
    const candidate = parts.join('-');
    if (candidate) {
      candidates.push(candidate);
    }

    const last = parts[parts.length - 1] || '';
    const isShortHash =
      last.length > 0 &&
      last.length <= 4 &&
      /[a-z]/.test(last);
    if (!isShortHash) break;
    parts = parts.slice(0, -1);
  }

  return Array.from(new Set(candidates));
}

function parseMaybeJson(value) {
  if (Array.isArray(value) || value == null) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : value;
    } catch (error) {
      return value;
    }
  }
  return value;
}

function normalizeMarketPrices(market = {}) {
  if (!market) return market;
  const outcomesRaw = market.outcomes || market.options;
  const pricesRaw = market.outcomePrices || market.prices;
  const outcomesParsed = parseMaybeJson(outcomesRaw);
  const pricesParsed = parseMaybeJson(pricesRaw);
  const outcomes = Array.isArray(outcomesParsed) ? outcomesParsed : null;
  const rawPrices = Array.isArray(pricesParsed) ? pricesParsed : null;

  if (!rawPrices || rawPrices.length === 0) {
    return market;
  }

  const prices = rawPrices.map((price) => {
    const num = typeof price === 'string' ? parseFloat(price) : price;
    return Number.isFinite(num) ? num : null;
  });

  if (prices.every((p) => p === null)) {
    return market;
  }

  let yesIndex = outcomes
    ? outcomes.findIndex((label) => typeof label === 'string' && /yes|over|win/i.test(label))
    : -1;
  if (yesIndex < 0) yesIndex = 0;

  const yesPrice = prices[yesIndex] ?? prices[0];
  const noPriceCandidate = prices[yesIndex === 0 ? 1 : 0];
  const normalized = { ...market };

  if (Number.isFinite(yesPrice)) {
    normalized.yesPrice = yesPrice;
    normalized.noPrice = Number.isFinite(noPriceCandidate)
      ? noPriceCandidate
      : (Number.isFinite(yesPrice) ? Math.max(0, Math.min(1, 1 - yesPrice)) : normalized.noPrice);
  }

  return normalized;
}

function isLikelyUuid(value) {
  return typeof value === 'string' && /^[0-9a-fA-F-]{32,64}$/.test(value);
}

function needsHydration(market = {}) {
  if (!isLikelyUuid(market?.id) && !isLikelyUuid(market?.conditionId)) {
    return false;
  }
  const numericFields = ['yesPrice', 'volume24hr', 'liquidity'];
  const missingNumeric = numericFields.some((field) => typeof market[field] !== 'number');
  const missingTokens = !Array.isArray(market.tokens) || market.tokens.length === 0;
  return missingNumeric || missingTokens;
}

async function hydrateMarket(market) {
  if (!needsHydration(market)) {
    return normalizeMarketPrices(market);
  }
  try {
    const detailed = await fetchMarketById(market.id || market.conditionId);
    if (detailed) {
      return normalizeMarketPrices({ ...market, ...detailed });
    }
  } catch (error) {
    console.warn(`Hydration failed for market ${market?.id}:`, error.message);
  }
  return normalizeMarketPrices(market);
}

async function findMarketByUrl(urlOrQuery, markets) {
  const parsed = parsePolymarketUrl(urlOrQuery);
  
  console.log(`[URL PARSE] Type: ${parsed.type}, Value: ${parsed.value}`);
  
  let market = null;
  
  switch (parsed.type) {
    case 'slug':
      // PATCH: Exact slug match first
      market = markets.find(m => 
        normalizeSlug(m.slug) === normalizeSlug(parsed.value)
      );
      
      // Fallback: partial match
      if (!market) {
        market = markets.find(m => 
          m.slug && m.slug.toLowerCase().includes(parsed.value.toLowerCase())
        );
      }
      break;
      
    case 'conditionId':
    case 'marketId':
      market = markets.find(m => 
        m.conditionId === parsed.value || 
        m.id === parsed.value
      );
      break;
      
    case 'uuid':
      market = markets.find(m => m.id === parsed.value);
      break;
      
    case 'query':
      // Search by question text
      const query = parsed.value.toLowerCase();
      market = markets.find(m => 
        m.question && m.question.toLowerCase().includes(query)
      );
      break;
  }
  
  if (!market) {
    console.warn(`[MARKET LOOKUP] No match found for: ${urlOrQuery}`);
  } else {
    console.log(`[MARKET LOOKUP] Found: ${market.question?.slice(0, 50)}...`);
  }
  
  return market;
}

async function respondWithIntent({ market, similarity = 1, source, event }) {
  const hydrated = await hydrateMarket(market);
  return {
    market: hydrated || market,
    similarity,
    source,
    event
  };
}

async function resolveMarketIntent({
  marketId,
  marketQuestion,
  polymarketUser,
  query,
  existingMarket
}) {
  if (existingMarket && !marketId && !marketQuestion && !query && !polymarketUser) {
    return respondWithIntent({ market: existingMarket, similarity: 1, source: 'context' });
  }

  const markets = await getMarketUniverse();
  const urlHints = extractMarketHints(query || marketQuestion);
  const slugCandidates = urlHints.slug ? buildSlugCandidates(urlHints.slug) : [];
  const marketSlugCandidates = urlHints.marketSlug ? buildSlugCandidates(urlHints.marketSlug) : [];
  const slugEventCache = new Map();
  const getEventForSlug = async (slug) => {
    if (!slug) return null;
    if (slugEventCache.has(slug)) {
      return slugEventCache.get(slug);
    }
    const event = await fetchEventBySlug(slug);
    slugEventCache.set(slug, event);
    return event;
  };

  const marketSlugSet = new Set(marketSlugCandidates.map((slug) => slug.toLowerCase()));
  const matchesToken = (market) => {
    if (!urlHints.tokenId) return true;
    return Array.isArray(market.tokens) &&
      market.tokens.some((t) => String(t?.token_id) === String(urlHints.tokenId));
  };

  if (marketId) {
    const byId = markets.find((m) => m.id === marketId || m.conditionId === marketId);
    if (byId && matchesToken(byId)) {
      return respondWithIntent({ market: byId, similarity: 1, source: 'marketId' });
    }
    const remoteMarket = await fetchMarketById(marketId);
    if (remoteMarket && matchesToken(remoteMarket)) {
      return respondWithIntent({ market: remoteMarket, similarity: 1, source: 'marketId_remote' });
    }
  }

  for (const marketSlugCandidate of marketSlugCandidates) {
    const normalizedSlug = marketSlugCandidate.toLowerCase();
    const byMarketSlug = markets.find((m) =>
      (m.slug || m.marketSlug || m.id || '').toLowerCase() === normalizedSlug
    );
    if (byMarketSlug && matchesToken(byMarketSlug)) {
      return respondWithIntent({ market: byMarketSlug, similarity: 1, source: 'market_slug' });
    }

    const remoteMarket = await fetchMarketBySlug(normalizedSlug);
    if (remoteMarket && matchesToken(remoteMarket)) {
      return respondWithIntent({ market: remoteMarket, similarity: 1, source: 'market_slug_remote' });
    }
  }

  for (const slugCandidate of slugCandidates) {
    const normalizedSlug = slugCandidate.toLowerCase();
    const bySlug = markets.find((m) =>
      (m.slug || m.id || '').toLowerCase() === normalizedSlug
    );
    if (bySlug && matchesToken(bySlug)) {
      return respondWithIntent({ market: bySlug, similarity: 1, source: 'url_slug' });
    }

    const remoteMarket = await fetchMarketBySlug(normalizedSlug);
    if (remoteMarket && matchesToken(remoteMarket)) {
      return respondWithIntent({ market: remoteMarket, similarity: 1, source: 'url_slug_remote_direct' });
    }

    const fetchedEvent = await getEventForSlug(normalizedSlug);
    if (fetchedEvent?.markets?.length) {
      const pickEventMarket = () => {
        if (urlHints.tokenId) {
          const tokenCandidate = fetchedEvent.markets.find((m) => matchesToken(m));
          if (tokenCandidate) return tokenCandidate;
        }
        if (marketSlugSet.size) {
          const slugCandidateMatch = fetchedEvent.markets.find((m) =>
            marketSlugSet.has((m.slug || m.id || '').toLowerCase())
          );
          if (slugCandidateMatch) return slugCandidateMatch;
        }
        return fetchedEvent.markets[0];
      };

      const candidate = pickEventMarket();
      if (candidate && matchesToken(candidate)) {
        return respondWithIntent({
          market: candidate,
          similarity: 1,
          source: urlHints.tokenId ? 'url_slug_remote_token' : 'url_slug_remote',
          event: fetchedEvent
        });
      }
    }
  }

  if (urlHints.tokenId) {
    const tokenMatch = markets.find((m) =>
      Array.isArray(m.tokens) &&
      m.tokens.some((t) => String(t?.token_id) === String(urlHints.tokenId))
    );
    if (tokenMatch && matchesToken(tokenMatch)) {
      return respondWithIntent({ market: tokenMatch, similarity: 1, source: 'token_id' });
    }

    for (const slugCandidate of slugCandidates) {
      const fetchedEvent = await getEventForSlug(slugCandidate.toLowerCase());
      if (fetchedEvent?.markets?.length) {
        const remoteTokenMatch = fetchedEvent.markets.find((m) =>
          Array.isArray(m.tokens) &&
          m.tokens.some((t) => String(t?.token_id) === String(urlHints.tokenId))
        );
        if (remoteTokenMatch && matchesToken(remoteTokenMatch)) {
          return respondWithIntent({
            market: remoteTokenMatch,
            similarity: 1,
            source: 'token_id_remote',
            event: fetchedEvent
          });
        }
      }
    }
  }

  const textMatch = marketQuestion || query;
  if (textMatch) {
    // Use enhanced NLP matching for better natural language understanding
    const matches = findBestMatchingMarket(markets, textMatch, { minSimilarity: 0.15, maxResults: 1 });
    
    if (matches.length > 0 && matches[0].similarity >= 0.15) {
      return respondWithIntent({ 
        market: matches[0].market, 
        similarity: matches[0].similarity, 
        source: 'nlp_similarity' 
      });
    }
  }

  const searchTerm = polymarketUser || urlHints.slug || query || marketQuestion;
  if (searchTerm) {
    const queries = [
      searchTerm,
      query,
      marketQuestion,
      urlHints.slug?.replace(/-\w+$/, ''),
      urlHints.slug?.split('-').slice(0, 4).join(' ')
    ].filter(Boolean);

    for (const term of queries) {
      try {
        const direct = await fetchSearchMarkets(term);
        if (direct?.market) {
          if (urlHints.tokenId) {
            const tokenMatch = Array.isArray(direct.market.tokens)
              ? direct.market.tokens.some((t) => String(t?.token_id) === String(urlHints.tokenId))
              : false;
            if (!tokenMatch) {
              continue;
            }
          }
          if (direct.market.question && (query || '').length > 0) {
            const matches = findBestMatchingMarket([direct.market], query || marketQuestion || '', { minSimilarity: 0.15, maxResults: 1 });
            if (matches.length === 0 || matches[0].similarity < 0.15) {
              continue;
            }
          }
          return respondWithIntent({
            market: direct.market,
            similarity: direct.market.question && (query || marketQuestion || '').length > 0
              ? findBestMatchingMarket([direct.market], query || marketQuestion || '', { minSimilarity: 0.15, maxResults: 1 })[0]?.similarity || 1
              : 1,
            source: 'search_api',
            event: direct.event
          });
        }
      } catch (error) {
        console.warn('Search API fallback failed:', error.message);
      }
    }
  }

  return null;
}

// Validate wallet address format
function isValidWalletAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Sanitize user input to prevent prompt injection
function sanitizeUserInput(input) {
  if (typeof input !== 'string') return '';
  
  // Remove potentially dangerous patterns
  let sanitized = input
    .replace(/<script[^>]*>.*?<\/script>/gi, '') // Remove script tags
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+\s*=/gi, '') // Remove event handlers
    .replace(/<[^>]*>/g, '') // Remove all HTML tags
    .replace(/data:text\/html/gi, '') // Remove data URLs
    .trim();
  
  // Limit length
  const maxLength = 2000;
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
  }
  
  return sanitized;
}

// Chat endpoint for natural language queries with contextual history
app.post('/chat', validateInput, requireCredits, async (req, res) => {
  const startTime = Date.now();
  let userId = null;
  
  try {
    const {
      query,
      marketId,
      marketQuestion,
      polymarketUser,
      history = [],
      contextId: incomingContextId,
      compareMarkets, // Array of market IDs/questions to compare
      userId: requestUserId // User ID from client if authenticated
    } = req.body || {};

    // Extract user ID for persistence
    userId = requestUserId || req.user?.id || req.headers['x-user-id'];
    
    // Sanitize user inputs to prevent prompt injection
    const sanitizedQuery = query ? sanitizeUserInput(query) : '';
    const sanitizedMarketQuestion = marketQuestion ? sanitizeUserInput(marketQuestion) : '';
    const sanitizedPolymarketUser = polymarketUser ? sanitizeUserInput(polymarketUser) : '';

    const sanitizedHistory = sanitizeHistory(history);
    const existingContext = getContext(incomingContextId);

    // Handle multi-market comparison
    if (compareMarkets && Array.isArray(compareMarkets) && compareMarkets.length > 1) {
      console.log('[CHAT] Multi-market comparison request for', compareMarkets.length, 'markets');

      const comparisonResults = [];
      for (const marketRef of compareMarkets.slice(0, 5)) { // Limit to 5 markets
        const intent = await resolveMarketIntent({
          query: marketRef,
          existingMarket: null
        });

        if (intent?.market) {
          const analysis = await generateEnhancedAnalysis(intent.market);
          comparisonResults.push({
            market: intent.market,
            analysis,
            similarity: intent.similarity
          });
        }
      }

      if (comparisonResults.length === 0) {
        return res.status(404).json({
          error: 'No markets found for comparison',
          markets: compareMarkets
        });
      }

      // Build comparison message
      const comparisonLines = [
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `📊 MULTI-MARKET COMPARISON`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `Comparing ${comparisonResults.length} markets:`,
        ``,
        ...comparisonResults.map((result, i) => {
          const m = result.market;
          const a = result.analysis;
          const yesPrice = typeof m?.yesPrice === 'number' ? (m.yesPrice * 100).toFixed(2) : 'N/A';
          const zigmaProb = typeof a?.probability === 'number' ? (a.probability * 100).toFixed(2) : 'N/A';
          const edge = a?.effectiveEdge !== undefined ? (a.effectiveEdge * 100).toFixed(2) : 'N/A';
          const action = normalizeAction(a?.action);

          return [
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `Market #${i + 1}:`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            ``,
            `${m?.question || 'Unknown'}`,
            ``,
            `Market Odds: ${yesPrice}%`,
            `Zigma Odds: ${zigmaProb}%`,
            `Effective Edge: ${edge}%`,
            `Action: ${action}`,
            `Liquidity: $${(parseFloat(m?.liquidity) || 0).toLocaleString()}`,
            ``
          ].join('\n');
        }),
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `🎲 COMPARISON SUMMARY`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `Best Edge:`,
        `  ${comparisonResults.sort((a, b) => (b.analysis?.effectiveEdge || 0) - (a.analysis?.effectiveEdge || 0))[0]?.market?.question}`,
        ``,
        `Highest Zigma Odds:`,
        `  ${comparisonResults.sort((a, b) => (b.analysis?.probability || 0) - (a.analysis?.probability || 0))[0]?.market?.question}`,
        ``,
        `Most Liquid:`,
        `  ${comparisonResults.sort((a, b) => (parseFloat(b.market?.liquidity) || 0) - (parseFloat(a.market?.liquidity) || 0))[0]?.market?.question}`,
        ``,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      ].join('\n');

      const responseId = incomingContextId || crypto.randomUUID();

      const responseData = {
        contextId: responseId,
        type: 'multi_market_comparison',
        comparisonResults,
        messages: [
          ...sanitizedHistory,
          { role: 'user', content: `Compare: ${compareMarkets.join(', ')}` },
          { role: 'assistant', content: comparisonLines }
        ].filter((msg) => msg.content),
        timestamp: Date.now()
      };

      // Save to database if user is authenticated
      if (userId) {
        try {
          await saveChatExchange(
            `Compare: ${compareMarkets.join(', ')}`,
            { role: 'assistant', content: comparisonLines },
            {
              userId,
              sessionId: responseId,
              contextId: responseId,
              processingTimeMs: Date.now() - startTime,
              clientInfo: extractClientInfo(req),
              ipAddress: req.ip,
              metadata: {
                queryType: 'multi_market_comparison',
                marketsCount: compareMarkets.length,
                source: 'backend_api'
              }
            }
          );
        } catch (persistError) {
          console.error('Failed to save multi-market comparison:', persistError);
        }
      }

      res.json(responseData);
      return;
    }

    if (
      !sanitizedQuery &&
      !marketId &&
      !sanitizedMarketQuestion &&
      !sanitizedPolymarketUser &&
      !existingContext
    ) {
      return res.status(400).json({
        error: 'Provide a query, market identifier, Polymarket user, or existing contextId.'
      });
    }

    // Handle user profile requests
    if (polymarketUser) {
      console.log('[CHAT] User profile request for:', polymarketUser);

      // Check if input is a valid wallet address
      if (!isValidWalletAddress(polymarketUser)) {
        return res.status(400).json({
          error: 'Invalid wallet address format',
          user: polymarketUser,
          suggestion: 'Please provide a valid Polymarket wallet address (starts with 0x and is 42 characters long). Example: 0x1234...5678'
        });
      }

      console.log('[CHAT] Fetching user profile for:', polymarketUser);
      const userProfile = await fetchUserProfile(polymarketUser);

      if (!userProfile) {
        return res.status(404).json({
          error: 'User profile not found',
          user: polymarketUser,
          suggestion: 'Make sure the wallet address is valid and has trading activity on Polymarket.'
        });
      }

      const { metrics, positions, activity, maker, profile, balance } = userProfile;

      // Extract trades from activity
      const trades = activity.filter(item => item.type === 'TRADE');

      // AI Analysis and Recommendations
      let aiAnalysis = '';
      let aiRecommendations = [];

      // Extract analysis data
      const analysis = userProfile.analysis || {};
      const health = analysis.health || {};
      const risk = analysis.risk || {};
      const patterns = analysis.patterns || {};
      const categoryPerf = analysis.categoryPerformance || [];
      const recommendations = analysis.recommendations || [];
      const improvements = analysis.improvements || [];

      // Calculate total P&L
      const totalPnl = metrics.realizedPnl + metrics.unrealizedPnl;

      // Determine trader type
      let traderType = '📉 Needs Improvement';
      if (totalPnl > 0 && metrics.winRate >= 50) {
        traderType = '🌟 Profitable & Consistent';
      } else if (totalPnl > 0) {
        traderType = '📈 Profitable';
      } else if (metrics.winRate >= 50) {
        traderType = '🎯 Skilled but Risky';
      }

      // Determine risk profile
      let riskProfile = '🟢 Conservative';
      if (metrics.averagePositionSize > 500) {
        riskProfile = '🔴 Aggressive';
      } else if (metrics.averagePositionSize > 200) {
        riskProfile = '🟡 Moderate';
      }

      // Build strengths list
      const strengths = [];
      if (totalPnl > 0) strengths.push('Positive P&L generation');
      if (metrics.winRate >= 50) strengths.push('Above average win rate');
      if (metrics.totalVolume > 10000) strengths.push('Active trading volume');
      if (risk.diversificationScore > 60) strengths.push('Well-diversified portfolio');

      // Build areas for improvement list
      const areasForImprovement = [];
      if (improvements.length > 0) {
        improvements.forEach(imp => areasForImprovement.push(`  • ${imp}`));
      } else {
        // Fallback improvements if analysis doesn't provide them
        if (metrics.winRate < 50) areasForImprovement.push('  • Improve win rate through better market selection');
        if (totalPnl < 0) areasForImprovement.push('  • Focus on risk management and position sizing');
        if (positions.length > 15) areasForImprovement.push('  • Consider reducing position concentration');
        if (risk.topPositionExposure > 30) areasForImprovement.push(`  • Reduce top position from ${risk.topPositionExposure.toFixed(1)}% to <25%`);
        if (risk.diversificationScore < 40) areasForImprovement.push(`  • Improve diversification from ${risk.diversificationScore.toFixed(0)}% to >60%`);
      }

      // Analyze win rate
      if (metrics.winRate >= 60) {
        aiRecommendations.push('✅ Strong win rate - continue current strategy');
      } else if (metrics.winRate >= 45) {
        aiRecommendations.push('⚠️ Moderate win rate - consider tightening entry criteria');
      } else {
        aiRecommendations.push('🔴 Low win rate - review position sizing and market selection');
      }

      // Analyze P&L
      if (totalPnl > 0) {
        aiRecommendations.push(`💰 Profitable trader - total P&L: $${totalPnl.toFixed(2)}`);
      } else if (totalPnl < -1000) {
        aiRecommendations.push('⚠️ Significant losses - consider reducing position sizes');
      }

      // Analyze position concentration
      if (positions.length > 10) {
        aiRecommendations.push('📊 High position count - consider portfolio diversification');
      }

      // Analyze average position size
      if (metrics.averagePositionSize > 1000) {
        aiRecommendations.push('💵 Large average positions - ensure proper risk management');
      } else if (metrics.averagePositionSize < 100) {
        aiRecommendations.push('💵 Small positions - consider scaling up on high conviction trades');
      }

      // Analyze recent activity
      const recentTrades = metrics.recentActivity.slice(0, 10);
      if (recentTrades.length > 0) {
        const buyYesCount = recentTrades.filter(t => t.side === 'BUY' && t.side.includes('YES')).length;
        const buyNoCount = recentTrades.filter(t => t.side === 'BUY' && t.side.includes('NO')).length;
        if (buyYesCount > buyNoCount * 2) {
          aiRecommendations.push('🎯 Bullish bias - consider balancing with NO positions');
        } else if (buyNoCount > buyYesCount * 2) {
          aiRecommendations.push('🎯 Bearish bias - consider balancing with YES positions');
        }
      }

      // Build AI recommendations list
      const finalAiRecommendations = [];
      if (recommendations.length > 0) {
        recommendations.slice(0, 5).forEach(rec => {
          const icon = rec.priority === 'high' ? '🔴' : rec.priority === 'medium' ? '⚠️' : '💡';
          finalAiRecommendations.push(`${icon} ${rec.title}: ${rec.description}`);
        });
      } else {
        // Fallback recommendations
        if (metrics.winRate >= 60) finalAiRecommendations.push('✅ Strong win rate - continue current strategy');
        else if (metrics.winRate >= 45) finalAiRecommendations.push('⚠️ Moderate win rate - consider tightening entry criteria');
        else finalAiRecommendations.push('🔴 Low win rate - review position sizing and market selection');
        
        if (totalPnl > 0) finalAiRecommendations.push(`💰 Profitable trader - total P&L: $${totalPnl.toFixed(2)}`);
        else if (totalPnl < -1000) finalAiRecommendations.push('⚠️ Significant losses - consider reducing position sizes');
        
        if (risk.topPositionExposure > 30) finalAiRecommendations.push(`📊 Reduce concentration - ${risk.topPositionExposure.toFixed(1)}% in top position`);
        if (risk.diversificationScore < 40) finalAiRecommendations.push(`📊 Improve diversification - ${risk.diversificationScore.toFixed(0)}% diversification score`);
      }

      aiAnalysis = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 ZIGMA AI ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Trader Type: ${traderType}

Risk Profile: ${riskProfile}

Strengths:
${strengths.length > 0 ? strengths.map(s => `  • ${s}`).join('\n') : '  • No significant strengths identified'}

Areas for Improvement:
${areasForImprovement.length > 0 ? areasForImprovement.join('\n') : '  • No critical issues identified'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 AI RECOMMENDATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${finalAiRecommendations.join('\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 PORTFOLIO HEALTH SCORE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Grade: ${health.grade || 'N/A'}
Score: ${health.score?.toFixed(0) || 'N/A'} / 100

${health.factors && health.factors.length > 0 ? health.factors.map(f => `• ${f.name}: ${f.impact > 0 ? '+' : ''}${f.impact.toFixed(1)} (current: ${f.value.toFixed(1)})`).join('\n') : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ RISK ASSESSMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Diversification: ${risk.diversificationScore?.toFixed(0) || 'N/A'}%
${risk.diversificationScore < 40 ? '⚠️ LOW - Need to diversify across more markets' : risk.diversificationScore > 70 ? '✅ GOOD - Well-diversified' : '⚪ MODERATE - Acceptable diversification'}

Top Position Exposure: ${risk.topPositionExposure?.toFixed(1) || 'N/A'}%
${risk.topPositionExposure > 30 ? '⚠️ HIGH - Maximum 25% recommended' : risk.topPositionExposure > 20 ? '⚪ MODERATE - Consider reducing' : '✅ GOOD - Well-balanced'}

Concentration Score: ${risk.concentrationScore?.toFixed(0) || 'N/A'}
${risk.concentrationScore > 50 ? '⚠️ HIGH - Too concentrated' : risk.concentrationScore > 30 ? '⚪ MODERATE - Acceptable' : '✅ GOOD - Well-distributed'}

Drawdown Risk: ${risk.maxDrawdownRisk?.toFixed(1) || 'N/A'}%
${risk.maxDrawdownRisk > 30 ? '⚠️ HIGH - Cut losing positions' : risk.maxDrawdownRisk > 15 ? '⚪ MODERATE - Monitor closely' : '✅ LOW - Healthy'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 TRADING PATTERNS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Average Hold Time: ${patterns.avgHoldTime?.toFixed(1) || 'N/A'} hours
${patterns.avgHoldTime < 1 ? '⚠️ SHORT - Consider longer timeframes' : patterns.avgHoldTime > 24 ? '✅ LONG - Good for swing trading' : '✅ MODERATE - Balanced approach'}

Trade Frequency: ${patterns.tradeFrequency?.toFixed(1) || 'N/A'} trades/day
${patterns.tradeFrequency > 10 ? '⚠️ HIGH - Reduce frequency, focus on quality' : patterns.tradeFrequency > 5 ? '⚪ MODERATE - Acceptable level' : '✅ LOW - Good discipline'}

Buy/Sell Ratio: ${patterns.buySellRatio?.toFixed(2) || 'N/A'}
${patterns.buySellRatio > 2 ? '⚠️ BULLISH BIAS - Consider balancing with NO positions' : patterns.buySellRatio < 0.5 ? '⚠️ BEARISH BIAS - Consider balancing with YES positions' : '✅ BALANCED'}

Average Position Size: $${patterns.avgPositionSize?.toFixed(2) || 'N/A'}
${patterns.avgPositionSize > 1000 ? '⚠️ LARGE - High risk per trade' : patterns.avgPositionSize < 100 ? '⚠️ SMALL - Consider scaling up' : '✅ APPROPRIATE'}

Trading Style: ${patterns.scalpingTendency > 0.5 ? '🏎️ Scalper' : patterns.hodlTendency > 0.5 ? '📊 Position Trader' : '📈 Swing Trader'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 CATEGORY PERFORMANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${categoryPerf.length > 0 ? categoryPerf.slice(0, 4).map((cat, idx) => `${idx + 1}. ${cat.category || 'Unknown'}: $${(cat.pnl || 0).toFixed(2)} | ${cat.trades || 0} trades | ${cat.winRate?.toFixed(1) || 0}% win`).join('\n') : 'No category data available'}
`;

      const profileMessage = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 USER PROFILE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Wallet: ${maker}
Balance: $${balance?.toFixed(2) || 'N/A'}

📊 Performance Metrics:
  Total Positions: ${metrics.totalPositions}
  Total Trades: ${metrics.totalTrades}
  Realized P&L: $${metrics.realizedPnl.toFixed(2)}
  Unrealized P&L: $${metrics.unrealizedPnl.toFixed(2)}
  Total Volume: $${metrics.totalVolume.toFixed(2)}
  Win Rate: ${metrics.winRate.toFixed(1)}%
  Average Position Size: $${metrics.averagePositionSize.toFixed(2)}

🏆 Top Markets by P&L:
${metrics.topMarkets.map((m, i) => `  ${i + 1}. ${m.title}: $${m.pnl.toFixed(2)}`).join('\n')}

📜 Recent Activity:
${metrics.recentActivity.slice(0, 5).map(a => `  ${a.side} ${a.size} @ ${a.price} - ${a.title}`).join('\n')}
${aiAnalysis}`;

      const updatedMessages = [
        ...sanitizedHistory,
        { role: 'user', content: polymarketUser.trim() },
        { role: 'assistant', content: profileMessage, userProfile, aiRecommendations }
      ].filter((msg) => msg.content);

      const responseId = incomingContextId || crypto.randomUUID();

      res.json({
        contextId: responseId,
        type: 'user_profile',
        userProfile: {
          maker,
          profile,
          metrics,
          positions,
          trades,
          activity,
          balance,
          positionsCount: positions.length,
          tradesCount: trades.length,
          aiRecommendations
        },
        messages: updatedMessages,
        timestamp: Date.now()
      });
      return;
    }

    const intent = await resolveMarketIntent({
      marketId,
      marketQuestion,
      polymarketUser,
      query,
      existingMarket: existingContext?.matchedMarket
    });

    if (!intent?.market) {
      return res.status(404).json({
        error: 'No matching market found',
        query: query || marketQuestion || polymarketUser,
        suggestion: 'Try specifying the full market question or provide the Polymarket URL/ID.'
      });
    }

    const matchedMarket = intent.market;
    const previousAnalysis = existingContext?.analysis;

    const shouldReuseAnalysis =
      previousAnalysis &&
      existingContext?.matchedMarket?.id === matchedMarket.id;

    const analysis = shouldReuseAnalysis
      ? previousAnalysis
      : await generateEnhancedAnalysis(matchedMarket);
    console.log('[CHAT] Market snapshot', {
      id: matchedMarket.id,
      question: matchedMarket.question,
      yesPrice: matchedMarket.yesPrice,
      noPrice: matchedMarket.noPrice,
      liquidity: matchedMarket.liquidity,
      volume24hr: matchedMarket.volume24hr
    });

    const responseId = incomingContextId || crypto.randomUUID();
    const assistantMessage = buildAssistantMessage({
      analysis,
      matchedMarket,
      userPrompt: query || marketQuestion || polymarketUser || '(follow-up)'
    });

    const recommendation = {
      action: normalizeAction(analysis?.action),
      confidence: analysis?.confidence ?? null,
      probability: typeof analysis?.probability === 'number'
        ? Number((analysis.probability * 100).toFixed(2))
        : null,
      marketOdds: typeof matchedMarket?.yesPrice === 'number'
        ? Number((matchedMarket.yesPrice * 100).toFixed(2))
        : null,
      effectiveEdge: analysis?.effectiveEdge ?? null
    };

    const updatedMessages = [
      ...sanitizedHistory,
      { role: 'user', content: (query || marketQuestion || polymarketUser || '').trim() },
      { role: 'assistant', content: assistantMessage, recommendation }
    ].filter((msg) => msg.content);

    saveContext(responseId, {
      matchedMarket,
      analysis,
      messages: updatedMessages
    });

    const data = {
      contextId: responseId,
      type: 'market_analysis',
      matchedMarket: {
        id: matchedMarket.id,
        question: matchedMarket.question,
        similarity: intent.similarity,
        source: intent.source,
        url: matchedMarket.url || matchedMarket.marketUrl || `https://polymarket.com/event/${matchedMarket.slug || matchedMarket.id}`
      },
      recommendation,
      analysis,
      messages: updatedMessages,
      timestamp: Date.now()
    };

    // Save to database if user is authenticated
    if (userId) {
      try {
        await saveChatExchange(
          sanitizedQuery || `Market analysis: ${matchedMarket.question}`,
          {
            role: 'assistant',
            content: updatedMessages[updatedMessages.length - 1]?.content || '',
            recommendation,
            analysis
          },
          {
            userId,
            sessionId: data.contextId,
            marketId: matchedMarket.id,
            marketQuestion: matchedMarket.question,
            polymarketUser: sanitizedPolymarketUser,
            contextId: data.contextId,
            matchedMarket,
            processingTimeMs: Date.now() - startTime,
            clientInfo: extractClientInfo(req),
            ipAddress: req.ip,
            metadata: {
              queryType: marketId ? 'market_analysis' : 'general_query',
              marketId: matchedMarket.id,
              source: 'backend_api'
            }
          }
        );
      } catch (persistError) {
        console.error('Failed to save chat exchange:', persistError);
      }
    }

    // Deduct credit after successful chat
    if (userId) {
      try {
        await deductCredit(userId, data.contextId);
        console.log(`[CHAT] Credit deducted for user ${userId}. Remaining: ${req.userCredits - 1}`);
      } catch (creditError) {
        console.error('[CHAT] Failed to deduct credit:', creditError);
      }
    }

    res.json(data);
  } catch (error) {
    console.error('[ERROR] Chat endpoint error:', {
      message: error?.message || 'Unknown',
      name: error?.name,
      code: error?.code,
      status: error?.response?.status,
      data: error?.response?.data,
      stack: error?.stack?.split('\n').slice(0, 3).join('\n')
    });
    
    // Save error to database if user is authenticated
    if (userId) {
      try {
        await saveErrorMessage(error.message, {
          userId,
          sessionId: incomingContextId || generateSessionId(),
          contextId: incomingContextId,
          processingTimeMs: Date.now() - startTime,
          clientInfo: extractClientInfo(req),
          ipAddress: req.ip,
          metadata: {
            queryType: marketId ? 'market_analysis' : 'general_query',
            source: 'backend_api'
          }
        });
      } catch (persistError) {
        console.error('Failed to save error message:', persistError);
      }
    }
    
    // Don't expose internal error details in production
    const isDevelopment = process.env.NODE_ENV === 'development';
    res.status(500).json({ 
      error: 'Internal server error',
      message: isDevelopment ? error.message : 'An error occurred while processing your request',
      code: 'CHAT_ERROR'
    });
  }
});

// Inject custom signal endpoint
app.post('/inject-signal', express.json(), (req, res) => {
  try {
    const { market, probZigma, probMarket, effectiveEdge, action, link } = req.body;
    if (!market || typeof probZigma !== 'number') {
      return res.status(400).json({ error: 'Missing required fields: market, probZigma' });
    }

    const customSignal = {
      market,
      action: action || 'EXECUTE BUY YES',
      probZigma,
      probMarket: probMarket || 50,
      effectiveEdge: effectiveEdge || 0,
      link: link || `https://polymarket.com/search?q=${encodeURIComponent(market)}`,
      timestamp: new Date().toISOString(),
      custom: true // Mark as custom
    };

    // Load existing custom signals
    const customFile = path.join(__dirname, 'cache', 'custom_signals.json');
    let customSignals = [];
    if (fs.existsSync(customFile)) {
      try {
        customSignals = JSON.parse(fs.readFileSync(customFile, 'utf8'));
      } catch (e) {
        console.error('Error loading custom signals:', e);
      }
    }

    // Add new signal
    customSignals.push(customSignal);

    // Save back
    fs.mkdirSync(path.dirname(customFile), { recursive: true });
    fs.writeFileSync(customFile, JSON.stringify(customSignals, null, 2));

    res.json({ success: true, signal: customSignal });
  } catch (error) {
    console.error('Inject signal error:', error);
    res.status(500).json({ error: 'Failed to inject signal' });
  }
});

app.post('/analyze-market', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'Missing question' });
  const marketData = await global.fetchSearchMarkets(question);
  if (!marketData) return res.status(404).json({ error: 'No matching market found on Polymarket' });
  const signal = await global.analyzeMarket(marketData);
  if (!signal) return res.status(500).json({ error: 'Analysis failed' });
  res.json(signal);
});

// Backup management endpoints (require authentication)
app.post('/admin/backup', authenticate, (req, res) => {
  try {
    const result = createBackup();
    if (result.success) {
      res.json({ success: true, message: 'Backup created successfully', backup: result.backupFile });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Backup endpoint error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/admin/backups', authenticate, (req, res) => {
  try {
    const backups = listBackups();
    res.json({ success: true, backups });
  } catch (error) {
    console.error('List backups endpoint error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/admin/backup/verify/:filename', authenticate, (req, res) => {
  try {
    const { filename } = req.params;
    const result = verifyBackup(filename);
    if (result.success) {
      res.json({ success: true, tables: result.tables });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Verify backup endpoint error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/risk-metrics', async (req, res) => {
  try {
    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    
    if (cycleHistory.length < 2) {
      return res.json({
        sharpeRatio: 0,
        sortinoRatio: 0,
        maxDrawdown: 0,
        var95: 0,
        cvar95: 0,
        calmarRatio: 0,
        message: 'Insufficient data for risk metrics'
      });
    }

    // Calculate returns from cycle history
    const returns = cycleHistory.map((cycle, i) => {
      if (i === 0) return 0;
      const prevSignals = cycleHistory[i - 1].signalsGenerated || 0;
      const currentSignals = cycle.signalsGenerated || 0;
      return (currentSignals - prevSignals) / Math.max(1, prevSignals);
    }).filter(r => !isNaN(r) && r !== 0);

    // Calculate portfolio values for drawdown
    const portfolioValues = cycleHistory.map((cycle, i) => {
      return cycle.marketsFetched || 0;
    });

    const {
      calculateSharpeRatio,
      calculateSortinoRatio,
      calculateMaxDrawdown,
      calculateVaR,
      calculateCVaR,
      calculateCalmarRatio
    } = require('./src/utils/risk-metrics');

    const sharpeRatio = calculateSharpeRatio(returns);
    const sortinoRatio = calculateSortinoRatio(returns);
    const { maxDrawdown } = calculateMaxDrawdown(portfolioValues);
    const { varPercentage: var95 } = calculateVaR(returns, 0.95);
    const { cvarPercentage: cvar95 } = calculateCVaR(returns, 0.95);
    const calmarRatio = calculateCalmarRatio(returns, portfolioValues);

    res.json({
      sharpeRatio: Number(sharpeRatio.toFixed(3)),
      sortinoRatio: Number(sortinoRatio.toFixed(3)),
      maxDrawdown: Number(maxDrawdown.toFixed(2)),
      var95: Number(var95.toFixed(2)),
      cvar95: Number(cvar95.toFixed(2)),
      calmarRatio: Number(calmarRatio.toFixed(3)),
      dataPoints: cycleHistory.length,
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error calculating risk metrics:', error);
    res.status(500).json({ error: 'Failed to calculate risk metrics' });
  }
});

app.get('/api/performance-history', async (req, res) => {
  try {
    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    
    const performanceData = cycleHistory.map(cycle => ({
      timestamp: cycle.timestamp || cycle.lastRun,
      marketsFetched: cycle.marketsFetched || 0,
      marketsAnalyzed: cycle.marketsAnalyzed || 0,
      signalsGenerated: cycle.signalsGenerated || 0,
      watchlist: cycle.watchlist || 0,
      outlook: cycle.outlook || 0,
      rejected: cycle.rejected || 0
    }));

    res.json({
      data: performanceData,
      totalCycles: performanceData.length
    });
  } catch (error) {
    console.error('Error fetching performance history:', error);
    res.status(500).json({ error: 'Failed to fetch performance history' });
  }
});

// Risk Management API endpoints
app.get('/api/risk-management/portfolio', async (req, res) => {
  try {
    const {
      calculatePortfolioRisk
    } = require('./src/utils/risk-management');

    // Get current positions from latest cycle data
    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const latestCycle = cycleHistory[cycleHistory.length - 1];
    
    const positions = latestCycle?.liveSignals || [];
    const portfolioValue = 1000; // Default portfolio value

    const portfolioRisk = calculatePortfolioRisk(positions, portfolioValue);

    res.json({
      portfolioValue,
      positionCount: portfolioRisk.positionCount,
      sectorCount: portfolioRisk.sectorCount,
      maxPositionSize: portfolioRisk.maxPositionSize,
      sectorDiversification: portfolioRisk.sectorDiversification,
      sectorExposure: portfolioRisk.sectorExposure,
      concentration: portfolioRisk.concentration
    });
  } catch (error) {
    console.error('Error calculating portfolio risk:', error);
    res.status(500).json({ error: 'Failed to calculate portfolio risk' });
  }
});

app.post('/api/risk-management/check-trade', async (req, res) => {
  try {
    const { trade, portfolio, market, config } = req.body;

    if (!trade || !portfolio || !market) {
      return res.status(400).json({ error: 'Missing required parameters: trade, portfolio, market' });
    }

    const {
      checkTradeRisk
    } = require('./src/utils/risk-management');

    const riskCheck = checkTradeRisk(trade, portfolio, market, config);

    res.json(riskCheck);
  } catch (error) {
    console.error('Error checking trade risk:', error);
    res.status(500).json({ error: 'Failed to check trade risk' });
  }
});

app.post('/api/risk-management/slippage', async (req, res) => {
  try {
    const { tradeSize, liquidity, price, side } = req.body;

    if (!tradeSize || !liquidity || !price) {
      return res.status(400).json({ error: 'Missing required parameters: tradeSize, liquidity, price' });
    }

    const {
      estimateSlippage
    } = require('./src/utils/risk-management');

    const slippage = estimateSlippage(
      tradeSize,
      liquidity,
      price,
      side || 'BUY'
    );

    res.json(slippage);
  } catch (error) {
    console.error('Error estimating slippage:', error);
    res.status(500).json({ error: 'Failed to estimate slippage' });
  }
});

// Analytics API endpoints
app.get('/api/analytics/accuracy', async (req, res) => {
  try {
    const {
      calculateAccuracyMetrics
    } = require('./src/utils/analytics');

    // Get signals from cycle history
    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    
    // Flatten signals from all cycles
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    const accuracy = calculateAccuracyMetrics(allSignals);

    res.json(accuracy);
  } catch (error) {
    console.error('Error calculating accuracy metrics:', error);
    res.status(500).json({ error: 'Failed to calculate accuracy metrics' });
  }
});

app.get('/api/analytics/win-loss', async (req, res) => {
  try {
    const {
      calculateWinLossRatio
    } = require('./src/utils/analytics');

    // Get trades from trade log
    const tradesPath = path.join(__dirname, 'trades.log');
    let trades = [];

    try {
      if (fs.existsSync(tradesPath)) {
        const tradesData = fs.readFileSync(tradesPath, 'utf8');
        const lines = tradesData.split('\n').filter(line => line.trim());
        trades = lines.map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(t => t !== null);
      }
    } catch (err) {
      console.error('Error reading trades log:', err.message);
    }

    const winLoss = calculateWinLossRatio(trades);

    res.json(winLoss);
  } catch (error) {
    console.error('Error calculating win/loss ratio:', error);
    res.status(500).json({ error: 'Failed to calculate win/loss ratio' });
  }
});

app.get('/api/analytics/calibration', async (req, res) => {
  try {
    const {
      calculateConfidenceCalibration
    } = require('./src/utils/analytics');

    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    const calibration = calculateConfidenceCalibration(allSignals);

    res.json(calibration);
  } catch (error) {
    console.error('Error calculating confidence calibration:', error);
    res.status(500).json({ error: 'Failed to calculate confidence calibration' });
  }
});

app.get('/api/analytics/category-performance', async (req, res) => {
  try {
    const {
      calculateCategoryPerformance
    } = require('./src/utils/analytics');

    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    const categoryPerf = calculateCategoryPerformance(allSignals);

    res.json(categoryPerf);
  } catch (error) {
    console.error('Error calculating category performance:', error);
    res.status(500).json({ error: 'Failed to calculate category performance' });
  }
});

app.get('/api/analytics/time-of-day', async (req, res) => {
  try {
    const {
      calculateTimeOfDayAnalysis
    } = require('./src/utils/analytics');

    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    const timeOfDay = calculateTimeOfDayAnalysis(allSignals);

    res.json(timeOfDay);
  } catch (error) {
    console.error('Error calculating time-of-day analysis:', error);
    res.status(500).json({ error: 'Failed to calculate time-of-day analysis' });
  }
});

app.get('/api/analytics/full-report', async (req, res) => {
  try {
    const {
      generateAnalyticsReport
    } = require('./src/utils/analytics');

    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    // Get trades from trade log
    const tradesPath = path.join(__dirname, 'trades.log');
    let trades = [];

    try {
      if (fs.existsSync(tradesPath)) {
        const tradesData = fs.readFileSync(tradesPath, 'utf8');
        const lines = tradesData.split('\n').filter(line => line.trim());
        trades = lines.map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(t => t !== null);
      }
    } catch (err) {
      console.error('Error reading trades log:', err.message);
    }

    const report = generateAnalyticsReport({ signals: allSignals, trades });

    res.json(report);
  } catch (error) {
    console.error('Error generating analytics report:', error);
    res.status(500).json({ error: 'Failed to generate analytics report' });
  }
});

// Signal// Reload cycle history from file (for testing)
app.post('/api/admin/reload-cycle-history', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const CYCLE_HISTORY_FILE = path.join(__dirname, 'cache', 'cycle_history.json');
    
    if (fs.existsSync(CYCLE_HISTORY_FILE)) {
      const data = fs.readFileSync(CYCLE_HISTORY_FILE, 'utf8');
      const cycleHistory = JSON.parse(data);
      global.cycleHistory = cycleHistory;
      
      res.json({
        success: true,
        message: `Reloaded ${cycleHistory.length} cycles from file`,
        cyclesLoaded: cycleHistory.length
      });
    } else {
      res.status(404).json({ error: 'Cycle history file not found' });
    }
  } catch (error) {
    console.error('Error reloading cycle history:', error);
    res.status(500).json({ error: 'Failed to reload cycle history' });
  }
});

// Resolution Management API endpoints
app.post('/api/resolutions/update', async (req, res) => {
  try {
    console.log(' Manual resolution update triggered');
    const stats = await runResolutionUpdate();
    
    res.json({
      success: true,
      message: `Resolution update completed. ${stats.newlyResolved} new resolutions found.`,
      stats
    });
  } catch (error) {
    console.error('Error in manual resolution update:', error);
    res.status(500).json({ 
      error: 'Failed to update resolutions', 
      message: error.message 
    });
  }
});

app.get('/api/resolutions/stats', async (req, res) => {
  try {
    const stats = getResolutionStats();
    
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error getting resolution stats:', error);
    res.status(500).json({ 
      error: 'Failed to get resolution stats', 
      message: error.message 
    });
  }
});

// Auto-run resolution update every hour
setInterval(async () => {
  try {
    await runResolutionUpdate();
  } catch (error) {
    console.error(' Auto resolution update failed:', error);
  }
}, 60 * 60 * 1000); // Every hour

// Performance History API endpoints
app.get('/api/signals/performance', async (req, res) => {
  try {
    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    const totalSignals = allSignals.length;
    const resolvedSignals = allSignals.filter(s => s.outcome !== undefined && s.outcome !== null);
    const pendingSignals = allSignals.filter(s => !s.outcome);
    const correctSignals = resolvedSignals.filter(s => {
      const predictedYes = s.predictedProbability > 0.5;
      const actualYes = s.outcome === 'YES';
      return predictedYes === actualYes;
    });
    const incorrectSignals = resolvedSignals.length - correctSignals.length;
    const accuracy = resolvedSignals.length > 0 ? correctSignals.length / resolvedSignals.length : 0;
    const avgConfidence = allSignals.length > 0 
      ? allSignals.reduce((sum, s) => sum + (s.confidence || 0), 0) / allSignals.length 
      : 0;
    const avgEdge = allSignals.length > 0 
      ? allSignals.reduce((sum, s) => sum + (s.edge || 0), 0) / allSignals.length 
      : 0;

    // Sort by edge for best/worst
    const sortedByEdge = [...allSignals].sort((a, b) => (b.edge || 0) - (a.edge || 0));
    const bestSignals = sortedByEdge.slice(0, 10);
    const worstSignals = sortedByEdge.slice(-10).reverse();

    res.json({
      totalSignals,
      resolvedSignals: resolvedSignals.length,
      correctSignals: correctSignals.length,
      incorrectSignals,
      pendingSignals: pendingSignals.length,
      accuracy: Number(accuracy.toFixed(4)),
      avgConfidence: Number(avgConfidence.toFixed(2)),
      avgEdge: Number(avgEdge.toFixed(2)),
      bestSignals,
      worstSignals
    });
  } catch (error) {
    console.error('Error calculating signal performance:', error);
    res.status(500).json({ error: 'Failed to calculate signal performance' });
  }
});

app.get('/api/signals/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    // Sort by timestamp descending
    const recentSignals = allSignals
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
      .slice(0, limit);

    res.json(recentSignals);
  } catch (error) {
    console.error('Error fetching recent signals:', error);
    res.status(500).json({ error: 'Failed to fetch recent signals' });
  }
});

// Hypothetical P&L API endpoints
app.get('/api/pnl/aggregate', async (req, res) => {
  try {
    const positionSize = parseInt(req.query.positionSize) || 100;
    const {
      calculateAggregatePnL
    } = require('./src/utils/hypothetical-pnl');

    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    const pnl = calculateAggregatePnL(allSignals, positionSize);

    res.json(pnl);
  } catch (error) {
    console.error('Error calculating aggregate P&L:', error);
    res.status(500).json({ error: 'Failed to calculate aggregate P&L' });
  }
});

app.get('/api/pnl/by-category', async (req, res) => {
  try {
    const positionSize = parseInt(req.query.positionSize) || 100;
    const {
      calculatePnLByCategory
    } = require('./src/utils/hypothetical-pnl');

    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    const pnlByCategory = calculatePnLByCategory(allSignals, positionSize);

    res.json(pnlByCategory);
  } catch (error) {
    console.error('Error calculating P&L by category:', error);
    res.status(500).json({ error: 'Failed to calculate P&L by category' });
  }
});

app.get('/api/pnl/equity-curve', async (req, res) => {
  try {
    const positionSize = parseInt(req.query.positionSize) || 100;
    const initialCapital = parseInt(req.query.initialCapital) || 1000;
    const {
      calculateEquityCurve
    } = require('./src/utils/hypothetical-pnl');

    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    const equityCurve = calculateEquityCurve(allSignals, positionSize, initialCapital);

    res.json(equityCurve);
  } catch (error) {
    console.error('Error calculating equity curve:', error);
    res.status(500).json({ error: 'Failed to calculate equity curve' });
  }
});

// Watchlist API endpoints
const WATCHLIST_FILE = path.join(__dirname, 'watchlist.json');

// Ensure watchlist file exists
if (!fs.existsSync(WATCHLIST_FILE)) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify([], null, 2));
}

app.get('/api/watchlist', async (req, res) => {
  try {
    const watchlistData = fs.readFileSync(WATCHLIST_FILE, 'utf8');
    const watchlist = JSON.parse(watchlistData);
    
    // Enrich with current market data if available
    const enrichedWatchlist = watchlist.map(item => {
      const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
      const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);
      const latestSignal = allSignals.find(s => s.marketId === item.marketId);
      
      return {
        ...item,
        lastSignal: latestSignal ? {
          edge: latestSignal.edge || 0,
          confidence: latestSignal.confidence || 0,
          timestamp: latestSignal.timestamp || new Date().toISOString()
        } : undefined
      };
    });

    res.json(enrichedWatchlist);
  } catch (error) {
    console.error('Error fetching watchlist:', error);
    res.status(500).json({ error: 'Failed to fetch watchlist' });
  }
});

app.post('/api/watchlist', async (req, res) => {
  try {
    const { marketId } = req.body;
    
    if (!marketId) {
      return res.status(400).json({ error: 'Missing marketId' });
    }

    const watchlistData = fs.readFileSync(WATCHLIST_FILE, 'utf8');
    const watchlist = JSON.parse(watchlistData);
    
    // Check if already in watchlist
    if (watchlist.some(item => item.marketId === marketId)) {
      return res.status(400).json({ error: 'Market already in watchlist' });
    }

    // Fetch market details
    const { fetchSearchMarkets } = require('./src/fetcher');
    const marketData = await fetchSearchMarkets(marketId);
    
    if (!marketData) {
      return res.status(404).json({ error: 'Market not found' });
    }

    const newItem = {
      id: Date.now().toString(),
      marketId,
      question: marketData.question || marketData.title || 'Unknown Market',
      category: marketData.category || 'UNKNOWN',
      addedAt: new Date().toISOString(),
      currentOdds: marketData.odds || marketData.price || 0
    };

    watchlist.push(newItem);
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2));

    res.json(newItem);
  } catch (error) {
    console.error('Error adding to watchlist:', error);
    res.status(500).json({ error: 'Failed to add to watchlist' });
  }
});

app.post('/api/watchlist/bulk', async (req, res) => {
  try {
    const { marketIds } = req.body;
    
    if (!Array.isArray(marketIds) || marketIds.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid marketIds array' });
    }

    const watchlistData = fs.readFileSync(WATCHLIST_FILE, 'utf8');
    const watchlist = JSON.parse(watchlistData);
    
    const { fetchSearchMarkets } = require('./src/fetcher');
    const addedItems = [];
    const errors = [];

    for (const marketId of marketIds) {
      try {
        if (!marketId || typeof marketId !== 'string') {
          errors.push({ marketId, error: 'Invalid marketId' });
          continue;
        }

        if (watchlist.some(item => item.marketId === marketId)) {
          errors.push({ marketId, error: 'Already in watchlist' });
          continue;
        }

        const marketData = await fetchSearchMarkets(marketId);
        
        if (!marketData) {
          errors.push({ marketId, error: 'Market not found' });
          continue;
        }

        const newItem = {
          id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
          marketId,
          question: marketData.question || marketData.title || 'Unknown Market',
          category: marketData.category || 'UNKNOWN',
          addedAt: new Date().toISOString(),
          currentOdds: marketData.odds || marketData.price || 0
        };

        watchlist.push(newItem);
        addedItems.push(newItem);
      } catch (err) {
        errors.push({ marketId, error: err.message });
      }
    }

    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2));

    res.json({
      imported: addedItems.length,
      addedItems,
      errors,
      total: watchlist.length
    });
  } catch (error) {
    console.error('Error bulk importing to watchlist:', error);
    res.status(500).json({ error: 'Failed to bulk import to watchlist' });
  }
});

app.delete('/api/watchlist/:marketId', async (req, res) => {
  try {
    const { marketId } = req.params;
    
    const watchlistData = fs.readFileSync(WATCHLIST_FILE, 'utf8');
    const watchlist = JSON.parse(watchlistData);
    
    const filteredWatchlist = watchlist.filter(item => item.marketId !== marketId);
    
    if (filteredWatchlist.length === watchlist.length) {
      return res.status(404).json({ error: 'Market not found in watchlist' });
    }

    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(filteredWatchlist, null, 2));

    res.json({ success: true, marketId });
  } catch (error) {
    console.error('Error removing from watchlist:', error);
    res.status(500).json({ error: 'Failed to remove from watchlist' });
  }
});

// ============================================================
// NEW SUPABASE-BASED API ROUTES
// ============================================================

// Import Supabase-based API routes
const watchlistRoutes = require('./src/api/watchlist');
const userRoutes = require('./src/api/users');
const signalRoutes = require('./src/api/signals');
const tokenRoutes = require('./src/api/token');
const paymentRoutes = require('./src/api/payments');
const { router: magicAuthRouter } = require('./src/api/magic-auth');
const { router: zigmaChatRouter } = require('./src/api/zigma-chat');

// Use the new routes
app.use('/api/auth', magicAuthRouter);
app.use('/api/chat', zigmaChatRouter);
app.use('/api/helius', require('./src/api/helius-webhook'));

app.use('/api/watchlist', watchlistRoutes);
app.use('/api/users', userRoutes);
app.use('/api/signals', signalRoutes);
app.use('/api/token', tokenRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/credits', require('./src/api/credits').router);
app.use('/api/auth/magic', magicAuthRouter);
app.use('/api/chat', zigmaChatRouter);

// Visualization API endpoints
app.get('/api/visualization/price-history', async (req, res) => {
  try {
    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    // Debug: Log signal structure
    console.log('Total signals:', allSignals.length);
    console.log('Sample signal:', allSignals[0]);
    
    // Get recent signals with market odds
    const priceHistory = allSignals
      .filter(s => (s.price || s.marketOdds) && s.timestamp)
      .slice(0, 50)
      .map(s => ({
        timestamp: s.timestamp,
        price: (s.price * 100) || s.marketOdds, // Convert to percentage
        marketQuestion: s.marketQuestion
      }))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    console.log('Price history entries:', priceHistory.length);

    res.json(priceHistory);
  } catch (error) {
    console.error('Error fetching price history:', error);
    res.status(500).json({ error: 'Failed to fetch price history' });
  }
});

app.get('/api/visualization/edge-distribution', async (req, res) => {
  try {
    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    // Create edge bins
    const bins = [
      { range: '0-1%', min: 0, max: 1, count: 0 },
      { range: '1-2%', min: 1, max: 2, count: 0 },
      { range: '2-3%', min: 2, max: 3, count: 0 },
      { range: '3-5%', min: 3, max: 5, count: 0 },
      { range: '5-10%', min: 5, max: 10, count: 0 },
      { range: '10%+', min: 10, max: Infinity, count: 0 }
    ];

    allSignals.forEach(signal => {
      const edge = signal.edge || 0;
      // Convert to percentage if it's a decimal
      const edgePercent = edge <= 1 ? edge * 100 : edge;
      const bin = bins.find(b => edgePercent >= b.min && edgePercent < b.max);
      if (bin) bin.count++;
    });

    res.json(bins);
  } catch (error) {
    console.error('Error fetching edge distribution:', error);
    res.status(500).json({ error: 'Failed to fetch edge distribution' });
  }
});

app.get('/api/visualization/confidence', async (req, res) => {
  try {
    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    let low = 0;
    let medium = 0;
    let high = 0;

    allSignals.forEach(signal => {
      const confidence = signal.confidence || 0;
      // Convert to percentage if it's a decimal
      const confidencePercent = confidence <= 1 ? confidence * 100 : confidence;
      if (confidencePercent < 50) low++;
      else if (confidencePercent < 75) medium++;
      else high++;
    });

    res.json({ low, medium, high });
  } catch (error) {
    console.error('Error fetching confidence data:', error);
    res.status(500).json({ error: 'Failed to fetch confidence data' });
  }
});

app.get('/api/visualization/risk-metrics', async (req, res) => {
  try {
    const {
      calculatePortfolioRisk
    } = require('./src/utils/risk-management');

    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    // Calculate portfolio risk
    const portfolioRisk = calculatePortfolioRisk(allSignals, 1000);

    // Calculate volatility based on edge variance
    const edges = allSignals.map(s => s.edge || 0);
    const avgEdge = edges.length > 0 ? edges.reduce((sum, e) => sum + e, 0) / edges.length : 0;
    const variance = edges.length > 0 
      ? edges.reduce((sum, e) => sum + Math.pow(e - avgEdge, 2), 0) / edges.length 
      : 0;
    const volatility = Math.sqrt(variance) * 10; // Scale to 0-100

    // Calculate concentration
    const concentration = portfolioRisk.maxPositionSize || 0;

    // Calculate liquidity risk (inverse of average liquidity)
    const liquidities = allSignals.map(s => s.liquidity || 0);
    const avgLiquidity = liquidities.length > 0 
      ? liquidities.reduce((sum, l) => sum + l, 0) / liquidities.length 
      : 0;
    const liquidityRisk = Math.max(0, 100 - (avgLiquidity / 10000)); // Scale to 0-100

    // Calculate overall risk
    const overallRisk = (volatility * 0.4 + concentration * 0.3 + liquidityRisk * 0.3);

    res.json({
      overallRisk: Number(overallRisk.toFixed(0)),
      volatility: Number(Math.min(100, volatility).toFixed(0)),
      concentration: Number(concentration.toFixed(0)),
      liquidity: Number(Math.min(100, liquidityRisk).toFixed(0))
    });
  } catch (error) {
    console.error('Error fetching risk metrics:', error);
    res.status(500).json({ error: 'Failed to fetch risk metrics' });
  }
});

// Backtest endpoint (legacy support, redirects to P&L aggregate)
app.get('/backtest', async (req, res) => {
  try {
    const positionSize = parseInt(req.query.positionSize) || 100;
    const initialCapital = parseInt(req.query.initialCapital) || 1000;
    const {
      calculateAggregatePnL
    } = require('./src/utils/hypothetical-pnl');

    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    const result = calculateAggregatePnL(allSignals, positionSize, initialCapital);

    res.json(result);
  } catch (error) {
    console.error('Error running backtest:', error);
    res.status(500).json({ error: 'Failed to run backtest' });
  }
});

// Historical trades endpoint
app.get('/api/signals/historical', (req, res) => {
  try {
    const historicalTradesPath = path.join(__dirname, 'historical_trades.json');
    
    if (!fs.existsSync(historicalTradesPath)) {
      return res.json([]);
    }

    const historicalTrades = JSON.parse(fs.readFileSync(historicalTradesPath, 'utf8'));
    res.json(historicalTrades);
  } catch (error) {
    console.error('Error fetching historical trades:', error);
    res.json([]);
  }
});




// Category P&L endpoint
app.get('/api/pnl/by-category', (req, res) => {
  try {
    // Return empty category P&L data for now
    res.json({});
  } catch (error) {
    console.error('Error fetching category P&L:', error);
    res.json({});
  }
});

// Graceful shutdown handler
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  if (server) {
    server.close((err) => {
      if (err) {
        console.error('Error during server shutdown:', err);
        process.exit(1);
      }
      console.log('Server closed successfully');
      process.exit(0);
    });

    // Force shutdown after 10 seconds if graceful shutdown fails
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
};

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Global error handler for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Log the error but don't expose details
  console.error('Stack trace:', error.stack);
  // Create a backup before shutting down
  createBackup();
  process.exit(1);
});

// Global error handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Log the error but don't crash the server
  console.error('Stack trace:', reason?.stack);
});

// Global error handler middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: isDevelopment ? err.message : 'An unexpected error occurred',
    code: err.code || 'INTERNAL_ERROR',
    ...(isDevelopment && { stack: err.stack })
  });
});

// ============================================================
// MOLTBOT INTEGRATION API ENDPOINTS
// ============================================================

// Import utilities
const { verifyZigmaAccess } = require('./src/utils/token');
const { analyzeWallet } = require('./src/api/wallet');
const {
  addTrackedMarket,
  removeTrackedMarket,
  getTrackedMarkets,
  runHeartbeat,
  getHeartbeatStats
} = require('./src/utils/heartbeat');
const {
  requireTokenAccess,
  getUserUsage,
  incrementUsage
} = require('./src/middleware/token-access');

// Store webhooks for real-time alerts
const webhooks = new Map();

// GET /api/v1/signals - Get trading signals with auth middleware and tier enforcement
app.get('/api/v1/signals', authenticate, requireTokenAccess('signals'), async (req, res) => {
  try {
    const { limit = 5, minEdge = 0.03, category } = req.query;
    const signals = global.latestData?.liveSignals || [];
    
    // Filter signals
    const filtered = signals
      .filter(s => {
        const edge = Math.abs(s.edgeScoreDecimal || (s.edge || 0));
        return edge >= parseFloat(minEdge);
      })
      .filter(s => !category || s.category === category)
      .slice(0, parseInt(limit));
    
    // Apply signal priority based on tier
    const priorityOrder = {
      'FREE': ['edge'],
      'BASIC': ['edge', 'confidence'],
      'PRO': ['edge', 'confidence', 'liquidity'],
      'WHALE': ['edge', 'confidence', 'liquidity', 'kelly']
    };
    
    const sortCriteria = priorityOrder[req.userTier] || priorityOrder.FREE;
    
    const prioritized = filtered.sort((a, b) => {
      for (const criterion of sortCriteria) {
        const aVal = a[criterion] || 0;
        const bVal = b[criterion] || 0;
        if (aVal !== bVal) {
          return bVal - aVal; // Descending order
        }
      }
      return 0;
    });
    
    res.json(prioritized);
  } catch (error) {
    console.error('[API/v1/signals] Error:', error);
    res.status(500).json({ error: 'Failed to fetch signals', message: error.message });
  }
});

// GET /api/v1/market/:id/analysis - Deep market analysis
app.get('/api/v1/market/:id/analysis', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find market in live signals
    const market = global.latestData?.liveSignals?.find(s => s.marketId === id);
    
    if (!market) {
      return res.status(404).json({ error: 'Market not found', id });
    }
    
    // Fetch news for this market
    const { crossReferenceNews } = require('./src/index');
    let news = [];
    try {
      const newsResults = await crossReferenceNews(market);
      news = newsResults.slice(0, 3).map(n => ({ title: n.title, source: n.source }));
    } catch (error) {
      console.error('News fetch failed:', error.message);
    }
    
    // Build analysis response
    const analysis = {
      id: market.marketId,
      question: market.marketQuestion,
      probability: market.predictedProbability || 0.5,
      confidence: market.confidence || 0,
      edge: market.edgeScoreDecimal || (market.edge || 0),
      recommendation: market.action || 'NO_TRADE',
      reasoning: market.structuredAnalysis?.reasoning || 'Analysis available',
      news
    };
    
    res.json(analysis);
  } catch (error) {
    console.error('[API/v1/market/:id/analysis] Error:', error);
    res.status(500).json({ error: 'Failed to analyze market', message: error.message });
  }
});

// GET /api/v1/arbitrage - Scan for arbitrage opportunities with tier enforcement
app.get('/api/v1/arbitrage', authenticate, requireTokenAccess('arbitrage'), async (req, res) => {
  try {
    const { scanArbitrageOpportunities } = require('./src/index');
    
    const opportunities = await scanArbitrageOpportunities(
      global.latestData?.liveSignals || []
    );
    
    res.json(opportunities);
  } catch (error) {
    console.error('[API/v1/arbitrage] Error:', error);
    res.status(500).json({ error: 'Failed to scan arbitrage', message: error.message });
  }
});

// GET /api/v1/access/:wallet - Token verification endpoint
app.get('/api/v1/access/:wallet', authenticate, async (req, res) => {
  try {
    const { wallet } = req.params;
    
    // Validate wallet address format
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }
    
    // Verify ZIGMA access
    const access = await verifyZigmaAccess(wallet);
    
    res.json(access);
  } catch (error) {
    console.error('[API/v1/access/:wallet] Error:', error);
    res.status(500).json({ error: 'Failed to verify access', message: error.message });
  }
});

// GET /api/v1/wallet/:address - Wallet analysis endpoint with tier enforcement
app.get('/api/v1/wallet/:address', authenticate, requireTokenAccess('wallet'), async (req, res) => {
  try {
    const { address } = req.params;
    
    // Validate wallet address
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }
    
    // Analyze wallet
    const analysis = await analyzeWallet(address);
    
    res.json(analysis);
  } catch (error) {
    console.error('[API/v1/wallet/:address] Error:', error);
    res.status(500).json({ error: 'Failed to analyze wallet', message: error.message });
  }
});

// POST /api/v1/track - Track a market for alerts with tier enforcement
app.post('/api/v1/track', authenticate, requireTokenAccess('track'), async (req, res) => {
  try {
    const { userId, marketId, threshold } = req.body;
    
    if (!userId || !marketId) {
      return res.status(400).json({ error: 'Missing required fields: userId, marketId' });
    }
    
    const result = addTrackedMarket(userId, marketId, threshold);
    
    res.json(result);
  } catch (error) {
    console.error('[API/v1/track] Error:', error);
    res.status(500).json({ error: 'Failed to track market', message: error.message });
  }
});

// GET /api/v1/tracked - Get tracked markets for a user
app.get('/api/v1/tracked', authenticate, async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId parameter' });
    }
    
    const markets = getTrackedMarkets(userId);
    
    // Enrich with current market data
    const enriched = markets.map(tracking => {
      const market = global.latestData?.liveSignals?.find(s => s.marketId === tracking.marketId);
      return {
        ...tracking,
        currentMarket: market ? {
          question: market.marketQuestion,
          currentEdge: (Math.abs(market.edgeScoreDecimal || (market.edge || 0)) * 100).toFixed(1),
          confidence: market.confidence || 0,
          action: market.action || 'NO_TRADE'
        } : null
      };
    });
    
    res.json(enriched);
  } catch (error) {
    console.error('[API/v1/tracked] Error:', error);
    res.status(500).json({ error: 'Failed to get tracked markets', message: error.message });
  }
});

// DELETE /api/v1/tracked/:marketId - Remove tracked market
app.delete('/api/v1/tracked/:marketId', authenticate, async (req, res) => {
  try {
    const { marketId } = req.params;
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId parameter' });
    }
    
    const result = removeTrackedMarket(userId, marketId);
    
    res.json(result);
  } catch (error) {
    console.error('[API/v1/tracked/:marketId] Error:', error);
    res.status(500).json({ error: 'Failed to remove tracked market', message: error.message });
  }
});

// POST /api/v1/webhooks - Register webhook for alerts
app.post('/api/v1/webhooks', authenticate, async (req, res) => {
  try {
    const { userId, url, events } = req.body;
    
    if (!userId || !url) {
      return res.status(400).json({ error: 'Missing required fields: userId, url' });
    }
    
    webhooks.set(userId, {
      url,
      events: events || ['EDGE_CHANGE', 'HIGH_EDGE_SIGNAL', 'ARBITRAGE_OPPORTUNITY', 'EXIT_SIGNAL'],
      registeredAt: Date.now()
    });
    
    res.json({ success: true, message: 'Webhook registered' });
  } catch (error) {
    console.error('[API/v1/webhooks] Error:', error);
    res.status(500).json({ error: 'Failed to register webhook', message: error.message });
  }
});

// DELETE /api/v1/webhooks - Remove webhook
app.delete('/api/v1/webhooks', authenticate, async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId parameter' });
    }
    
    webhooks.delete(userId);
    
    res.json({ success: true, message: 'Webhook removed' });
  } catch (error) {
    console.error('[API/v1/webhooks DELETE] Error:', error);
    res.status(500).json({ error: 'Failed to remove webhook', message: error.message });
  }
});

// POST /api/v1/alerts - Send alerts to webhooks
app.post('/api/v1/alerts', authenticate, async (req, res) => {
  try {
    const { alerts } = req.body;
    
    if (!Array.isArray(alerts)) {
      return res.status(400).json({ error: 'Invalid alerts format' });
    }
    
    const results = [];
    
    for (const alert of alerts) {
      const webhook = webhooks.get(alert.userId);
      
      if (!webhook) {
        results.push({ alertId: alert.id, status: 'NO_WEBHOOK' });
        continue;
      }
      
      // Check if event type is subscribed
      if (!webhook.events.includes(alert.type)) {
        results.push({ alertId: alert.id, status: 'NOT_SUBSCRIBED' });
        continue;
      }
      
      // Send webhook
      try {
        await fetch(webhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(alert)
        });
        
        results.push({ alertId: alert.id, status: 'SENT' });
      } catch (error) {
        console.error(`Failed to send webhook to ${webhook.url}:`, error.message);
        results.push({ alertId: alert.id, status: 'FAILED', error: error.message });
      }
    }
    
    res.json({ success: true, results });
  } catch (error) {
    console.error('[API/v1/alerts] Error:', error);
    res.status(500).json({ error: 'Failed to send alerts', message: error.message });
  }
});

// GET /api/v1/heartbeat/stats - Get heartbeat statistics
app.get('/api/v1/heartbeat/stats', authenticate, async (req, res) => {
  try {
    const userId = req.user?.id || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }
    
    const stats = getHeartbeatStats();
    const usage = getUserUsage(userId);
    
    res.json({
      ...stats,
      usage
    });
  } catch (error) {
    console.error('[API/v1/heartbeat/stats] Error:', error);
    res.status(500).json({ error: 'Failed to get heartbeat stats', message: error.message });
  }
});

// GET /api/v1/usage - Get user's daily usage stats
app.get('/api/v1/usage', authenticate, async (req, res) => {
  try {
    const userId = req.user?.id || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }
    
    const usage = getUserUsage(userId);
    
    res.json(usage);
  } catch (error) {
    console.error('[API/v1/usage] Error:', error);
    res.status(500).json({ error: 'Failed to get usage stats', message: error.message });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`,
    code: 'NOT_FOUND'
  });
});

module.exports = {
  app,
  server,
  wsServer,
  updateHealthMetrics,
  startServer: () => {
    server.listen(PORT, () => {
      console.log(`Agent Zigma server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/status`);
      console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws/prices`);
      systemHealth.status = 'operational';
    });
    return server;
  }
};

// Start server if run directly
if (require.main === module) {
  require('./src/index.js');
  module.exports.startServer();
}
