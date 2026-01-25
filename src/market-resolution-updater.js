/**
 * Market Resolution Updater
 * Checks resolved markets and updates signal outcomes
 * This is the missing piece that connects market resolutions to analytics
 */

const fs = require('fs');
const path = require('path');
const { fetchMarketBySlug, fetchMarkets } = require('./fetcher');

// File paths
const CYCLE_HISTORY_FILE = path.join(__dirname, '..', 'cache', 'cycle_history.json');

/**
 * Check if a market has resolved and get the outcome
 * @param {string} marketId - The market ID to check
 * @returns {Object|null} - Resolution data or null if not resolved
 */
async function checkMarketResolution(marketId) {
  try {
    // Try to get market by slug (market IDs in cycle history are actually slugs)
    const market = await fetchMarketBySlug(marketId);
    
    if (!market) {
      console.log(`⚠️ Could not fetch market ${marketId}`);
      return null;
    }

    // Check if market is resolved/closed
    if (market.closed || market.outcome || market.outcomeType) {
      const outcome = market.outcome || market.outcomeType;
      
      // Normalize outcome to YES/NO
      let normalizedOutcome = null;
      if (outcome && typeof outcome === 'string') {
        if (outcome.toLowerCase() === 'yes') normalizedOutcome = 'YES';
        else if (outcome.toLowerCase() === 'no') normalizedOutcome = 'NO';
        else if (outcome === '1') normalizedOutcome = 'YES';
        else if (outcome === '0') normalizedOutcome = 'NO';
      }

      return {
        resolved: true,
        outcome: normalizedOutcome,
        rawOutcome: outcome,
        resolvedAt: new Date().toISOString(),
        finalPrice: market.yesPrice || market.price
      };
    }

    // Check if market has expired (past end date)
    const endDateFields = ['endDateIso', 'endDate', 'end_date', 'expirationDate'];
    for (const field of endDateFields) {
      if (market[field]) {
        const endDate = new Date(market[field]);
        // Add 24h buffer for resolution processing
        if (endDate <= new Date(Date.now() - 24 * 3600 * 1000)) {
          return {
            resolved: true,
            outcome: 'EXPIRED',
            resolvedAt: new Date().toISOString(),
            reason: 'Market expired without resolution'
          };
        }
      }
    }

    return { resolved: false };

  } catch (error) {
    console.error(`❌ Error checking resolution for ${marketId}:`, error.message);
    return null;
  }
}

/**
 * Update a single signal with resolution data
 * @param {Object} signal - The signal to update
 * @param {Object} resolution - Resolution data
 * @returns {Object} - Updated signal
 */
function updateSignalWithResolution(signal, resolution) {
  const updatedSignal = { ...signal };
  
  // Add resolution fields
  updatedSignal.outcome = resolution.outcome;
  updatedSignal.resolvedAt = resolution.resolvedAt;
  updatedSignal.rawOutcome = resolution.rawOutcome;
  
  // Calculate if prediction was correct
  if (resolution.outcome === 'YES' || resolution.outcome === 'NO') {
    const predictedYes = (signal.structuredAnalysis?.probability || signal.probZigma / 100) > 0.5;
    const actualYes = resolution.outcome === 'YES';
    updatedSignal.wasCorrect = predictedYes === actualYes;
  } else {
    updatedSignal.wasCorrect = null; // Expired/invalid resolution
  }

  return updatedSignal;
}

/**
 * Update cycle history with resolved signals
 * @param {Array} cycleHistory - Array of cycle data
 * @returns {Object} - Update statistics
 */
