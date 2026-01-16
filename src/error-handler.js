/**
 * Standardized Error Handling Module
 * Provides consistent error handling across the application with actionable suggestions
 */

const { recordError } = require('./monitoring');

/**
 * Actionable error suggestions mapping
 */
const ERROR_SUGGESTIONS = {
  // API Errors
  'API_ERROR': {
    suggestion: 'The external API is experiencing issues. Please try again in a few minutes or check the service status.',
    action: 'retry'
  },
  'RATE_LIMIT_EXCEEDED': {
    suggestion: 'You have exceeded the rate limit. Please wait {retryAfter} seconds before making another request.',
    action: 'wait'
  },
  
  // Market Errors
  'MARKET_ERROR': {
    suggestion: 'Unable to fetch market data. Verify the market ID is correct or try searching for the market by name.',
    action: 'verify'
  },
  'MARKET_NOT_FOUND': {
    suggestion: 'Market not found. Check the Polymarket URL or search for the market name.',
    action: 'search'
  },
  
  // User Errors
  'USER_NOT_FOUND': {
    suggestion: 'User profile not found. Verify the wallet address is correct. The user may not have trading activity.',
    action: 'verify'
  },
  'INVALID_WALLET_ADDRESS': {
    suggestion: 'Invalid wallet address format. Provide a valid Ethereum address (0x followed by 40 hex characters).',
    action: 'correct'
  },
  
  // LLM Errors
  'LLM_ERROR': {
    suggestion: 'AI analysis service issue. Try simplifying your query or break it into smaller parts.',
    action: 'simplify'
  },
  'LLM_TIMEOUT': {
    suggestion: 'AI analysis took too long. Try a more specific query or check back later.',
    action: 'wait'
  },
  'LLM_QUOTA_EXCEEDED': {
    suggestion: 'Daily AI analysis limit reached. Try again tomorrow or upgrade your plan.',
    action: 'upgrade'
  },
  
  // Database Errors
  'DATABASE_ERROR': {
    suggestion: 'Database operation failed. Please try again. If the issue persists, contact support.',
    action: 'retry'
  },
  
  // Validation Errors
  'VALIDATION_ERROR': {
    suggestion: 'Invalid input data. Check the required fields and their formats.',
    action: 'correct'
  },
  'INSUFFICIENT_DATA': {
    suggestion: 'Not enough data for analysis. Try a different market or user with more trading history.',
    action: 'change'
  },
  
  // Network Errors
  'NETWORK_ERROR': {
    suggestion: 'Network connection issue. Check your internet connection and try again.',
    action: 'check_network'
  },
  
  // Default
  'UNKNOWN_ERROR': {
    suggestion: 'An unexpected error occurred. Please try again. If the issue persists, contact support.',
    action: 'retry'
  }
};

/**
 * Custom error classes
 */
class ZigmaError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'ZigmaError';
    this.code = code;
    this.context = context;
    this.timestamp = Date.now();
  }
}

class APIError extends ZigmaError {
  constructor(message, api, statusCode, context = {}) {
    super(message, 'API_ERROR', { api, statusCode, ...context });
    this.name = 'APIError';
    this.api = api;
    this.statusCode = statusCode;
  }
}

class LLMError extends ZigmaError {
  constructor(message, provider, context = {}) {
    super(message, 'LLM_ERROR', { provider, ...context });
    this.name = 'LLMError';
    this.provider = provider;
  }
}

class DatabaseError extends ZigmaError {
  constructor(message, operation, context = {}) {
    super(message, 'DATABASE_ERROR', { operation, ...context });
    this.name = 'DatabaseError';
    this.operation = operation;
  }
}

class ValidationError extends ZigmaError {
  constructor(message, field, value, context = {}) {
    super(message, 'VALIDATION_ERROR', { field, value, ...context });
    this.name = 'ValidationError';
    this.field = field;
    this.value = value;
  }
}

class MarketError extends ZigmaError {
  constructor(message, marketId, context = {}) {
    super(message, 'MARKET_ERROR', { marketId, ...context });
    this.name = 'MarketError';
    this.marketId = marketId;
  }
}

/**
 * Get actionable suggestion for error code
 * @param {string} errorCode - Error code
 * @param {Object} context - Context variables for suggestion template
 * @returns {Object} Suggestion object with message and action
 */
