/**
 * Signal Change Tracking Module
 * Tracks edge movements across cycles to identify opportunities and risks
 * Detects catalysts for significant changes
 */

const fs = require('fs').promises;
const path = require('path');

const TRACKING_FILE = path.join(__dirname, '../data/signal_history.json');
const SIGNIFICANT_CHANGE_THRESHOLD = 0.02; // 2% edge change is significant

/**
 * Load previous cycle signals from disk
 * @returns {Array} Previous signals
 */
async function loadPreviousSignals() {
  try {
    const data = await fs.readFile(TRACKING_FILE, 'utf8');
    const history = JSON.parse(data);
    return history.signals || [];
  } catch (error) {
    // File doesn't exist yet or parse error - return empty array
    return [];
  }
}

/**
 * Save current signals for next cycle comparison
 * @param {Array} signals - Current cycle signals
 */
async function saveSignalsForTracking(signals) {
  try {
    const trackingData = {
      timestamp: new Date().toISOString(),
      signals: signals.map(s => ({
        marketId: s.marketId || s.id,
        question: s.question || s.marketQuestion || s.market,
        category: s.category,
        edge: s.effectiveEdge || s.edge || 0,
        confidence: s.confidence || s.confidenceScore || 0,
        action: s.action,
        marketOdds: s.probMarket || 0,
        zigmaOdds: s.probZigma || 0,
        liquidity: s.marketLiquidity || s.liquidity || 0
      }))
    };

    // Ensure data directory exists
    const dir = path.dirname(TRACKING_FILE);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(TRACKING_FILE, JSON.stringify(trackingData, null, 2));
    console.log(`[TRACKING] Saved ${signals.length} signals for next cycle comparison`);
  } catch (error) {
    console.error('[TRACKING] Failed to save signals:', error.message);
  }
}

/**
 * Identify catalyst for edge change
 * @param {Object} current - Current signal
 * @param {Object} previous - Previous signal
 * @returns {string} Catalyst description
 */
function identifyCatalyst(current, previous) {
  if (!previous) return 'New signal';

  const edgeChange = current.edge - previous.edge;
  const oddsChange = current.marketOdds - previous.marketOdds;
  const confidenceChange = current.confidence - previous.confidence;
  const liquidityChange = current.liquidity - previous.liquidity;

  // Analyze what changed
  const catalysts = [];

  // Market odds shifted significantly
  if (Math.abs(oddsChange) > 5) {
    catalysts.push(`Market moved ${oddsChange > 0 ? 'up' : 'down'} ${Math.abs(oddsChange).toFixed(1)}%`);
  }

  // Our model confidence changed
  if (Math.abs(confidenceChange) > 10) {
    catalysts.push(`Model confidence ${confidenceChange > 0 ? 'increased' : 'decreased'} ${Math.abs(confidenceChange).toFixed(0)}%`);
  }

  // Liquidity changed significantly
  if (Math.abs(liquidityChange) > 10000) {
    const liquidityChangePercent = ((liquidityChange / previous.liquidity) * 100).toFixed(0);
    catalysts.push(`Liquidity ${liquidityChange > 0 ? 'increased' : 'decreased'} ${Math.abs(liquidityChangePercent)}%`);
  }

  // Action changed
  if (current.action !== previous.action) {
    catalysts.push(`Action changed: ${previous.action} → ${current.action}`);
  }

  // If no specific catalyst identified, provide generic reason
  if (catalysts.length === 0) {
    if (Math.abs(edgeChange) > 0.01) {
      catalysts.push('Market dynamics shifted');
    } else {
      catalysts.push('Minor adjustment');
    }
  }

  return catalysts.join('; ');
}

/**
 * Calculate edge changes and enhance signals with tracking data
 * @param {Array} currentSignals - Current cycle signals
 * @returns {Array} Enhanced signals with change tracking
 */
