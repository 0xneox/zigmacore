const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Get historical executable trades
router.get('/historical', (req, res) => {
  try {
    const historicalTradesPath = path.join(__dirname, '../../historical_trades.json');
    
    if (!fs.existsSync(historicalTradesPath)) {
      return res.json([]);
    }

    const historicalTrades = JSON.parse(fs.readFileSync(historicalTradesPath, 'utf8'));
    
    // Transform the data to match the expected Signal interface
    const transformedTrades = historicalTrades.map((trade, index) => ({
      id: `historical-${index}`,
      marketId: trade.marketQuestion?.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase() || `trade-${index}`,
      question: trade.marketQuestion || 'Unknown Market',
      category: 'HISTORICAL',
      predictedProbability: trade.action === 'BUY_YES' ? 0.65 : 0.35, // Approximate
      confidenceScore: trade.confidence || 85,
      edge: trade.edge || 0,
      timestamp: trade.timestamp || new Date().toISOString(),
      outcome: undefined, // Historical trades may not have outcomes yet
      settledAt: undefined,
      zigmaOdds: trade.action === 'BUY_YES' ? (1 - trade.price) : trade.price,
      marketOdds: trade.price,
      action: trade.action,
      tradeTier: trade.tradeTier,
      link: trade.link
    }));

    res.json(transformedTrades);
  } catch (error) {
    console.error('Error fetching historical trades:', error);
    res.json([]);
  }
});

module.exports = router;
