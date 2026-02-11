/**
 * Remove duplicate trades from executable_trades.json
 * Run: node deduplicate-trades.js
 */

const fs = require('fs');
const path = require('path');

// Read the current trades file
const tradesPath = path.join(__dirname, 'executable_trades.json');
const data = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
const trades = data.trades || [];

console.log(`📊 Found ${trades.length} total trades`);

// Deduplicate by marketQuestion (case-insensitive)
const uniqueTrades = [];
const seenQuestions = new Set();

for (const trade of trades) {
  const question = (trade.marketQuestion || '').toLowerCase().trim();
  
  if (!seenQuestions.has(question)) {
    seenQuestions.add(question);
    uniqueTrades.push(trade);
  } else {
    console.log(`🗑️  Removed duplicate: ${trade.marketQuestion?.slice(0, 50)}...`);
  }
}

console.log(`✅ Removed ${trades.length - uniqueTrades.length} duplicates`);
console.log(`📊 Kept ${uniqueTrades.length} unique trades`);

// Write back the deduplicated data
const deduplicatedData = {
  trades: uniqueTrades
};

fs.writeFileSync(tradesPath, JSON.stringify(deduplicatedData, null, 2));

console.log('💾 Saved deduplicated trades to executable_trades.json');

// Show breakdown by source
const sourceCount = {};
uniqueTrades.forEach(trade => {
  const source = trade.source || 'UNKNOWN';
  sourceCount[source] = (sourceCount[source] || 0) + 1;
});

console.log('\n📈 Trades by source:');
Object.entries(sourceCount).forEach(([source, count]) => {
  console.log(`  ${source}: ${count} trades`);
});
