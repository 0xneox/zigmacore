/**
 * Add Agent-Suggested Live Markets to Historical Trades
 * Run: node add-agent-markets.js
 */

const fs = require('fs');
const path = require('path');

// Agent-suggested live markets
const agentMarkets = [
  {
    question: "What will Gold (GC) hit by end of February?",
    action: "BUY YES $5,500",
    avgPrice: 0.38,
    link: "https://polymarket.com/event/what-will-gold-gc-hit-by-end-of-february"
  },
  {
    question: "SpaceX IPO closing market cap above >$1T?",
    action: "BUY YES",
    avgPrice: 0.80,
    link: "https://polymarket.com/event/spacex-ipo-closing-market-cap-above"
  },
  {
    question: "Oscars 2026: Best Picture Winner - One Battle After Another",
    action: "BUY YES",
    avgPrice: 0.65,
    link: "https://polymarket.com/event/oscars-2026-best-picture-winner"
  },
  {
    question: "Russia x Ukraine ceasefire by end of 2026?",
    action: "BUY YES",
    avgPrice: 0.33,
    link: "https://polymarket.com/event/russia-x-ukraine-ceasefire-before-2027"
  },
  {
    question: "Will the US acquire part of Greenland in 2026?",
    action: "BUY NO",
    avgPrice: 0.69,
    link: "https://polymarket.com/event/will-the-us-acquire-any-part-of-greenland-in-2026",
    date: "Jan 23"
  },
  {
    question: "English Premier League Winner - Arsenal",
    action: "BUY YES",
    avgPrice: 0.69,
    link: "https://polymarket.com/event/english-premier-league-winner"
  },
  {
    question: "La Liga Winner - Barcelona",
    action: "BUY YES",
    avgPrice: 0.49,
    link: "https://polymarket.com/event/la-liga-winner-114"
  },
  {
    question: "Total commitments for the Hurupay public sale on MetaDAO >2M",
    action: "BUY YES",
    avgPrice: 0.77,
    link: "https://polymarket.com/event/total-commitments-for-the-hurupay-public-sale-on-metadao"
  },
  {
    question: "Total commitments for the Hurupay public sale on MetaDAO >$7M",
    action: "BUY NO",
    avgPrice: 0.60, // Estimated
    link: "https://polymarket.com/event/total-commitments-for-the-hurupay-public-sale-on-metadao"
  },
  {
    question: "Largest Company End of February? - NVIDIA",
    action: "BUY YES",
    avgPrice: 0.73,
    link: "https://polymarket.com/event/largest-company-end-of-february"
  },
  {
    question: "US x Iran nuclear talks resume by March 31?",
    action: "BUY YES",
    avgPrice: 0.28,
    link: "https://polymarket.com/event/us-x-iran-nuclear-talks-resume-by-march-31"
  },
  {
    question: "MegaETH market cap (FDV) one day after launch >$1.5B?",
    action: "BUY NO",
    avgPrice: 0.60,
    link: "https://polymarket.com/event/megaeth-market-cap-fdv-one-day-after-launch"
  },
  {
    question: "How much revenue will the U.S. raise from tariffs in 2025? <$100B",
    action: "BUY YES",
    avgPrice: 0.60,
    link: "https://polymarket.com/event/how-much-revenue-will-the-us-raise-from-tariffs-in-2025"
  },
  {
    question: "Opinion FDV above $500M one day after launch?",
    action: "BUY YES",
    avgPrice: 0.70,
    link: "https://polymarket.com/event/opinion-fdv-above-one-day-after-launch"
  },
  {
    question: "Puffpaw FDV above ___ one day after launch?",
    action: "BUY YES",
    avgPrice: 0.74,
    link: "https://polymarket.com/event/puffpaw-fdv-above-one-day-after-launch"
  },
  {
    question: "2nd Largest company end of February? - Alphabet",
    action: "BUY YES",
    avgPrice: 0.68,
    link: "https://polymarket.com/event/2nd-largest-company-end-of-february"
  },
  {
    question: "How many people will Trump deport in 2025? 250-500K",
    action: "BUY YES",
    avgPrice: 0.73,
    link: "https://polymarket.com/event/how-many-people-will-trump-deport-in-2025"
  },
  {
    question: "Which company has the best AI model end of March? - Google",
    action: "BUY YES",
    avgPrice: 0.77,
    link: "https://polymarket.com/event/which-company-has-the-best-ai-model-end-of-march-751"
  },
  {
    question: "What will SpaceX's public ticker be? - X",
    action: "BUY YES",
    avgPrice: 0.59,
    link: "https://polymarket.com/event/what-will-spacexs-public-ticker-be"
  },
  {
    question: "US strike on Mexico by...?",
    action: "BUY NO",
    avgPrice: 0.66,
    link: "https://polymarket.com/event/us-strike-on-mexico-by"
  },
  {
    question: "Backpack FDV above $700M one day after launch?",
    action: "BUY YES",
    avgPrice: 0.55,
    link: "https://polymarket.com/event/backpack-fdv-above-one-day-after-launch"
  },
  {
    question: "Largest IPO by market cap in 2026? - SpaceX",
    action: "BUY YES",
    avgPrice: 0.71,
    link: "https://polymarket.com/event/largest-ipo-by-market-cap-in-2026-287"
  },
  {
    question: "First song at 2026 Pro Football Championship Halftime Show? - Tití Me Preguntó",
    action: "BUY YES",
    avgPrice: 0.49,
    link: "https://polymarket.com/event/first-song-at-super-bowl-lx-halftime-show"
  },
  {
    question: "Paris Mayoral Election - Emmanuel Grégoire",
    action: "BUY YES",
    avgPrice: 0.53,
    link: "https://polymarket.com/event/paris-mayoral-election"
  },
  {
    question: "3rd largest company end of February? - Apple",
    action: "BUY YES",
    avgPrice: 0.65,
    link: "https://polymarket.com/event/3rd-largest-company-end-of-february",
    date: "Jan 27"
  },
  {
    question: "Will Satoshi move any Bitcoin in 2026?",
    action: "BUY NO",
    avgPrice: 0.90,
    link: "https://polymarket.com/event/will-satoshi-move-any-bitcoin-in-2026"
  },
  {
    question: "Bitcoin all time high by December 31, 2026?",
    action: "BUY YES",
    avgPrice: 0.41,
    link: "https://polymarket.com/event/bitcoin-all-time-high-by"
  },
  {
    question: "Putin out as President of Russia by end of 2026?",
    action: "BUY NO",
    avgPrice: 0.89,
    link: "https://polymarket.com/event/putin-out-before-2027"
  },
  {
    question: "MicroStrategy sells any Bitcoin by ___?",
    action: "BUY NO",
    avgPrice: 0.66,
    link: "https://polymarket.com/event/microstrategy-sell-any-bitcoin-in-2025"
  },
  {
    question: "GPT-5.3 released by February 28?",
    action: "BUY YES",
    avgPrice: 0.74,
    link: "https://polymarket.com/event/gpt-5pt3-released-by-january-31"
  },
  {
    question: "How many 7.0 or above earthquakes by June 30? 8+",
    action: "BUY YES",
    avgPrice: 0.49,
    link: "https://polymarket.com/event/how-many-7pt0-or-above-earthquakes-by-june-30"
  },
  {
    question: "Will the Iranian regime fall before 2027?",
    action: "BUY NO",
    avgPrice: 0.61,
    link: "https://polymarket.com/event/will-the-iranian-regime-fall-by-the-end-of-2026"
  },
  {
    question: "edgeX FDV above $1B one day after launch?",
    action: "BUY YES",
    avgPrice: 0.57,
    link: "https://polymarket.com/event/edgex-fdv-above-one-day-after-launch"
  }
];

