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
    const { limit = 5, minEdge = 0.03, category, rotate = 'true' } = req.query;

    // Validate parameters
    const limitNum = Math.min(Math.max(parseInt(limit) || 5, 1), 50);
    const minEdgeNum = Math.max(parseFloat(minEdge) || 0.03, 0);
    const shouldRotate = rotate !== 'false';

    // Get signals from global data
    const liveSignals = global.latestData?.liveSignals;
    if (!liveSignals || !Array.isArray(liveSignals)) {
      return res.json([]);
    }

    // Filter signals by edge
    let filteredSignals = liveSignals.filter(signal => {
      if (signal.effectiveEdge < minEdgeNum) return false;
      if (category && signal.category && signal.category.toLowerCase() !== category.toLowerCase()) {
        return false;
      }
      return true;
    });

    // Sort by edge (best first)
    filteredSignals.sort((a, b) => (b.effectiveEdge || 0) - (a.effectiveEdge || 0));

    // INSTITUTIONAL FEATURE 1: Category Diversity
    // Ensure we have signals from different categories
    const categories = ['SPORTS_FUTURES', 'POLITICS', 'CRYPTO', 'MACRO', 'EVENT'];
    const diverseSignals = [];
    const usedMarkets = new Set();

    // First pass: Get best signal from each category
    categories.forEach(cat => {
      const catSignal = filteredSignals.find(s => 
        s.category === cat && !usedMarkets.has(s.marketId || s.id)
      );
      if (catSignal) {
        diverseSignals.push(catSignal);
        usedMarkets.add(catSignal.marketId || catSignal.id);
      }
    });

    // Second pass: Fill remaining slots with best available signals
    const remainingSignals = filteredSignals.filter(s => 
      !usedMarkets.has(s.marketId || s.id)
    );
    diverseSignals.push(...remainingSignals);

    // INSTITUTIONAL FEATURE 2: Signal Rotation
    // Rotate through different signals every 6 hours to provide fresh opportunities
    let signals = diverseSignals;
    if (shouldRotate && diverseSignals.length > limitNum) {
      // Calculate rotation offset based on 6-hour windows
      const sixHourWindow = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
      const totalWindows = Math.ceil(diverseSignals.length / limitNum);
      const offset = (sixHourWindow % totalWindows) * limitNum;
      
      // Rotate signals
      signals = [
        ...diverseSignals.slice(offset),
        ...diverseSignals.slice(0, offset)
      ].slice(0, limitNum);
      
      console.log(`[API v1] Rotation: window=${sixHourWindow}, offset=${offset}, total=${diverseSignals.length}`);
    } else {
      signals = diverseSignals.slice(0, limitNum);
    }

    // Transform signals for API response
    signals = signals
      .map((signal, index) => {
        console.log(`[API v1] Signal ${index + 1}: ${signal.category} - ${(signal.effectiveEdge || 0).toFixed(2)}% edge`);
        // Parse action - backend stores as 'EXECUTE BUY YES' or 'EXECUTE BUY NO'
        let action = 'HOLD';
        if (signal.action) {
          if (signal.action.includes('BUY YES') || signal.action === 'BUY_YES') {
            action = 'BUY YES';
          } else if (signal.action.includes('BUY NO') || signal.action === 'BUY_NO') {
            action = 'BUY NO';
          }
        }

        return {
          marketId: signal.marketId || signal.id,
          question: signal.question || signal.marketQuestion || signal.market,
          action,
          marketOdds: signal.probMarket || (signal.price || 0.5) * 100,
          zigmaOdds: signal.probZigma || (signal.predictedProbability || 0.5) * 100,
          edge: signal.effectiveEdge || signal.rawEdge || signal.edge || 0,
          confidence: signal.confidenceScore || signal.confidence || signal.modelConfidence || 50,
          tier: signal.tradeTier || signal.tier || 'NO_TRADE',
          kelly: (signal.intentExposure || signal.adjustedSize || signal.kelly || 0),
          liquidity: signal.marketLiquidity || signal.liquidity || 0,
          reasoning: signal.rationale || signal.reasoning,
          link: signal.link,
          crypto: signal.crypto || null, // Add crypto correlation data if available
          tracking: signal.tracking || null // Add edge change tracking if available
        };
      });

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
    const liveSignals = global.latestData?.liveSignals;
    if (!liveSignals || !Array.isArray(liveSignals)) {
      return res.status(404).json({ error: 'Market not found' });
    }

    const market = liveSignals.find(s => 
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
    const arbitrageOpportunities = global.latestData?.arbitrageOpportunities;
    
    // Check if arbitrage data exists
    if (!arbitrageOpportunities || !Array.isArray(arbitrageOpportunities)) {
      return res.json([]);
    }

    // Transform arbitrage opportunities
    const opportunities = arbitrageOpportunities.map(opp => ({
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
    const { getAccessInfo, isValidSolanaAddress } = require('../utils/token-gating');

    // Validate Solana wallet address
    if (!isValidSolanaAddress(walletAddress)) {
      return res.status(400).json({ 
        error: 'Invalid Solana wallet address format',
        message: 'Please provide a valid Solana wallet address'
      });
    }

    // Get complete access information
    const accessInfo = await getAccessInfo(walletAddress);

    res.json(accessInfo);
  } catch (error) {
    console.error('[API v1] Error checking access:', error);
    res.status(500).json({ 
      error: 'Failed to check access', 
      message: error.message,
      tier: 'FREE',
      balance: 0,
      features: {
        signalsPerDay: 3,
        alerts: undefined,
        arbitrage: false,
        tracking: 1,
        apiAccess: false,
        walletAnalysisPerDay: 1,
        priority: 'low'
      }
    });
  }
});

/**
 * GET /api/v1/positions/exit-signals
 * Get position exit signals and recommendations
 */
router.get('/positions/exit-signals', async (req, res) => {
  try {
    const exitSignals = global.latestData?.exitSignals || [];
    
    // Transform for API response
    const signals = exitSignals.map(signal => ({
      marketId: signal.marketId,
      question: signal.question,
      category: signal.category,
      recommendation: signal.recommendation,
      urgency: signal.urgency,
      reason: signal.reason,
      entryEdge: signal.entryEdge,
      currentEdge: signal.currentEdge,
      edgeChange: signal.edgeChange,
      edgeChangePercent: signal.edgeChangePercent,
      daysHeld: signal.daysHeld,
      entryDate: signal.entryDate,
      tracking: signal.tracking
    }));

    res.json(signals);
  } catch (error) {
    console.error('[API v1] Error fetching exit signals:', error);
    res.status(500).json({ error: 'Failed to fetch exit signals', message: error.message });
  }
});

/**
 * GET /api/v1/stats
 * Get market statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const liveSignals = global.latestData?.liveSignals;
    
    const stats = {
      marketCount: liveSignals?.length || 0,
      totalMarkets: liveSignals?.length || 0,
      signalsGenerated: liveSignals?.length || 0,
      lastUpdate: global.latestData?.timestamp || new Date().toISOString()
    };

    res.json(stats);
  } catch (error) {
    console.error('[API v1] Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats', message: error.message });
  }
});

module.exports = router;
