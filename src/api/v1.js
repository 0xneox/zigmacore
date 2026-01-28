/**
 * Zigma API v1 Endpoints for Moltbot Integration
 * These endpoints are called by the zigmaxmolt Moltbot skill
 */

const express = require('express');
const router = express.Router();
const { analyzeWallet } = require('./wallet');

/**
 * GET /api/v1/signals
 * Get trading signals with edge analysis
 * Query params: limit, minEdge, category
 */
router.get('/signals', async (req, res) => {
  try {
    const { limit = 5, minEdge = 0.03, category } = req.query;

    // Validate parameters
    const limitNum = Math.min(Math.max(parseInt(limit) || 5, 1), 50);
    const minEdgeNum = Math.max(parseFloat(minEdge) || 0.03, 0);

    // Get signals from global data
    const cycleData = global.latestData?.cycleSummary;
    if (!cycleData || !cycleData.liveSignals) {
      return res.json([]);
    }

    // Filter and transform signals
    let signals = cycleData.liveSignals
      .filter(signal => {
        // Filter by edge
        if (signal.effectiveEdge < minEdgeNum) return false;
        
        // Filter by category if specified
        if (category && signal.category && signal.category.toLowerCase() !== category.toLowerCase()) {
          return false;
        }
        
        return true;
      })
      .slice(0, limitNum)
      .map(signal => ({
        marketId: signal.marketId || signal.id,
        question: signal.question || signal.marketQuestion,
        action: signal.action === 'YES' ? 'BUY YES' : signal.action === 'NO' ? 'BUY NO' : 'HOLD',
        marketOdds: signal.price || signal.marketOdds || 0.5,
        zigmaOdds: signal.probZigma || signal.zigmaOdds || 0.5,
        edge: signal.effectiveEdge || signal.edge || 0,
        confidence: signal.confidence || 0.5,
        tier: signal.tier || 'NO_TRADE',
        kelly: signal.kelly || 0,
        liquidity: signal.liquidity || 0,
        reasoning: signal.rationale || signal.reasoning,
        link: signal.link
      }));

    res.json(signals);
  } catch (error) {
    console.error('[API v1] Error fetching signals:', error);
    res.status(500).json({ error: 'Failed to fetch signals', message: error.message });
  }
});

/**
 * GET /api/v1/market/:marketId/analysis
 * Get deep analysis of a specific market
 */
router.get('/market/:marketId/analysis', async (req, res) => {
  try {
    const { marketId } = req.params;

    // Find market in global data
    const cycleData = global.latestData?.cycleSummary;
    if (!cycleData || !cycleData.liveSignals) {
      return res.status(404).json({ error: 'Market not found' });
    }

    const market = cycleData.liveSignals.find(s => 
      (s.marketId === marketId || s.id === marketId)
    );

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    // Transform to analysis format
    const analysis = {
      id: market.marketId || market.id,
      question: market.question || market.marketQuestion,
      probability: market.probZigma || market.zigmaOdds || 0.5,
      confidence: market.confidence || 0.5,
      edge: market.effectiveEdge || market.edge || 0,
      recommendation: market.action === 'YES' ? 'BUY YES' : market.action === 'NO' ? 'BUY NO' : 'HOLD',
      reasoning: market.rationale || market.reasoning || 'Analysis not available',
      news: market.news || []
    };

    res.json(analysis);
  } catch (error) {
    console.error('[API v1] Error analyzing market:', error);
    res.status(500).json({ error: 'Failed to analyze market', message: error.message });
  }
});

/**
 * GET /api/v1/wallet/:address
 * Analyze a Polymarket wallet
 */
router.get('/wallet/:address', async (req, res) => {
  try {
    const { address } = req.params;

    // Validate wallet address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }

    // Use existing analyzeWallet function
    const analysis = await analyzeWallet(address);

    res.json(analysis);
  } catch (error) {
    console.error('[API v1] Error analyzing wallet:', error);
    res.status(500).json({ error: 'Failed to analyze wallet', message: error.message });
  }
});

/**
 * GET /api/v1/arbitrage
 * Scan for arbitrage opportunities
 */
router.get('/arbitrage', async (req, res) => {
  try {
    const cycleData = global.latestData?.cycleSummary;
    
    // Check if arbitrage data exists
    if (!cycleData || !cycleData.arbitrageOpportunities) {
      return res.json([]);
    }

    // Transform arbitrage opportunities
    const opportunities = cycleData.arbitrageOpportunities.map(opp => ({
      type: opp.type || 'UNKNOWN',
      expectedProfit: opp.profit || opp.expectedProfit || 0,
      marketATitle: opp.marketA?.question || opp.marketA?.title,
      marketBTitle: opp.marketB?.question || opp.marketB?.title,
      trades: opp.trades || [],
      confidence: opp.confidence || 0
    }));

    res.json(opportunities);
  } catch (error) {
    console.error('[API v1] Error fetching arbitrage:', error);
    res.status(500).json({ error: 'Failed to fetch arbitrage opportunities', message: error.message });
  }
});

/**
 * GET /api/v1/access/:walletAddress
 * Get user tier and features based on $ZIGMA holdings
 */
router.get('/access/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;

    // Validate wallet address
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }

    // TODO: Implement actual $ZIGMA token balance check
    // For now, return default tier based on placeholder logic
    // This should be replaced with actual blockchain integration
    
    const tier = 'FREE'; // Default tier
    const balance = 0;
    
    const features = {
      signalsPerDay: 3,
      alerts: undefined,
      arbitrage: false,
      tracking: 1,
      apiAccess: false
    };

    // TODO: Implement actual tier logic based on $ZIGMA balance
    // Example tiers:
    // FREE: 0 tokens
    // BASIC: 100 tokens
    // PRO: 1000 tokens
    // WHALE: 10000 tokens

    res.json({
      tier,
      balance,
      features
    });
  } catch (error) {
    console.error('[API v1] Error checking access:', error);
    res.status(500).json({ error: 'Failed to check access', message: error.message });
  }
});

/**
 * GET /api/v1/stats
 * Get market statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const cycleData = global.latestData?.cycleSummary;
    
    const stats = {
      marketCount: cycleData?.marketsMonitored || 0,
      totalMarkets: cycleData?.totalMarkets || 0,
      signalsGenerated: cycleData?.liveSignals?.length || 0,
      lastUpdate: cycleData?.timestamp || new Date().toISOString()
    };

    res.json(stats);
  } catch (error) {
    console.error('[API v1] Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats', message: error.message });
  }
});

module.exports = router;
