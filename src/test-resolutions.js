/**
 * Test Resolution Simulator
 * Simulates resolved markets for testing analytics
 * This should only be used for testing purposes
 */

const fs = require('fs');
const path = require('path');

const CYCLE_HISTORY_FILE = path.join(__dirname, '..', 'cache', 'cycle_history.json');

/**
 * Simulate resolutions for testing
 */
function simulateResolutions() {
  try {
    // Read current cycle history
    let cycleHistory = [];
    if (fs.existsSync(CYCLE_HISTORY_FILE)) {
      const data = fs.readFileSync(CYCLE_HISTORY_FILE, 'utf8');
      cycleHistory = JSON.parse(data);
    }

    let totalSimulated = 0;

    // Get the first few cycles and simulate some resolutions
    for (let i = 0; i < Math.min(5, cycleHistory.length); i++) {
      const cycle = cycleHistory[i];
      let cycleUpdated = false;

      // Simulate resolutions for live signals
      if (cycle.liveSignals && Array.isArray(cycle.liveSignals)) {
        for (let j = 0; j < Math.min(3, cycle.liveSignals.length); j++) {
          const signal = cycle.liveSignals[j];
          
          // Skip if already resolved
          if (signal.outcome !== undefined) continue;

          // Simulate outcome (70% chance of being correct)
          const predictedYes = (signal.structuredAnalysis?.probability || signal.probZigma / 100) > 0.5;
          const isCorrect = Math.random() < 0.7; // 70% accuracy simulation
          const actualOutcome = isCorrect ? (predictedYes ? 'YES' : 'NO') : (predictedYes ? 'NO' : 'YES');

          // Update signal with simulated resolution
          cycle.liveSignals[j] = {
            ...signal,
            outcome: actualOutcome,
            resolvedAt: new Date(Date.now() - Math.random() * 7 * 24 * 3600 * 1000).toISOString(), // Random time in last week
            wasCorrect: isCorrect,
            rawOutcome: actualOutcome
          };

          totalSimulated++;
          cycleUpdated = true;
          
          console.log(`🎯 Simulated: ${signal.marketQuestion} → ${actualOutcome} (${isCorrect ? '✓' : '✗'})`);
        }
      }

      if (cycleUpdated) {
        cycleHistory[i] = cycle;
      }
    }

    // Save updated cycle history
    if (totalSimulated > 0) {
      fs.writeFileSync(CYCLE_HISTORY_FILE, JSON.stringify(cycleHistory, null, 2));
      console.log(`💾 Simulated ${totalSimulated} market resolutions`);
    }

    return totalSimulated;

  } catch (error) {
    console.error('❌ Error simulating resolutions:', error);
    throw error;
  }
}

/**
 * Clear simulated resolutions
 */
function clearSimulatedResolutions() {
  try {
    // Read current cycle history
    let cycleHistory = [];
    if (fs.existsSync(CYCLE_HISTORY_FILE)) {
      const data = fs.readFileSync(CYCLE_HISTORY_FILE, 'utf8');
      cycleHistory = JSON.parse(data);
    }

    let totalCleared = 0;

    // Remove all simulated resolutions
    for (let i = 0; i < cycleHistory.length; i++) {
      const cycle = cycleHistory[i];
      let cycleUpdated = false;

      // Clear live signals
      if (cycle.liveSignals && Array.isArray(cycle.liveSignals)) {
        for (let j = 0; j < cycle.liveSignals.length; j++) {
          const signal = cycle.liveSignals[j];
          
          if (signal.outcome !== undefined) {
            const { outcome, resolvedAt, wasCorrect, rawOutcome, ...cleanSignal } = signal;
            cycle.liveSignals[j] = cleanSignal;
            totalCleared++;
            cycleUpdated = true;
          }
        }
      }

      // Clear outlook signals
      if (cycle.marketOutlook && Array.isArray(cycle.marketOutlook)) {
        for (let j = 0; j < cycle.marketOutlook.length; j++) {
          const signal = cycle.marketOutlook[j];
          
          if (signal.outcome !== undefined) {
            const { outcome, resolvedAt, wasCorrect, rawOutcome, ...cleanSignal } = signal;
            cycle.marketOutlook[j] = cleanSignal;
            totalCleared++;
            cycleUpdated = true;
          }
        }
      }

      if (cycleUpdated) {
        cycleHistory[i] = cycle;
      }
    }

    // Save updated cycle history
    if (totalCleared > 0) {
      fs.writeFileSync(CYCLE_HISTORY_FILE, JSON.stringify(cycleHistory, null, 2));
      console.log(`🧹 Cleared ${totalCleared} simulated resolutions`);
    }

    return totalCleared;

  } catch (error) {
    console.error('❌ Error clearing simulated resolutions:', error);
    throw error;
  }
}

// Command line interface
const command = process.argv[2];

if (command === 'simulate') {
  console.log('🎲 Simulating market resolutions for testing...');
  const count = simulateResolutions();
  console.log(`✅ Simulated ${count} resolutions`);
} else if (command === 'clear') {
  console.log('🧹 Clearing simulated resolutions...');
  const count = clearSimulatedResolutions();
  console.log(`✅ Cleared ${count} resolutions`);
} else {
  console.log('Usage:');
  console.log('  node src/test-resolutions.js simulate  - Simulate some resolved markets');
  console.log('  node src/test-resolutions.js clear     - Clear all simulated resolutions');
}
