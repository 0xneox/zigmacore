// Structured logging with Pino
const pino = require('pino');

// Create logger instance
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // In production, you might want to use a transport to send logs to external service
  ...(process.env.NODE_ENV === 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: false,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
});

// Add convenience methods for common operations
logger.cycleStart = (cycleId) => logger.info({ cycleId }, 'Agent Zigma cycle started');
logger.cycleComplete = (cycleId, stats) => logger.info({ cycleId, stats }, 'Agent Zigma cycle completed successfully');
logger.cycleError = (cycleId, error) => logger.error({ cycleId, error: error.message, stack: error.stack }, 'Agent Zigma cycle failed');

logger.apiCall = (service, operation, params) => logger.debug({ service, operation, params }, `API call to ${service}`);
logger.apiSuccess = (service, operation, duration) => logger.info({ service, operation, duration }, `API call successful`);
logger.apiError = (service, operation, error, attempt) => logger.warn({ service, operation, error: error.message, attempt }, `API call failed`);

logger.safeMode = (action, details) => logger.info({ action, details, safeMode: true }, `[SAFE_MODE] ${action}`);
logger.paymentBlocked = (userId, amount, reason) => logger.warn({ userId, amount, reason }, 'Payment blocked by SAFE_MODE');

logger.healthCheck = (metrics) => logger.debug({ metrics }, 'Health check performed');

module.exports = logger;
