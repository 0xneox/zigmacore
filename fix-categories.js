const fs = require('fs');
const path = require('path');
const { classifyMarket } = require('./src/utils/classifier');

// Read cycle history
const cycleHistoryPath = path.join(__dirname, 'cache', 'cycle_history.json');
let cycleHistory = [];

try {
  cycleHistory = JSON.parse(fs.readFileSync(cycleHistoryPath, 'utf8'));
  console.log(`Loaded ${cycleHistory.length} cycles from history`);
} catch (error) {
  console.error('Error reading cycle history:', error);
  process.exit(1);
}

let updatedSignals = 0;
let totalSignals = 0;

// Update categories for all signals
cycleHistory.forEach((cycle, cycleIndex) => {
  if (cycle.liveSignals && Array.isArray(cycle.liveSignals)) {
    cycle.liveSignals.forEach((signal, signalIndex) => {
      totalSignals++;
      
      // Update category if it's UNKNOWN or missing
      if (!signal.category || signal.category === 'UNKNOWN') {
        const newCategory = classifyMarket(signal.marketQuestion);
        signal.category = newCategory;
        updatedSignals++;
        
        console.log(`Updated signal ${signalIndex} in cycle ${cycleIndex}: "${signal.marketQuestion.slice(0, 50)}..." -> ${newCategory}`);
      }
    });
  }
});

// Save updated cycle history
try {
  fs.writeFileSync(cycleHistoryPath, JSON.stringify(cycleHistory, null, 2));
  console.log(`\n✅ Success! Updated ${updatedSignals} out of ${totalSignals} signals`);
  console.log('Cycle history saved with corrected categories');
} catch (error) {
  console.error('Error saving updated cycle history:', error);
  process.exit(1);
}
