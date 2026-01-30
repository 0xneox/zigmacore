// API endpoints for performance metrics and signal outcomes
const express = require('express');
const router = express.Router();
const { initDb } = require('../db');
const { 
  checkPendingResolutions, 
  updatePerformanceMetrics,
  getUpcomingResolutions,
  manualResolve
} = require('../resolution-monitor');

/**
 * GET /api/performance/metrics
 * Get aggregate performance metrics
 */
router.get('/metrics', async (req, res) => {
  try {
    const db = initDb();
    const { period = 'all_time' } = req.query;
    
    const { data, error } = await db
      .from('performance_metrics')
      .select('*')
      .eq('period', period)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();
    
    if (error && error.code !== 'PGRST116') { // Not found is ok
      throw error;
    }
    
    // If no data, return defaults
    if (!data) {
      return res.json({
        total_signals: 0,
        resolved_signals: 0,
        winning_signals: 0,
        losing_signals: 0,
        win_rate: 0,
        total_pnl: 0,
        total_roi: 0,
        avg_edge: 0,
        avg_confidence: 0,
        sharpe_ratio: 0,
        profit_factor: 0,
        avg_win: 0,
        avg_loss: 0,
        max_win: 0,
        max_loss: 0
      });
    }
    
    res.json(data);
  } catch (error) {
    console.error('[API] Failed to get performance metrics:', error.message);
    res.status(500).json({ error: 'Failed to fetch performance metrics' });
  }
});

/**
 * GET /api/performance/signals
 * Get all signals with outcomes
 */
router.get('/signals', async (req, res) => {
  try {
    const db = initDb();
    const { 
      status = 'all',
      category = 'all',
      limit = 100,
      offset = 0
    } = req.query;
    
    let query = db
      .from('trade_signals')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    
    if (status !== 'all') {
      query = query.eq('status', status.toUpperCase());
    }
    
    if (category !== 'all') {
      query = query.eq('category', category);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    res.json(data || []);
  } catch (error) {
    console.error('[API] Failed to get signals:', error.message);
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

/**
 * GET /api/performance/upcoming
 * Get signals resolving soon
 */
router.get('/upcoming', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const signals = await getUpcomingResolutions(parseInt(days));
    res.json(signals);
  } catch (error) {
    console.error('[API] Failed to get upcoming resolutions:', error.message);
    res.status(500).json({ error: 'Failed to fetch upcoming resolutions' });
  }
});

/**
 * POST /api/performance/check-resolutions
 * Manually trigger resolution check
 */
router.post('/check-resolutions', async (req, res) => {
  try {
    console.log('[API] Manual resolution check triggered');
    const resolutions = await checkPendingResolutions();
    res.json({
      success: true,
      resolutions: resolutions.length,
      details: resolutions
    });
  } catch (error) {
    console.error('[API] Failed to check resolutions:', error.message);
    res.status(500).json({ error: 'Failed to check resolutions' });
  }
});

/**
 * POST /api/performance/manual-resolve
 * Manually resolve a signal
 */
router.post('/manual-resolve', async (req, res) => {
  try {
    const { marketId, outcome, actualResult } = req.body;
    
    if (!marketId || !outcome || !actualResult) {
      return res.status(400).json({ 
        error: 'Missing required fields: marketId, outcome, actualResult' 
      });
    }
    
    await manualResolve(marketId, outcome, actualResult);
    
    res.json({
      success: true,
      message: `Signal for ${marketId} resolved as ${outcome}`
    });
  } catch (error) {
    console.error('[API] Failed to manually resolve:', error.message);
    res.status(500).json({ error: 'Failed to manually resolve signal' });
  }
});

/**
 * GET /api/performance/category-stats
 * Get performance by category
 */
router.get('/category-stats', async (req, res) => {
  try {
    const db = initDb();
    
    const { data, error } = await db
      .from('trade_signals')
      .select('category, status, outcome, pnl, edge, confidence')
      .eq('status', 'RESOLVED');
    
    if (error) throw error;
    
    // Group by category
    const categoryStats = {};
    
    (data || []).forEach(signal => {
      const cat = signal.category || 'UNKNOWN';
      if (!categoryStats[cat]) {
        categoryStats[cat] = {
          total: 0,
          wins: 0,
          losses: 0,
          totalPnl: 0,
          avgEdge: 0,
          avgConfidence: 0
        };
      }
      
      categoryStats[cat].total++;
      if (signal.outcome === 'WIN') categoryStats[cat].wins++;
      if (signal.outcome === 'LOSS') categoryStats[cat].losses++;
      categoryStats[cat].totalPnl += parseFloat(signal.pnl || 0);
      categoryStats[cat].avgEdge += parseFloat(signal.edge || 0);
      categoryStats[cat].avgConfidence += parseFloat(signal.confidence || 0);
    });
    
    // Calculate averages
    Object.keys(categoryStats).forEach(cat => {
      const stats = categoryStats[cat];
      stats.winRate = stats.total > 0 ? stats.wins / stats.total : 0;
      stats.avgEdge = stats.total > 0 ? stats.avgEdge / stats.total : 0;
      stats.avgConfidence = stats.total > 0 ? stats.avgConfidence / stats.total : 0;
    });
    
    res.json(categoryStats);
  } catch (error) {
    console.error('[API] Failed to get category stats:', error.message);
    res.status(500).json({ error: 'Failed to fetch category stats' });
  }
});

/**
 * POST /api/performance/recalculate
 * Recalculate all performance metrics
 */
router.post('/recalculate', async (req, res) => {
  try {
    await updatePerformanceMetrics();
    res.json({ success: true, message: 'Performance metrics recalculated' });
  } catch (error) {
    console.error('[API] Failed to recalculate metrics:', error.message);
    res.status(500).json({ error: 'Failed to recalculate metrics' });
  }
});

module.exports = router;
