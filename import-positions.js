/**
 * Import Real Polymarket Positions to Historical Trades
 * Run: node import-positions.js
 */

const fs = require('fs');
const path = require('path');

// Your actual Polymarket positions
const positions = [
  {
    question: "Will Elon Musk post 90-114 tweets from February 2 to February 4, 2026?",
    action: "BUY YES",
    avgPrice: 0.29,
    currentPrice: 0.41,
    shares: 69.0,
    invested: 19.99,
    currentValue: 68.97,
    profit: 7.94,
    profitPercent: 39.7
  },
  {
    question: "Capitals vs. Flyers",
    action: "BUY Flyers",
    avgPrice: 0.56,
    currentPrice: 0.76,
    shares: 23.2,
    invested: 13.00,
    currentValue: 23.21,
    profit: 4.65,
    profitPercent: 35.74
  },
  {
    question: "76ers vs. Warriors",
    action: "BUY Warriors",
    avgPrice: 0.54,
    currentPrice: 0.63,
    shares: 24.1,
    invested: 13.00,
    currentValue: 24.07,
    profit: 2.05,
    profitPercent: 15.76
  },
  {
    question: "Will global temperature increase by between 1.05ºC and 1.09ºC in January 2026?",
    action: "BUY YES",
    avgPrice: 0.60,
    currentPrice: 0.69,
    shares: 11.7,
    invested: 7.00,
    currentValue: 11.67,
    profit: 1.05,
    profitPercent: 14.98
  },
  {
    question: "Will Logan Paul's PSA 10 Pokémon Illustrator Sale Price be over $10 million?",
    action: "BUY NO",
    avgPrice: 0.44,
    currentPrice: 0.48,
    shares: 22.7,
    invested: 10.00,
    currentValue: 22.73,
    profit: 0.91,
    profitPercent: 9.12
  },
  {
    question: "Israel strikes Iran by March 31, 2026?",
    action: "BUY NO",
    avgPrice: 0.64,
    currentPrice: 0.68,
    shares: 15.7,
    invested: 10.00,
    currentValue: 15.71,
    profit: 0.60,
    profitPercent: 6.05
  },
  {
    question: "Khamenei out as Supreme Leader of Iran by June 30?",
    action: "BUY NO",
    avgPrice: 0.72,
    currentPrice: 0.75,
    shares: 13.9,
    invested: 10.00,
    currentValue: 13.89,
    profit: 0.35,
    profitPercent: 3.49
  },
  {
    question: "Will the US acquire part of Greenland in 2026?",
    action: "BUY NO",
    avgPrice: 0.78,
    currentPrice: 0.80,
    shares: 12.8,
    invested: 10.00,
    currentValue: 12.82,
    profit: 0.19,
    profitPercent: 1.94
  },
  {
    question: "US strikes Iran by February 28, 2026?",
    action: "BUY NO",
    avgPrice: 0.77,
    currentPrice: 0.78,
    shares: 13.0,
    invested: 10.00,
    currentValue: 12.99,
    profit: 0.07,
    profitPercent: 0.66
  }
];

// Convert to historical trades format
const historicalTrades = positions.map((pos, index) => {
  // Calculate edge based on profit
  const edge = ((pos.currentPrice - pos.avgPrice) / pos.avgPrice) * 100;
  
  // Estimate confidence based on profit percentage
  let confidence = 70;
  if (pos.profitPercent > 30) confidence = 85;
  else if (pos.profitPercent > 15) confidence = 80;
  else if (pos.profitPercent > 5) confidence = 75;
  
  // Determine trade tier
  let tradeTier = "SMALL_TRADE";
  if (pos.profitPercent > 20) tradeTier = "STRONG_TRADE";
  else if (pos.profitPercent > 10) tradeTier = "MEDIUM_TRADE";
  
  return {
    timestamp: new Date(Date.now() - (positions.length - index) * 24 * 60 * 60 * 1000).toISOString(),
    marketQuestion: pos.question,
    action: pos.action,
    price: pos.avgPrice,
    currentPrice: pos.currentPrice,
    shares: pos.shares,
    invested: pos.invested,
    currentValue: pos.currentValue,
    profit: pos.profit,
    profitPercent: pos.profitPercent,
    edge: edge,
    confidence: confidence,
    tradeTier: tradeTier,
    link: `https://polymarket.com/search?q=${encodeURIComponent(pos.question)}`,
    status: "OPEN" // Mark as open position
  };
});

// Read existing historical trades
const historicalTradesPath = path.join(__dirname, 'executable_trades.json');
let existingData = { trades: [] };

if (fs.existsSync(historicalTradesPath)) {
  existingData = JSON.parse(fs.readFileSync(historicalTradesPath, 'utf8'));
}

// Merge with existing trades (add new ones at the beginning)
const mergedTrades = {
  trades: [
    ...historicalTrades,
    ...existingData.trades
  ]
};

// Write back to file
fs.writeFileSync(historicalTradesPath, JSON.stringify(mergedTrades, null, 2));

console.log(`✅ Successfully imported ${historicalTrades.length} positions to historical_trades.json`);
console.log(`📊 Total trades: ${mergedTrades.trades.length}`);
console.log('\nTop 3 positions by profit:');
historicalTrades
  .sort((a, b) => b.profitPercent - a.profitPercent)
  .slice(0, 3)
  .forEach((trade, i) => {
    console.log(`${i + 1}. ${trade.marketQuestion.slice(0, 60)}...`);
    console.log(`   Profit: $${trade.profit.toFixed(2)} (${trade.profitPercent.toFixed(2)}%)`);
  });
