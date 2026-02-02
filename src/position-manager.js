/**
 * Position Management & Exit Signal Module
 * Tracks user positions and generates exit/hold/add recommendations
 * Completes the trading loop: Entry → Management → Exit
 */

const fs = require('fs').promises;
const path = require('path');

const POSITIONS_FILE = path.join(__dirname, '../data/tracked_positions.json');

// Exit signal thresholds
const EXIT_EDGE_THRESHOLD = 0.02; // Exit if edge drops below 2%
const ADD_EDGE_MULTIPLIER = 1.5; // Add if edge improves by 50%
const TAKE_PROFIT_EDGE_MULTIPLIER = 2.0; // Take partial profit if edge doubles
const STOP_LOSS_EDGE = -0.01; // Exit if edge goes negative

/**
 * Load tracked positions from disk
 * @returns {Array} User positions
 */
async function loadPositions() {
  try {
    const data = await fs.readFile(POSITIONS_FILE, 'utf8');
    const positions = JSON.parse(data);
    return positions.positions || [];
  } catch (error) {
    // File doesn't exist yet
    return [];
  }
}

/**
 * Save positions to disk
 * @param {Array} positions - Positions to save
 */
async function savePositions(positions) {
  try {
    const dir = path.dirname(POSITIONS_FILE);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(POSITIONS_FILE, JSON.stringify({
      timestamp: new Date().toISOString(),
      positions
    }, null, 2));

    console.log(`[POSITIONS] Saved ${positions.length} tracked positions`);
  } catch (error) {
    console.error('[POSITIONS] Failed to save positions:', error.message);
  }
}

/**
 * Add a new position to tracking
 * @param {Object} position - Position details
 */
async function addPosition(position) {
  const positions = await loadPositions();
  
  // Extract marketId from various possible property names
  const marketId = position.marketId || position.id;
  
  // Check if position already exists
  const existing = positions.find(p => p.marketId === marketId);
  if (existing) {
    console.log(`[POSITIONS] Position already tracked: ${marketId}`);
    return;
  }

  // Extract question from various possible property names
  const question = position.question || position.marketQuestion || position.market || 'Unknown Market';
  
  const newPosition = {
    marketId: marketId,
    question: question,
    category: position.category,
    entryDate: new Date().toISOString(),
    entryEdge: position.effectiveEdge || position.edge || 0,
    entryPrice: position.probMarket || position.marketOdds || 0,
    entryConfidence: position.confidence || position.confidenceScore || 0,
    action: position.action,
    size: position.kelly || 0.04,
    status: 'ACTIVE'
  };

  positions.push(newPosition);
  await savePositions(positions);
  
  console.log(`[POSITIONS] Added position: ${question.slice(0, 50)}`);
}

/**
 * Remove a position from tracking
 * @param {string} marketId - Market ID to remove
 */
async function removePosition(marketId) {
  const positions = await loadPositions();
  const filtered = positions.filter(p => p.marketId !== marketId);
  
  if (filtered.length < positions.length) {
    await savePositions(filtered);
    console.log(`[POSITIONS] Removed position: ${marketId}`);
  }
}

/**
 * Generate exit signals for tracked positions
 * @param {Array} currentSignals - Current cycle signals
 * @returns {Array} Exit signals with recommendations
 */
