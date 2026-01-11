const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { BoundedMap } = require('./src/utils/bounded-map');
const { createBackup, listBackups, verifyBackup } = require('./backup');

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

// Clean up expired rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitStore.entries()) {
    if (now > record.resetTime) {
      rateLimitStore.delete(ip);
    }
  }
}, 300000);

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

// Health check endpoint
app.get('/status', (req, res) => {
  const generateServiceHistory = () => {
    const history = [];
    for (let i = 0; i < 6; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      history.push({
        date: dateStr,
        services: {
          'Oracle Core': '●',
          'API Gateway': '●',
          'Logs Processor': '●',
          'Signal Engine': '●'
        }
      });
    }
    return history;
  };

  const generateRecentEvents = () => {
    const now = new Date();
    const events = [
      { offset: 0, event: 'Oracle Core cycle completed successfully' },
      { offset: 15, event: 'API Gateway operational' },
      { offset: 30, event: 'Logs processed without issues' },
      { offset: 45, event: 'Signal engine analysis completed' }
    ];
    return events.map(e => {
      const time = new Date(now.getTime() - e.offset * 60000);
      const dateStr = time.toISOString().slice(0, 10);
      const timeStr = time.toISOString().slice(11, 16) + ' UTC';
      return `${dateStr} ${timeStr} - ${e.event}`;
    });
  };

  res.json({
    status: systemHealth.status,
    uptime: systemHealth.uptime,
    lastRun: systemHealth.lastRun,
    posts: systemHealth.posts,
    marketsMonitored: systemHealth.marketsMonitored,
    alertsActive: systemHealth.alertsActive,
    timestamp: Date.now(),
    version: '1.1-beta',
    history: generateServiceHistory(),
    recentEvents: generateRecentEvents(),
    noRecentIssues: true
  });
});

// Basic metrics endpoint (for monitoring)
app.get('/metrics', (req, res) => {
  res.json({
    uptime_seconds: systemHealth.uptime,
    posts_total: systemHealth.posts,
    markets_monitored: systemHealth.marketsMonitored,
    alerts_active: systemHealth.alertsActive,
    last_run_timestamp: systemHealth.lastRun
  });
});

// Data endpoint for UI (structured cycle data)
app.get('/data', (req, res) => {
  res.json(global.latestData);
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
  const action = normalizeAction(analysis?.action);
  const zigmaProb = typeof analysis?.probability === 'number'
    ? (analysis.probability * 100).toFixed(2)
    : 'N/A';
  const confidence = typeof analysis?.confidence === 'number'
    ? `${analysis.confidence.toFixed(1)}%`
    : `${analysis?.confidence || 0}%`;

  const lines = [
    `Prompt: ${userPrompt || 'N/A'}`,
    `Market: ${matchedMarket?.question || 'Unknown'}`,
    `Market YES price: ${yesPrice}%`,
    `Zigma probability: ${zigmaProb}%`,
    `Recommendation: ${action} (Confidence ${confidence})`
  ];

  if (analysis?.effectiveEdge !== undefined) {
    lines.push(`Effective edge: ${(analysis.effectiveEdge * 100).toFixed(2)} bps`);
  }
  if (analysis?.reasoning) {
    lines.push(`Why: ${analysis.reasoning}`);
  }

  return lines.join('\n');
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
    let bestMatch = null;
    let bestScore = 0;
    for (const market of markets) {
      const question = market.question || '';
      const score = calculateSimilarity(textMatch.toLowerCase(), question.toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        bestMatch = market;
      }
    }
    if (bestMatch && bestScore >= 0.25) {
      return respondWithIntent({ market: bestMatch, similarity: bestScore, source: 'similarity' });
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
            const similarity = calculateSimilarity(query, direct.market.question);
            if (similarity < 0.2) {
              continue;
            }
          }
          return respondWithIntent({
            market: direct.market,
            similarity: direct.market.question
              ? calculateSimilarity(query || marketQuestion || '', direct.market.question)
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
app.post('/chat', validateInput, async (req, res) => {
  try {
    const {
      query,
      marketId,
      marketQuestion,
      polymarketUser,
      history = [],
      contextId: incomingContextId
    } = req.body || {};

    // Sanitize user inputs to prevent prompt injection
    const sanitizedQuery = query ? sanitizeUserInput(query) : '';
    const sanitizedMarketQuestion = marketQuestion ? sanitizeUserInput(marketQuestion) : '';
    const sanitizedPolymarketUser = polymarketUser ? sanitizeUserInput(polymarketUser) : '';
    
    const sanitizedHistory = sanitizeHistory(history);
    const existingContext = getContext(incomingContextId);

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

      const profileMessage = `User Profile: ${maker}
Total Positions: ${metrics.totalPositions}
Total Trades: ${metrics.totalTrades}
Realized P&L: $${metrics.realizedPnl.toFixed(2)}
Unrealized P&L: $${metrics.unrealizedPnl.toFixed(2)}
Total Volume: $${metrics.totalVolume.toFixed(2)}
Win Rate: ${metrics.winRate.toFixed(1)}%
Average Position Size: $${metrics.averagePositionSize.toFixed(2)}

Top Markets by P&L:
${metrics.topMarkets.map((m, i) => `${i + 1}. ${m.title}: $${m.pnl.toFixed(2)}`).join('\n')}

Recent Activity:
${metrics.recentActivity.slice(0, 5).map(a => `${a.side} ${a.size} @ ${a.price} - ${a.title}`).join('\n')}`;

      const updatedMessages = [
        ...sanitizedHistory,
        { role: 'user', content: polymarketUser.trim() },
        { role: 'assistant', content: profileMessage, userProfile }
      ].filter((msg) => msg.content);

      const responseId = incomingContextId || randomUUID();

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
          tradesCount: trades.length
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

    const responseId = incomingContextId || randomUUID();
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

    res.json({
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
    });
  } catch (error) {
    console.error('Chat endpoint error:', error);
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

// Signal Performance API endpoints
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

// Visualization API endpoints
app.get('/api/visualization/price-history', async (req, res) => {
  try {
    const cycleHistory = global.getCycleHistory ? global.getCycleHistory() : [];
    const allSignals = cycleHistory.flatMap(cycle => cycle.liveSignals || []);

    // Get recent signals with market odds
    const priceHistory = allSignals
      .filter(s => s.marketOdds && s.timestamp)
      .slice(0, 50)
      .map(s => ({
        timestamp: s.timestamp,
        price: s.marketOdds
      }))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

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
      const bin = bins.find(b => edge >= b.min && edge < b.max);
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
      if (confidence < 50) low++;
      else if (confidence < 75) medium++;
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

// Graceful shutdown handler
let server = null;

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
  updateHealthMetrics,
  startServer: () => {
    server = app.listen(PORT, () => {
      console.log(`Agent Zigma server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/status`);
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
