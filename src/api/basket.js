const express = require('express');
const router = express.Router();
const { verifyMagicToken } = require('./magic-auth');

// Real basket positions - fetched from database on startup
let DEMO_POSITIONS = [];

/**
 * Initialize basket with real markets from database
 */
async function initializeBasket() {
  try {
    const { getTradeSignals } = require('../db');
    
    console.log('[BASKET] Fetching real markets from database...');
    
    // Get recent high-quality signals
    const allSignals = await getTradeSignals();
    const signals = allSignals ? allSignals.slice(0, 50) : []; // Get 50 most recent
    
    if (!signals || signals.length === 0) {
      console.log('[BASKET] No signals found, basket will be empty');
      return;
    }
    
    // Filter for good candidates: high edge, short horizon, active
    const candidates = signals
      .filter(s => {
        // Edge is stored as decimal (0.0945 = 9.45%)
        const edgePercent = Math.abs((s.edge || 0) * 100);
        
        return (
          edgePercent > 5 && // Min 5% edge
          s.price && s.price > 0.05 && s.price < 0.95 && // Valid price range
          s.marketId && s.marketQuestion // Has required data
        );
      })
      .sort((a, b) => Math.abs(b.edge || 0) - Math.abs(a.edge || 0)) // Sort by edge descending
      .slice(0, 7); // Take top 7
    
    if (candidates.length === 0) {
      console.log('[BASKET] No suitable candidates found');
      return;
    }
    
    console.log(`[BASKET] Found ${candidates.length} real markets for basket`);
    
    // Convert to basket position format
    DEMO_POSITIONS = candidates.map((signal, i) => {
      // Determine side from action or direction field
      const side = signal.action?.includes('YES') || signal.direction === 'BUY_YES' || signal.edge > 0 
        ? 'BUY_YES' 
        : 'BUY_NO';
      
      return {
        marketId: signal.marketId,
        question: signal.marketQuestion || signal.market,
        side: side,
        entryPrice: signal.price,
        size: 40,
        edge: Math.abs((signal.edge || 0) * 100), // Convert decimal to percentage
        confidence: signal.confidence || 80,
        resolutionDate: null, // Not in current signal structure
        url: signal.link || `https://polymarket.com/event/${signal.marketId}`,
        executedAt: signal.timestamp || new Date(Date.now() - (i * 3 * 60 * 1000)).toISOString()
      };
    });
    
    console.log('[BASKET] Initialized with real markets:', DEMO_POSITIONS.map(p => p.question));
  } catch (error) {
    console.error('[BASKET] Error initializing basket:', error);
    DEMO_POSITIONS = [];
  }
}

// Initialize on module load
initializeBasket().catch(err => console.error('[BASKET] Init failed:', err));

// In-memory basket state (demo mode with real markets)
const basketState = {
  fundSize: 500,
  deployed: 0,
  available: 500,
  positions: [],
  totalPnL: 0,
  lastUpdate: null
};

// Update basket state after positions are loaded
setTimeout(() => {
  if (DEMO_POSITIONS.length > 0) {
    basketState.positions = DEMO_POSITIONS;
    basketState.deployed = DEMO_POSITIONS.length * 40;
    basketState.available = 500 - basketState.deployed;
    console.log(`[BASKET] State updated with ${DEMO_POSITIONS.length} positions`);
  }
}, 2000); // Wait 2 seconds for DB query to complete

/**
 * GET /api/basket/demo
 * Get demo basket info (no auth required for demo)
 */
router.get('/demo', async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Demo basket - 7 pre-selected trades with real-time tracking',
      fundSize: basketState.fundSize,
      deployed: basketState.deployed,
      available: basketState.available,
      positionCount: basketState.positions.length
    });
  } catch (error) {
    console.error('[BASKET] Demo info error:', error);
    res.status(500).json({
      error: 'Failed to get demo info',
      message: error.message
    });
  }
});

/**
 * GET /api/basket/positions
 * Get current basket state with live prices (demo mode - no auth required)
 */