async function trackSignalChanges(currentSignals) {
  try {
    const previousSignals = await loadPreviousSignals();
    
    if (previousSignals.length === 0) {
      console.log('[TRACKING] No previous signals - first cycle');
      // Save current signals for next cycle
      await saveSignalsForTracking(currentSignals);
      return currentSignals;
    }

    console.log(`[TRACKING] Comparing ${currentSignals.length} current signals with ${previousSignals.length} previous`);

    // Enhance signals with change tracking
    const enhancedSignals = currentSignals.map(current => {
      const marketId = current.marketId || current.id;
      const previous = previousSignals.find(p => p.marketId === marketId);

      if (!previous) {
        return {
          ...current,
          tracking: {
            isNew: true,
            edgeChange: 0,
            catalyst: 'New signal - first appearance'
          }
        };
      }

      const currentEdge = current.effectiveEdge || current.edge || 0;
      const previousEdge = previous.edge || 0;
      const edgeChange = currentEdge - previousEdge;
      const edgeChangePercent = previousEdge !== 0 ? (edgeChange / previousEdge) * 100 : 0;

      const catalyst = identifyCatalyst(
        {
          edge: currentEdge,
          marketOdds: current.probMarket || 0,
          confidence: current.confidence || current.confidenceScore || 0,
          liquidity: current.marketLiquidity || current.liquidity || 0,
          action: current.action
        },
        previous
      );

      const isSignificant = Math.abs(edgeChange) >= SIGNIFICANT_CHANGE_THRESHOLD;

      const tracking = {
        isNew: false,
        edgeChange,
        edgeChangePercent,
        previousEdge,
        currentEdge,
        catalyst,
        isSignificant,
        trend: edgeChange > 0 ? 'IMPROVING' : edgeChange < 0 ? 'DETERIORATING' : 'STABLE'
      };

      if (isSignificant) {
        console.log(`[TRACKING] Significant change detected: ${current.question?.slice(0, 50)}`);
        console.log(`[TRACKING]   Edge: ${previousEdge.toFixed(2)}% → ${currentEdge.toFixed(2)}% (${edgeChange > 0 ? '+' : ''}${edgeChange.toFixed(2)}%)`);
        console.log(`[TRACKING]   Catalyst: ${catalyst}`);
      }

      return {
        ...current,
        tracking
      };
    });

    // Save current signals for next cycle
    await saveSignalsForTracking(currentSignals);

    // Count significant changes
    const significantChanges = enhancedSignals.filter(s => s.tracking?.isSignificant).length;
    const newSignals = enhancedSignals.filter(s => s.tracking?.isNew).length;
    
    console.log(`[TRACKING] Summary: ${significantChanges} significant changes, ${newSignals} new signals`);

    return enhancedSignals;
  } catch (error) {
    console.error('[TRACKING] Error tracking changes:', error.message);
    return currentSignals; // Return unenhanced signals on error
  }
}

/**
 * Get signals with significant edge changes for alerts
 * @param {Array} signals - Enhanced signals with tracking
 * @returns {Array} Signals with significant changes
 */
function getSignificantChanges(signals) {
  return signals.filter(s => s.tracking?.isSignificant);
}

/**
 * Format edge change for display
 * @param {Object} signal - Signal with tracking data
 * @returns {string} Formatted change description
 */
function formatEdgeChange(signal) {
  if (!signal.tracking) return '';

  const t = signal.tracking;
  
  if (t.isNew) {
    return '🆕 NEW SIGNAL';
  }

  const arrow = t.trend === 'IMPROVING' ? '📈' : t.trend === 'DETERIORATING' ? '📉' : '➡️';
  const sign = t.edgeChange > 0 ? '+' : '';
  
  return `${arrow} Edge: ${t.previousEdge.toFixed(1)}% → ${t.currentEdge.toFixed(1)}% (${sign}${t.edgeChange.toFixed(1)}%)`;
}

module.exports = {
  trackSignalChanges,
  getSignificantChanges,
  formatEdgeChange,
  loadPreviousSignals,
  saveSignalsForTracking
};