function getSuggestion(errorCode, context = {}) {
  const suggestion = ERROR_SUGGESTIONS[errorCode] || ERROR_SUGGESTIONS['UNKNOWN_ERROR'];
  
  // Replace placeholders in suggestion with context values
  let message = suggestion.suggestion;
  Object.keys(context).forEach(key => {
    message = message.replace(`{${key}}`, context[key]);
  });
  
  return {
    suggestion: message,
    action: suggestion.action
  };
}

/**
 * Standardized error handler
 * @param {Error} error - The error to handle
 * @param {Object} context - Additional context
 * @param {boolean} shouldThrow - Whether to re-throw the error
 * @returns {Object|null} Error result or null if thrown
 */
function handleError(error, context = {}, shouldThrow = false) {
  const errorCode = error.code || 'UNKNOWN_ERROR';
  const suggestionData = getSuggestion(errorCode, context);
  
  const errorInfo = {
    message: error.message,
    name: error.name,
    code: errorCode,
    suggestion: suggestionData.suggestion,
    suggestedAction: suggestionData.action,
    context: {
      ...context,
      timestamp: Date.now()
    },
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
  };

  // Record error in monitoring
  recordError(errorInfo.code, errorInfo.message);

  // Log error
  console.error(`[${errorInfo.code}] ${errorInfo.message}`, errorInfo.context);

  if (shouldThrow) {
    throw error;
  }

  return errorInfo;
}

/**
 * Async error wrapper for try-catch patterns
 * @param {Function} fn - Async function to wrap
 * @param {Object} context - Context to include in error
 * @returns {Function} Wrapped function
 */
function asyncHandler(fn, context = {}) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return handleError(error, context, false);
    }
  };
}

/**
 * Safe async execution with fallback
 * @param {Function} fn - Async function to execute
 * @param {*} fallback - Fallback value on error
 * @param {Object} context - Context for error logging
 * @returns {*} Result or fallback
 */
async function safeAsync(fn, fallback = null, context = {}) {
  try {
    return await fn();
  } catch (error) {
    handleError(error, context, false);
    return fallback;
  }
}

/**
 * Retry wrapper for transient failures
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum retry attempts
 * @param {number} delayMs - Delay between retries
 * @param {Object} context - Context for error logging
 * @returns {*} Result from function
 */
async function withRetry(fn, maxRetries = 3, delayMs = 1000, context = {}) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        break;
      }

      // Exponential backoff
      const backoffDelay = delayMs * Math.pow(2, attempt);
      console.warn(`Retry attempt ${attempt + 1}/${maxRetries} after ${backoffDelay}ms`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }

  handleError(lastError, { ...context, attempts: maxRetries + 1 }, false);
  throw lastError;
}

/**
 * Timeout wrapper for async operations
 * @param {Function} fn - Async function to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} operation - Operation name for error message
 * @returns {*} Result from function
 */
async function withTimeout(fn, timeoutMs, operation = 'operation') {
  return Promise.race([
    fn(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

/**
 * Validate required fields
 * @param {Object} obj - Object to validate
 * @param {string[]} fields - Required fields
 * @param {string} context - Context for error message
 * @throws {ValidationError} If validation fails
 */
function validateRequired(obj, fields, context = 'object') {
  const missing = fields.filter(field => obj[field] === undefined || obj[field] === null);

  if (missing.length > 0) {
    throw new ValidationError(
      `Missing required fields in ${context}: ${missing.join(', ')}`,
      missing.join(', '),
      obj
    );
  }
}

/**
 * Validate number range
 * @param {number} value - Value to validate
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @param {string} field - Field name for error message
 * @throws {ValidationError} If validation fails
 */
function validateRange(value, min, max, field = 'value') {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new ValidationError(`${field} must be a number`, field, value);
  }

  if (value < min || value > max) {
    throw new ValidationError(
      `${field} must be between ${min} and ${max}`,
      field,
      value
    );
  }
}

/**
 * Validate probability (0-1)
 * @param {number} value - Probability value
 * @param {string} field - Field name
 * @throws {ValidationError} If validation fails
 */
function validateProbability(value, field = 'probability') {
  validateRange(value, 0, 1, field);
}

module.exports = {
  // Error classes
  ZigmaError,
  APIError,
  LLMError,
  DatabaseError,
  ValidationError,
  MarketError,

  // Error handling functions
  handleError,
  getSuggestion,
  asyncHandler,
  safeAsync,
  withRetry,
  withTimeout,

  // Validation functions
  validateRequired,
  validateRange,
  validateProbability
};
