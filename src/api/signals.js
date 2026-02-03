const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Middleware to verify user authentication
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }

    const token = authHeader.substring(7);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Unauthorized - Invalid token' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// GET /api/signals - Get user's signals
router.get('/', authenticateUser, async (req, res) => {
  try {
    const { limit = 50, status } = req.query;
    
    let query = supabase
      .from('user_signals')
      .select('*')
      .eq('user_id', req.user.id)
      .order('timestamp', { ascending: false })
      .limit(parseInt(limit));

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Get signals error:', error);
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

// GET /api/signals/performance - Get user's signal performance metrics
router.get('/performance', authenticateUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .rpc('get_user_signal_performance', { p_user_id: req.user.id });

    if (error) throw error;

    res.json(data[0] || {});
  } catch (error) {
    console.error('Get performance error:', error);
    res.status(500).json({ error: 'Failed to fetch performance metrics' });
  }
});

// POST /api/signals - Create a new signal (for system use)
router.post('/', authenticateUser, async (req, res) => {
  try {
    const signalData = req.body;
    
    const { data, error } = await supabase
      .from('user_signals')
      .insert({ ...signalData, user_id: req.user.id })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (error) {
    console.error('Create signal error:', error);
    res.status(500).json({ error: 'Failed to create signal' });
  }
});

// PUT /api/signals/:signalId - Update signal (e.g., mark as executed)
router.put('/:signalId', authenticateUser, async (req, res) => {
  try {
    const { signalId } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from('user_signals')
      .update(updates)
      .eq('id', signalId)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Update signal error:', error);
    res.status(500).json({ error: 'Failed to update signal' });
  }
});

// GET /api/signals/watchlist/:watchlistId - Get signals for specific watchlist item
router.get('/watchlist/:watchlistId', authenticateUser, async (req, res) => {
  try {
    const { watchlistId } = req.params;
    const { limit = 10 } = req.query;

    const { data, error } = await supabase
      .from('user_signals')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('watchlist_item_id', watchlistId)
      .order('timestamp', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Get watchlist signals error:', error);
    res.status(500).json({ error: 'Failed to fetch watchlist signals' });
  }
});

// POST /api/signals/generate - Generate signals for user's watchlist (system endpoint)
router.post('/generate', authenticateUser, async (req, res) => {
  try {
    // This would typically be called by a background job
    // For now, it's a placeholder for signal generation logic
    
    const { data, error } = await supabase
      .from('watchlist')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('status', 'active');

    if (error) throw error;

    // Here you would integrate with your signal generation system
    // For now, return a success response
    res.json({ 
      message: 'Signal generation initiated',
      watchlist_items: data.length 
    });
  } catch (error) {
    console.error('Generate signals error:', error);
    res.status(500).json({ error: 'Failed to generate signals' });
  }
});

// GET /api/signals/recent - Get recent executable signals (PUBLIC - no auth required)
router.get('/recent', async (req, res) => {
  try {
    const { limit = 50, category, minEdge, timeRange } = req.query;
    
    // Get live signals from global data
    const liveSignals = global.latestData?.liveSignals || [];
    
    // Filter signals
    let filtered = liveSignals.filter(s => {
      // Filter by category
      if (category && category !== 'all' && s.category !== category) return false;
      
      // Filter by minimum edge
      if (minEdge && (s.effectiveEdge || s.edge || 0) < parseFloat(minEdge)) return false;
      
      return true;
    });
    
    // DEDUPLICATE by marketId ONLY - keep only the most recent signal for each unique market
    const marketMap = new Map();
    filtered.forEach(s => {
      const marketId = s.marketId;
      
      // Skip signals without a valid marketId
      if (!marketId) {
        console.warn('[API] Skipping signal without marketId:', s.question);
        return;
      }
      
      const existing = marketMap.get(marketId);
      
      if (!existing) {
        marketMap.set(marketId, s);
      } else {
        // Keep the signal with the newer timestamp
        const existingTime = new Date(existing.timestamp || 0).getTime();
        const currentTime = new Date(s.timestamp || 0).getTime();
        if (currentTime > existingTime) {
          marketMap.set(marketId, s);
        }
      }
    });
    
    // Convert back to array
    filtered = Array.from(marketMap.values());
    
    // Sort by timestamp (newest first)
    filtered.sort((a, b) => {
      const timeA = new Date(a.timestamp || 0).getTime();
      const timeB = new Date(b.timestamp || 0).getTime();
      return timeB - timeA;
    });
    
    // Limit results
    filtered = filtered.slice(0, parseInt(limit));
    
    // Transform to frontend format with CONSISTENT field names
    const signals = filtered.map(s => ({
      id: s.marketId || s.id,
      marketId: s.marketId || s.id,
      question: s.marketQuestion || s.question || s.market,
      marketQuestion: s.marketQuestion || s.question || s.market,
      category: s.category,
      // Use probZigma as the single source of truth for AI prediction
      predictedProbability: (s.probZigma || 50) / 100,
      zigmaOdds: s.probZigma || 0,
      // Use probMarket as the single source of truth for market price
      marketOdds: s.probMarket || 0,
      price: s.yesPrice || s.marketPrice || (s.probMarket || 0) / 100,  // Use yesPrice (already decimal) or marketPrice
      marketPrice: s.marketPrice || s.yesPrice || (s.probMarket || 0) / 100,  // Frontend expects this field
      // Confidence and edge - backend provides as percentage (3 = 3%), convert to decimal (0.03)
      confidence: s.confidence || 0,
      confidenceScore: s.confidence || 0,
      edge: (s.effectiveEdge || s.rawEdge || 0) / 100,  // Convert percentage to decimal: 3 → 0.03
      netEdge: (s.netEdge || s.effectiveEdge || 0) / 100,  // Convert percentage to decimal
      rawEdge: (s.rawEdge || s.effectiveEdge || 0) / 100,  // Convert percentage to decimal
      // Metadata
      timestamp: s.timestamp || new Date().toISOString(),
      action: s.action,
      direction: s.direction || s.action,
      link: s.link,
      volume: s.marketLiquidity || s.volumeNum || s.volume || 0,
      volumeNum: s.marketLiquidity || s.volumeNum || s.volume || 0,
      source: 'LIVE_CYCLE'
    }));
    
    res.json(signals);
  } catch (error) {
    console.error('Get recent signals error:', error);
    res.status(500).json({ error: 'Failed to fetch recent signals' });
  }
});

// GET /api/signals/historical - Get historical executable trades (PUBLIC - no auth required)
router.get('/historical', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    
    // Read historical trades from file
    const historicalFile = path.join(__dirname, '../../historical_trades.json');
    
    if (!fs.existsSync(historicalFile)) {
      return res.json([]);
    }
    
    const data = JSON.parse(fs.readFileSync(historicalFile, 'utf8'));
    const trades = data.trades || [];
    
    // Transform to frontend format
    const historicalTrades = trades.map(t => ({
      timestamp: t.timestamp || t.date || new Date().toISOString(),
      marketQuestion: t.marketQuestion || t.question || t.market,
      action: t.action || 'EXECUTE BUY YES',
      price: t.price || t.marketOdds || 0,
      edge: t.edge || t.effectiveEdge || 0,
      confidence: t.confidence || t.confidenceScore || 0,
      tradeTier: t.tradeTier || t.tier || 'STRONG_TRADE',
      link: t.link
    }));
    
    // Sort by timestamp (newest first)
    historicalTrades.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return timeB - timeA;
    });
    
    res.json(historicalTrades);
  } catch (error) {
    console.error('Get historical signals error:', error);
    res.status(500).json({ error: 'Failed to fetch historical signals' });
  }
});

module.exports = router;
