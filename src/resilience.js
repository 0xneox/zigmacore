// Retry and backoff utilities for API resilience
const pRetry = require('p-retry');
const pTimeout = require('p-timeout');

/**
 * Exponential backoff configuration
 */
const RETRY_CONFIG = {
  retries: 3,
  factor: 2, // Exponential backoff: 1s, 2s, 4s
  minTimeout: 1000,
  maxTimeout: 10000,
  randomize: true // Add jitter to prevent thundering herd
};

/**
 * Timeout configurations by API
 */
const TIMEOUTS = {
  POLYMARKET_API: 8000,
  X_API: 15000,
  LLM_API: 30000, // LLM calls can be slow
  ACP_API: 10000
};

// Circuit breaker state (simple in-memory implementation)
let circuitBreakerState = {
  polymarket: { failures: 0, lastFailure: 0, state: 'closed' },
  x: { failures: 0, lastFailure: 0, state: 'closed' },
  llm: { failures: 0, lastFailure: 0, state: 'closed' },
  acp: { failures: 0, lastFailure: 0, state: 'closed' }
};

const CIRCUIT_BREAKER_THRESHOLD = 5; // Open after 5 failures
const CIRCUIT_BREAKER_TIMEOUT = 60000; // Reset after 1 minute

/**
 * Check if circuit breaker is open for a service
 * @param {string} service - Service name (polymarket, x, llm, acp)
 * @returns {boolean} - True if circuit is open
 */
function isCircuitOpen(service) {
  const state = circuitBreakerState[service];
  if (state.state === 'open') {
    if (Date.now() - state.lastFailure > CIRCUIT_BREAKER_TIMEOUT) {
      // Reset circuit breaker
      state.state = 'closed';
      state.failures = 0;
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Record a failure for a service
 * @param {string} service - Service name
 */
function recordFailure(service) {
  const state = circuitBreakerState[service];
  state.failures++;
  state.lastFailure = Date.now();

  if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.state = 'open';
    console.warn(`Circuit breaker opened for ${service} after ${state.failures} failures`);
  }
}

/**
 * Record a success for a service
 * @param {string} service - Service name
 */
function recordSuccess(service) {
  const state = circuitBreakerState[service];
  state.failures = 0; // Reset on success
  if (state.state === 'open') {
    state.state = 'closed';
    console.log(`Circuit breaker closed for ${service}`);
  }
}

/**
 * Safe API call wrapper with retry, backoff, timeout, and circuit breaker
 * @param {string} service - Service name (polymarket, x, llm, acp)
 * @param {Function} apiCall - Async function to execute
 * @param {number|null} timeoutMs - Optional timeout override
 * @returns {Promise<any>} - API call result
 * @throws {Error} - If circuit is open or all retries fail
 */
async function safeApiCall(service, apiCall, timeoutMs = null) {
  const serviceKey = service.toLowerCase();

  // Check circuit breaker
  if (isCircuitOpen(serviceKey)) {
    throw new Error(`Circuit breaker open for ${service} - skipping call`);
  }

  // Set timeout based on service if not specified
  const timeout = timeoutMs || TIMEOUTS[`${service.toUpperCase()}_API`] || 10000;

  try {
    const result = await pRetry(
      () => pTimeout(apiCall(), timeout, `${service} API timeout after ${timeout}ms`),
      {
        ...RETRY_CONFIG,
        onFailedAttempt: (error) => {
          console.warn(`${service} API attempt ${error.attemptNumber} failed:`, error.message);
        }
      }
    );

    // Record success
    recordSuccess(serviceKey);
    return result;

  } catch (error) {
    // Record failure for circuit breaker
    recordFailure(serviceKey);

    // Re-throw with context
    const errorMsg = `${service} API failed after retries: ${error.message}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
}

// Specific wrappers for each API
async function safePolymarketCall(apiCall) {
  return safeApiCall('polymarket', apiCall, TIMEOUTS.POLYMARKET_API);
}

async function safeXCall(apiCall) {
  return safeApiCall('x', apiCall, TIMEOUTS.X_API);
}

async function safeLlmCall(apiCall) {
  return safeApiCall('llm', apiCall, TIMEOUTS.LLM_API);
}

async function safeAcpCall(apiCall) {
  return safeApiCall('acp', apiCall, TIMEOUTS.ACP_API);
}

// Rate limiting wrapper (simple token bucket)
class RateLimiter {
  constructor(requestsPerMinute = 60) {
    this.requestsPerMinute = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.lastRefill = Date.now();
    this.refillRate = requestsPerMinute / 60000; // tokens per ms
  }

  async waitForToken() {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    this.tokens = Math.min(this.requestsPerMinute, this.tokens + timePassed * this.refillRate);
    this.lastRefill = now;

    if (this.tokens < 1) {
      const waitTime = (1 - this.tokens) / this.refillRate;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.tokens = 0;
    }

    this.tokens -= 1;
  }
}

// Global rate limiter for X API (Twitter has strict limits)
const xRateLimiter = new RateLimiter(50); // 50 requests per minute conservative

async function rateLimitedXCall(apiCall) {
  await xRateLimiter.waitForToken();
  return safeXCall(apiCall);
}

// Export circuit breaker state for monitoring
function getCircuitBreakerStatus() {
  return { ...circuitBreakerState };
}

module.exports = {
  safeApiCall,
  safePolymarketCall,
  safeXCall,
  safeLlmCall,
  safeAcpCall,
  rateLimitedXCall,
  getCircuitBreakerStatus,
  RETRY_CONFIG,
  TIMEOUTS
};