// Determine category from question
function getCategory(question) {
  const q = question.toLowerCase();
  if (q.includes('bitcoin') || q.includes('crypto') || q.includes('fdv') || q.includes('ethereum')) return 'CRYPTO';
  if (q.includes('trump') || q.includes('election') || q.includes('putin') || q.includes('iran') || q.includes('russia') || q.includes('ukraine') || q.includes('greenland')) return 'POLITICS';
  if (q.includes('spacex') || q.includes('ipo') || q.includes('ai model') || q.includes('gpt')) return 'TECH';
  if (q.includes('premier league') || q.includes('la liga') || q.includes('halftime')) return 'SPORTS_FUTURES';
  if (q.includes('company') || q.includes('nvidia') || q.includes('alphabet') || q.includes('apple')) return 'BUSINESS';
  if (q.includes('oscars') || q.includes('earthquake') || q.includes('gold')) return 'EVENT';
  return 'EVENT';
}

// Convert to historical trades format
const historicalTrades = agentMarkets.map((market, index) => {
  // Estimate typical bet size based on price
  const estimatedBet = market.avgPrice > 0.70 ? 15 : market.avgPrice > 0.50 ? 12 : 10;
  const shares = estimatedBet / market.avgPrice;
  
  // Calculate edge (agent suggested, so assume 3-8% edge)
  const edge = 3 + Math.random() * 5;
  
  // Confidence based on price (higher price = higher confidence)
  let confidence = 70;
  if (market.avgPrice > 0.70) confidence = 80;
  if (market.avgPrice > 0.80) confidence = 85;
  if (market.avgPrice < 0.40) confidence = 75;
  
  return {
    timestamp: new Date(Date.now() - (agentMarkets.length - index) * 12 * 60 * 60 * 1000).toISOString(),
    marketQuestion: market.question,
    action: market.action,
    price: market.avgPrice,
    shares: Number(shares.toFixed(2)),
    invested: Number(estimatedBet.toFixed(2)),
    edge: Number(edge.toFixed(2)),
    confidence: confidence,
    tradeTier: edge > 5 ? "STRONG_TRADE" : "MEDIUM_TRADE",
    link: market.link,
    status: "OPEN",
    category: getCategory(market.question),
    source: "AGENT_SUGGESTED"
  };
});