router.get('/positions', async (req, res) => {
  try {
    if (basketState.positions.length === 0) {
      return res.json({
        success: true,
        basket: basketState,
        message: 'No active positions'
      });
    }
    
    // Fetch real prices from CLOB cache or use entry price as fallback
    const { getClobPrice } = require('../clob_price_cache');
    
    const updatedPositions = basketState.positions.map((position) => {
        try {
          // Try to get real current price from CLOB cache
          const clobPrice = getClobPrice(position.marketId);
          let currentPrice = position.entryPrice; // Fallback to entry price
          
          if (clobPrice && clobPrice.mid) {
            currentPrice = clobPrice.mid;
          } else {
            // If no CLOB price, simulate small movement for demo
            const timeSinceEntry = Date.now() - new Date(position.executedAt).getTime();
            const hoursElapsed = timeSinceEntry / (1000 * 60 * 60);
            const volatility = 0.003; // 0.3% per hour
            const randomWalk = (Math.random() - 0.5) * 2 * volatility * Math.sqrt(hoursElapsed);
            const priceChange = Math.max(-0.05, Math.min(0.05, randomWalk));
            currentPrice = Math.max(0.01, Math.min(0.99, position.entryPrice * (1 + priceChange)));
          }
          
          // Calculate P&L
          const side = position.side.toUpperCase();
          let pnl = 0;
          let pnlPercent = 0;
          
          if (side === 'BUY_YES' || side === 'YES') {
            pnl = (currentPrice - position.entryPrice) * position.size;
            pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
          } else if (side === 'BUY_NO' || side === 'NO') {
            pnl = (position.entryPrice - currentPrice) * position.size / (1 - position.entryPrice);
            pnlPercent = ((position.entryPrice - currentPrice) / (1 - position.entryPrice)) * 100;
          }
          
          // Calculate current edge
          const currentEdge = side === 'BUY_YES' || side === 'YES'
            ? (position.confidence / 100) - currentPrice
            : currentPrice - (position.confidence / 100);
          
          return {
            ...position,
            currentPrice: Number(currentPrice.toFixed(4)),
            pnl: Number(pnl.toFixed(2)),
            pnlPercent: Number(pnlPercent.toFixed(2)),
            currentEdge: Number((currentEdge * 100).toFixed(2)),
            daysToResolution: position.resolutionDate 
              ? Math.ceil((new Date(position.resolutionDate) - new Date()) / (1000 * 60 * 60 * 24))
              : null
          };
        } catch (error) {
          console.error(`[BASKET] Error updating position ${position.marketId}:`, error.message);
          return position; // Return original if update fails
        }
      });
    
    // Calculate total P&L
    const totalPnL = updatedPositions.reduce((sum, p) => sum + (p.pnl || 0), 0);
    const totalPnLPercent = (totalPnL / basketState.deployed) * 100;
    
    basketState.positions = updatedPositions;
    basketState.totalPnL = Number(totalPnL.toFixed(2));
    basketState.lastUpdate = new Date().toISOString();
    
    res.json({
      success: true,
      basket: {
        ...basketState,
        totalPnLPercent: Number(totalPnLPercent.toFixed(2)),
        roi: Number(((basketState.fundSize + totalPnL) / basketState.fundSize - 1) * 100).toFixed(2)
      }
    });
  } catch (error) {
    console.error('[BASKET] Positions error:', error);
    res.status(500).json({
      error: 'Failed to fetch positions',
      message: error.message
    });
  }
});

/**
 * POST /api/basket/update
 * Force refresh all positions
 */
router.post('/update', verifyMagicToken, async (req, res) => {
  try {
    // Just call the positions endpoint which already updates
    const positionsResponse = await new Promise((resolve, reject) => {
      router.handle({ 
        method: 'GET', 
        url: '/positions',
        user: req.user 
      }, {
        json: resolve,
        status: (code) => ({ json: (data) => reject(data) })
      });
    });
    
    res.json(positionsResponse);
  } catch (error) {
    console.error('[BASKET] Update error:', error);
    res.status(500).json({
      error: 'Failed to update basket',
      message: error.message
    });
  }
});

/**
 * POST /api/basket/close
 * Close a position
 */
router.post('/close/:marketId', verifyMagicToken, async (req, res) => {
  try {
    const { marketId } = req.params;
    const { exitPrice, realizedPnL } = req.body;
    
    const positionIndex = basketState.positions.findIndex(p => p.marketId === marketId);
    
    if (positionIndex === -1) {
      return res.status(404).json({
        error: 'Position not found'
      });
    }
    
    const position = basketState.positions[positionIndex];
    
    // Record closure
    position.closedAt = new Date().toISOString();
    position.exitPrice = exitPrice;
    position.realizedPnL = realizedPnL;
    position.status = 'CLOSED';
    
    // Update available capital
    basketState.available += position.size + realizedPnL;
    basketState.deployed -= position.size;
    
    console.log(`[BASKET] Closed position ${marketId}, realized P&L: $${realizedPnL}`);
    
    res.json({
      success: true,
      position,
      basket: basketState
    });
  } catch (error) {
    console.error('[BASKET] Close error:', error);
    res.status(500).json({
      error: 'Failed to close position',
      message: error.message
    });
  }
});

/**
 * DELETE /api/basket/reset
 * Reset basket (dev only)
 */
router.delete('/reset', verifyMagicToken, async (req, res) => {
  try {
    basketState.deployed = 0;
    basketState.available = 500;
    basketState.positions = [];
    basketState.totalPnL = 0;
    basketState.lastUpdate = null;
    
    console.log('[BASKET] Reset basket state');
    
    res.json({
      success: true,
      message: 'Basket reset',
      basket: basketState
    });
  } catch (error) {
    console.error('[BASKET] Reset error:', error);
    res.status(500).json({
      error: 'Failed to reset basket',
      message: error.message
    });
  }
});

module.exports = { router, basketState };