async function updateCycleHistoryWithResolutions() {
  try {
    // Read current cycle history
    let cycleHistory = [];
    if (fs.existsSync(CYCLE_HISTORY_FILE)) {
      const data = fs.readFileSync(CYCLE_HISTORY_FILE, 'utf8');
      cycleHistory = JSON.parse(data);
    }

    let totalSignalsChecked = 0;
    let newlyResolved = 0;
    let totalResolved = 0;

    console.log(`🔄 Checking resolutions for ${cycleHistory.length} cycles...`);

    // Process each cycle
    for (let i = 0; i < cycleHistory.length; i++) {
      const cycle = cycleHistory[i];
      let cycleUpdated = false;

      // Check live signals
      if (cycle.liveSignals && Array.isArray(cycle.liveSignals)) {
        for (let j = 0; j < cycle.liveSignals.length; j++) {
          const signal = cycle.liveSignals[j];
          
          // Skip if already resolved
          if (signal.outcome !== undefined) {
            totalResolved++;
            continue;
          }

          totalSignalsChecked++;
          
          // Check market resolution
          const resolution = await checkMarketResolution(signal.marketId);
          
          if (resolution && resolution.resolved) {
            console.log(`✅ Market resolved: ${signal.marketQuestion} → ${resolution.outcome}`);
            
            // Update signal with resolution
            cycle.liveSignals[j] = updateSignalWithResolution(signal, resolution);
            newlyResolved++;
            totalResolved++;
            cycleUpdated = true;
          }
        }
      }

      // Check outlook signals
      if (cycle.marketOutlook && Array.isArray(cycle.marketOutlook)) {
        for (let j = 0; j < cycle.marketOutlook.length; j++) {
          const signal = cycle.marketOutlook[j];
          
          if (signal.outcome !== undefined) {
            totalResolved++;
            continue;
          }

          totalSignalsChecked++;
          
          const resolution = await checkMarketResolution(signal.marketId);
          
          if (resolution && resolution.resolved) {
            console.log(`✅ Outlook resolved: ${signal.marketQuestion} → ${resolution.outcome}`);
            cycle.marketOutlook[j] = updateSignalWithResolution(signal, resolution);
            newlyResolved++;
            totalResolved++;
            cycleUpdated = true;
          }
        }
      }

      // Mark cycle as updated if any signals were resolved
      if (cycleUpdated) {
        cycle.lastResolutionUpdate = new Date().toISOString();
        cycleHistory[i] = cycle;
      }
    }

    // Save updated cycle history
    if (newlyResolved > 0) {
      fs.writeFileSync(CYCLE_HISTORY_FILE, JSON.stringify(cycleHistory, null, 2));
      console.log(`💾 Updated cycle history with ${newlyResolved} new resolutions`);
    }

    const stats = {
      totalCycles: cycleHistory.length,
      totalSignalsChecked,
      newlyResolved,
      totalResolved,
      timestamp: new Date().toISOString()
    };

    console.log(`📊 Resolution Update Complete:`, stats);
    return stats;

  } catch (error) {
    console.error('❌ Error updating cycle history:', error);
    throw error;
  }
}

/**
 * Get resolution statistics for analytics
 * @returns {Object} - Resolution stats
 */
function getResolutionStats() {
  try {
    if (!fs.existsSync(CYCLE_HISTORY_FILE)) {
      return { totalSignals: 0, resolvedSignals: 0, resolutionRate: 0 };
    }

    const data = fs.readFileSync(CYCLE_HISTORY_FILE, 'utf8');
    const cycleHistory = JSON.parse(data);

    let totalSignals = 0;
    let resolvedSignals = 0;
    let correctSignals = 0;

    for (const cycle of cycleHistory) {
      // Count live signals
      if (cycle.liveSignals) {
        for (const signal of cycle.liveSignals) {
          totalSignals++;
          if (signal.outcome !== undefined) {
            resolvedSignals++;
            if (signal.wasCorrect) correctSignals++;
          }
        }
      }

      // Count outlook signals
      if (cycle.marketOutlook) {
        for (const signal of cycle.marketOutlook) {
          totalSignals++;
          if (signal.outcome !== undefined) {
            resolvedSignals++;
            if (signal.wasCorrect) correctSignals++;
          }
        }
      }
    }

    return {
      totalSignals,
      resolvedSignals,
      correctSignals,
      accuracy: resolvedSignals > 0 ? correctSignals / resolvedSignals : 0,
      resolutionRate: totalSignals > 0 ? resolvedSignals / totalSignals : 0
    };

  } catch (error) {
    console.error('❌ Error getting resolution stats:', error);
    return { totalSignals: 0, resolvedSignals: 0, resolutionRate: 0 };
  }
}

/**
 * Run resolution update periodically
 * This should be called on a schedule (e.g., every hour)
 */
async function runResolutionUpdate() {
  console.log(`🕐 Starting resolution update at ${new Date().toISOString()}`);
  
  try {
    const stats = await updateCycleHistoryWithResolutions();
    
    // Log summary
    if (stats.newlyResolved > 0) {
      console.log(`🎉 Successfully resolved ${stats.newlyResolved} new signals!`);
    } else {
      console.log(`ℹ️ No new resolutions found. Checked ${stats.totalSignalsChecked} signals.`);
    }

    return stats;
  } catch (error) {
    console.error('❌ Resolution update failed:', error);
    throw error;
  }
}

module.exports = {
  checkMarketResolution,
  updateSignalWithResolution,
  updateCycleHistoryWithResolutions,
  getResolutionStats,
  runResolutionUpdate
};

// If run directly, execute resolution update
if (require.main === module) {
  runResolutionUpdate()
    .then(() => {
      console.log('✅ Resolution update completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Resolution update failed:', error);
      process.exit(1);
    });
}
