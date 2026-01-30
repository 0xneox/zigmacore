/**
 * Authentication Middleware for API v1
 * Validates API keys and enforces rate limiting
 */

const crypto = require('crypto');

// In-memory API key store (in production, use database)
// Format: { apiKey: { userId, tier, createdAt, rateLimit } }
const API_KEYS = new Map();

// Rate limiting store
// Format: { apiKey: { requests: [], lastReset: timestamp } }
const RATE_LIMITS = new Map();

// Rate limit configurations per tier
const RATE_LIMIT_CONFIG = {
  WHALE: {
    perMinute: 120,
    perHour: 1200,
    perDay: -1 // Unlimited
  },
  PRO: {
    perMinute: 60,
    perHour: 600,
    perDay: 5000
  },
  BASIC: {
    perMinute: 30,
    perHour: 300,
    perDay: 2000
  },
  FREE: {
    perMinute: 10,
    perHour: 100,
    perDay: 500
  }
};

/**
 * Generate a new API key
 * @param {string} userId - User identifier
 * @param {string} tier - User tier (WHALE, PRO, BASIC, FREE)
 * @returns {string} Generated API key
 */
function generateApiKey(userId, tier = 'FREE') {
  const apiKey = `zgm_${crypto.randomBytes(32).toString('hex')}`;
  
  API_KEYS.set(apiKey, {
    userId,
    tier,
    createdAt: Date.now(),
    lastUsed: Date.now()
  });

  return apiKey;
}

/**
 * Validate API key
 * @param {string} apiKey - API key to validate
 * @returns {object|null} API key data or null if invalid
 */
function validateApiKey(apiKey) {
  if (!apiKey) return null;
  
  const keyData = API_KEYS.get(apiKey);
  if (!keyData) return null;

  // Update last used timestamp
  keyData.lastUsed = Date.now();
  API_KEYS.set(apiKey, keyData);

  return keyData;
}

/**
 * Check rate limit for API key
 * @param {string} apiKey - API key
 * @param {string} tier - User tier
 * @returns {object} { allowed: boolean, remaining: number, resetAt: timestamp }
 */
function checkRateLimit(apiKey, tier) {
  const now = Date.now();
  const config = RATE_LIMIT_CONFIG[tier] || RATE_LIMIT_CONFIG.FREE;

  // Initialize rate limit data if not exists
  if (!RATE_LIMITS.has(apiKey)) {
    RATE_LIMITS.set(apiKey, {
      requests: [],
      lastReset: now
    });
  }

  const rateLimitData = RATE_LIMITS.get(apiKey);

  // Clean up old requests (older than 24 hours)
  const dayAgo = now - (24 * 60 * 60 * 1000);
  rateLimitData.requests = rateLimitData.requests.filter(t => t > dayAgo);

  // Check daily limit
  if (config.perDay !== -1 && rateLimitData.requests.length >= config.perDay) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: rateLimitData.lastReset + (24 * 60 * 60 * 1000),
      limit: config.perDay,
      window: 'day'
    };
  }

  // Check hourly limit
  const hourAgo = now - (60 * 60 * 1000);
  const requestsLastHour = rateLimitData.requests.filter(t => t > hourAgo).length;
  if (requestsLastHour >= config.perHour) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: hourAgo + (60 * 60 * 1000),
      limit: config.perHour,
      window: 'hour'
    };
  }

  // Check minute limit
  const minuteAgo = now - (60 * 1000);
  const requestsLastMinute = rateLimitData.requests.filter(t => t > minuteAgo).length;
  if (requestsLastMinute >= config.perMinute) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: minuteAgo + (60 * 1000),
      limit: config.perMinute,
      window: 'minute'
    };
  }

  // Add current request
  rateLimitData.requests.push(now);
  RATE_LIMITS.set(apiKey, rateLimitData);

  return {
    allowed: true,
    remaining: config.perMinute - requestsLastMinute - 1,
    resetAt: minuteAgo + (60 * 1000),
    limit: config.perMinute,
    window: 'minute'
  };
}

/**
 * Express middleware for API key authentication
 */
function requireApiKey(req, res, next) {
  // Extract API key from Authorization header
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API key required. Include in Authorization header as "Bearer YOUR_API_KEY"'
    });
  }

  // Parse Bearer token
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid Authorization header format. Use "Bearer YOUR_API_KEY"'
    });
  }

  const apiKey = parts[1];

  // Validate API key
  const keyData = validateApiKey(apiKey);
  if (!keyData) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key'
    });
  }

  // Check rate limit
  const rateLimit = checkRateLimit(apiKey, keyData.tier);
  
  // Add rate limit headers
  res.setHeader('X-RateLimit-Limit', rateLimit.limit);
  res.setHeader('X-RateLimit-Remaining', rateLimit.remaining);
  res.setHeader('X-RateLimit-Reset', new Date(rateLimit.resetAt).toISOString());
  res.setHeader('X-RateLimit-Window', rateLimit.window);

  if (!rateLimit.allowed) {
    return res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Limit: ${rateLimit.limit} requests per ${rateLimit.window}`,
      resetAt: new Date(rateLimit.resetAt).toISOString(),
      tier: keyData.tier
    });
  }

  // Attach user data to request
  req.apiKey = apiKey;
  req.userId = keyData.userId;
  req.userTier = keyData.tier;

  next();
}

/**
 * Optional API key middleware (allows requests without key but tracks tier)
 */
function optionalApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    // No API key, default to FREE tier
    req.userTier = 'FREE';
    req.userId = 'anonymous';
    return next();
  }

  // Try to validate API key
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    const apiKey = parts[1];
    const keyData = validateApiKey(apiKey);
    
    if (keyData) {
      req.apiKey = apiKey;
      req.userId = keyData.userId;
      req.userTier = keyData.tier;
    } else {
      req.userTier = 'FREE';
      req.userId = 'anonymous';
    }
  } else {
    req.userTier = 'FREE';
    req.userId = 'anonymous';
  }

  next();
}

module.exports = {
  generateApiKey,
  validateApiKey,
  checkRateLimit,
  requireApiKey,
  optionalApiKey,
  RATE_LIMIT_CONFIG
};
