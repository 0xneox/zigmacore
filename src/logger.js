// Batch logging system to prevent blocking
let logBatch = [];
let batchTimeout = null;
const BATCH_FLUSH_MS = 50;

/**
 * Flush log batch to console
 */
function flushLogBatch() {
  if (logBatch.length === 0) return;

  const batch = logBatch.splice(0);
  batch.forEach(msg => console.log(msg));

  batchTimeout = null;
}

/**
 * Format log message with metadata
 * @param {string} msg - Message to log
 * @param {Object} meta - Metadata (marketId, signalId, correlationId, etc.)
 * @returns {string} Formatted log message
 */
function formatLogMessage(msg, meta = {}) {
  const metaParts = [];
  if (meta.marketId) metaParts.push(`market=${meta.marketId}`);
  if (meta.signalId) metaParts.push(`signal=${meta.signalId}`);
  if (meta.correlationId) metaParts.push(`corr=${meta.correlationId}`);
  if (meta.category) metaParts.push(`cat=${meta.category}`);
  if (meta.action) metaParts.push(`action=${meta.action}`);

  const metaStr = metaParts.length > 0 ? `[${metaParts.join(' ')}] ` : '';
  return `${metaStr}${msg}`;
}

/**
 * Batch log function - collects messages and flushes periodically
 * @param {string} msg - Message to log
 * @param {Object} meta - Optional metadata
 */
function safeLog(msg, meta = {}) {
  const formattedMsg = formatLogMessage(msg, meta);
  logBatch.push(formattedMsg);

  if (!batchTimeout) {
    batchTimeout = setTimeout(() => {
      flushLogBatch();
    }, BATCH_FLUSH_MS);
  }
}

// Export batch logging
module.exports = {
  safeLog,
  info: (msg, meta) => safeLog(msg, meta),
  error: (msg, meta) => safeLog(`[ERROR] ${msg}`, meta),
  warn: (msg, meta) => safeLog(`[WARN] ${msg}`, meta),
  debug: (msg, meta) => safeLog(`[DEBUG] ${msg}`, meta)
};