async function generateExitSignals(currentSignals) {
  try {
    const positions = await loadPositions();
    
    if (positions.length === 0) {
      console.log('[POSITIONS] No tracked positions');
      return [];
    }

    console.log(`[POSITIONS] Analyzing ${positions.length} positions for exit signals`);

    const exitSignals = [];

    for (const position of positions) {
      // Find current signal for this position
      const currentSignal = currentSignals.find(s => 
        (s.marketId || s.id) === position.marketId
      );

      if (!currentSignal) {
        // Signal no longer appears - market may have resolved or edge disappeared
        exitSignals.push({
          ...position,
          recommendation: 'EXIT',
          reason: 'Signal no longer available - market may have resolved',
          urgency: 'HIGH',
          currentEdge: 0,
          edgeChange: -position.entryEdge
        });
        continue;
      }

      const currentEdge = currentSignal.effectiveEdge || currentSignal.edge || 0;
      const edgeChange = currentEdge - position.entryEdge;
      const edgeChangePercent = (edgeChange / position.entryEdge) * 100;

      // Determine recommendation based on edge movement
      let recommendation = 'HOLD';
      let reason = 'Edge stable - maintain position';
      let urgency = 'LOW';

      // STOP LOSS: Edge went negative
      if (currentEdge < STOP_LOSS_EDGE) {
        recommendation = 'EXIT';
        reason = `STOP LOSS: Edge turned negative (${currentEdge.toFixed(2)}%)`;
        urgency = 'CRITICAL';
      }
      // EXIT: Edge deteriorated significantly
      else if (currentEdge < EXIT_EDGE_THRESHOLD) {
        recommendation = 'EXIT';
        reason = `Edge dropped below ${EXIT_EDGE_THRESHOLD * 100}% threshold (now ${currentEdge.toFixed(2)}%)`;
        urgency = 'HIGH';
      }
      // TAKE PROFIT: Edge doubled
      else if (currentEdge >= position.entryEdge * TAKE_PROFIT_EDGE_MULTIPLIER) {
        recommendation = 'TAKE_PROFIT';
        reason = `Edge doubled! Consider taking 50% profit (${position.entryEdge.toFixed(2)}% → ${currentEdge.toFixed(2)}%)`;
        urgency = 'MEDIUM';
      }
      // ADD: Edge improved significantly
      else if (currentEdge >= position.entryEdge * ADD_EDGE_MULTIPLIER) {
        recommendation = 'ADD';
        reason = `Edge improved ${edgeChangePercent.toFixed(0)}% - consider adding to position`;
        urgency = 'MEDIUM';
      }
      // HOLD: Edge stable or minor changes
      else if (Math.abs(edgeChange) < 0.01) {
        recommendation = 'HOLD';
        reason = 'Edge stable - maintain position';
        urgency = 'LOW';
      }
      // MONITOR: Edge declining but not critical
      else if (edgeChange < 0) {
        recommendation = 'MONITOR';
        reason = `Edge declining (${edgeChange > 0 ? '+' : ''}${edgeChange.toFixed(2)}%) - watch closely`;
        urgency = 'MEDIUM';
      }

      const exitSignal = {
        ...position,
        currentEdge,
        currentPrice: currentSignal.probMarket || 0,
        currentConfidence: currentSignal.confidence || currentSignal.confidenceScore || 0,
        edgeChange,
        edgeChangePercent,
        recommendation,
        reason,
        urgency,
        daysHeld: Math.floor((Date.now() - new Date(position.entryDate).getTime()) / (1000 * 60 * 60 * 24)),
        tracking: currentSignal.tracking || null
      };

      exitSignals.push(exitSignal);

      // Log significant recommendations
      if (urgency !== 'LOW') {
        console.log(`[POSITIONS] ${urgency} - ${recommendation}: ${position.question?.slice(0, 50)}`);
        console.log(`[POSITIONS]   Entry: ${position.entryEdge.toFixed(2)}% → Current: ${currentEdge.toFixed(2)}% (${edgeChange > 0 ? '+' : ''}${edgeChange.toFixed(2)}%)`);
        console.log(`[POSITIONS]   Reason: ${reason}`);
      }
    }

    // Count recommendations by type
    const summary = {
      total: exitSignals.length,
      exit: exitSignals.filter(s => s.recommendation === 'EXIT').length,
      takeProfit: exitSignals.filter(s => s.recommendation === 'TAKE_PROFIT').length,
      add: exitSignals.filter(s => s.recommendation === 'ADD').length,
      monitor: exitSignals.filter(s => s.recommendation === 'MONITOR').length,
      hold: exitSignals.filter(s => s.recommendation === 'HOLD').length
    };

    console.log(`[POSITIONS] Summary: ${summary.exit} exits, ${summary.takeProfit} take profits, ${summary.add} adds, ${summary.monitor} monitors, ${summary.hold} holds`);

    return exitSignals;
  } catch (error) {
    console.error('[POSITIONS] Error generating exit signals:', error.message);
    return [];
  }
}

/**
 * Get actionable exit signals (EXIT, TAKE_PROFIT, ADD)
 * @param {Array} exitSignals - All exit signals
 * @returns {Array} Actionable signals only
 */
function getActionableExitSignals(exitSignals) {
  return exitSignals.filter(s => 
    ['EXIT', 'TAKE_PROFIT', 'ADD'].includes(s.recommendation)
  );
}

/**
 * Format exit signal for display
 * @param {Object} signal - Exit signal
 * @returns {string} Formatted message
 */
function formatExitSignal(signal) {
  const emoji = {
    'EXIT': '🚪',
    'TAKE_PROFIT': '💰',
    'ADD': '➕',
    'MONITOR': '👀',
    'HOLD': '✋'
  }[signal.recommendation] || '❓';

  const urgencyEmoji = {
    'CRITICAL': '🚨',
    'HIGH': '⚠️',
    'MEDIUM': '📊',
    'LOW': 'ℹ️'
  }[signal.urgency] || '';

  const edgeSign = signal.edgeChange > 0 ? '+' : '';

  return `
${urgencyEmoji} ${emoji} **${signal.recommendation}** - ${signal.question?.slice(0, 50)}

• Entry Edge: ${signal.entryEdge.toFixed(2)}% → Current: ${signal.currentEdge.toFixed(2)}% (${edgeSign}${signal.edgeChange.toFixed(2)}%)
• Days Held: ${signal.daysHeld}
• **Reason:** ${signal.reason}
`.trim();
}

/**
 * Auto-track signals that become executable trades
 * @param {Array} signals - Executable trade signals
 */
async function autoTrackNewPositions(signals) {
  const strongSignals = signals.filter(s => 
    s.tradeTier === 'STRONG_TRADE' && 
    (s.effectiveEdge || s.edge || 0) >= 0.03 // 3%+ edge
  );

  for (const signal of strongSignals) {
    await addPosition(signal);
  }
}

module.exports = {
  loadPositions,
  savePositions,
  addPosition,
  removePosition,
  generateExitSignals,
  getActionableExitSignals,
  formatExitSignal,
  autoTrackNewPositions
};