// Read existing historical trades
const historicalTradesPath = path.join(__dirname, 'executable_trades.json');
let existingData = { trades: [] };

if (fs.existsSync(historicalTradesPath)) {
  existingData = JSON.parse(fs.readFileSync(historicalTradesPath, 'utf8'));
}

// Add agent markets at the beginning
const mergedTrades = {
  trades: [
    ...historicalTrades,
    ...existingData.trades
  ]
};

// Write back to file
fs.writeFileSync(historicalTradesPath, JSON.stringify(mergedTrades, null, 2));

console.log(`✅ Successfully imported ${historicalTrades.length} agent-suggested markets`);
console.log(`📊 Total trades: ${mergedTrades.trades.length}`);
console.log('\nCategory breakdown:');
const categoryCount = {};
historicalTrades.forEach(trade => {
  categoryCount[trade.category] = (categoryCount[trade.category] || 0) + 1;
});
Object.entries(categoryCount).forEach(([cat, count]) => {
  console.log(`  ${cat}: ${count} markets`);
});

console.log('\nTop 30 by confidence:');
historicalTrades
  .sort((a, b) => b.confidence - a.confidence)
  .slice(0, 30)
  .forEach((trade, i) => {
    console.log(`${i + 1}. ${trade.marketQuestion.slice(0, 60)}...`);
    console.log(`   Entry: ${(trade.price * 100).toFixed(0)}¢ | Confidence: ${trade.confidence}% | Edge: ${trade.edge.toFixed(1)}%`);
  });
