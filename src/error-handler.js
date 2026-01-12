/**
 * Standardized Error Handling Module
 * Provides consistent error handling across the application
 */

const { recordError } = require('./monitoring');

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
 * Standardized error handler
 * @param {Error} error - The error to handle
 * @param {Object} context - Additional context
 * @param {boolean} shouldThrow - Whether to re-throw the error
 * @returns {Object|null} Error result or null if thrown
 */
function handleError(error, context = {}, shouldThrow = false) {
  const errorInfo = {
    message: error.message,
    name: error.name,
    code: error.code || 'UNKNOWN_ERROR',
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
  asyncHandler,
  safeAsync,
  withRetry,
  withTimeout,

  // Validation functions
  validateRequired,
  validateRange,
  validateProbability
};
