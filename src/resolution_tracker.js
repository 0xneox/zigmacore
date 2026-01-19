/**
 * Resolution Tracker Module
 * Tracks market outcomes and feeds back to adaptive learning
 */

const { initDb } = require('./db');
const { supabase } = require('./supabase');
const axios = require('axios');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // Check every 6 hours

/**
 * Fetch resolved markets from Polymarket
 */
async function fetchResolvedMarkets(since = null) {
  try {
    const params = {
      closed: true,
      limit: 100,
      order: 'endDate',
      ascending: false
    };
    
    const response = await axios.get(`${GAMMA_API}/markets`, { 
      params,
      timeout: 10000 
    });
    
    return response.data.filter(m => m.resolved && m.resolutionSource);
  } catch (error) {
    console.error('[RESOLUTION] Failed to fetch resolved markets:', error.message);
    return [];
  }
}

/**
 * Match our signals against resolved markets
 */
async function reconcileSignals() {
  const db = initDb();
  
  // Get unreconciled signals (outcome IS NULL)
  const pendingSignals = db.prepare(`
    SELECT id, market_id, action, price, confidence, edge, category, timestamp
    FROM trade_signals
    WHERE outcome IS NULL
    AND timestamp > datetime('now', '-30 days')
  `).all();
  
  if (pendingSignals.length === 0) {
    console.log('[RESOLUTION] No pending signals to reconcile');
    return { reconciled: 0, pending: 0 };
  }
  
  console.log(`[RESOLUTION] Checking ${pendingSignals.length} pending signals...`);
  
  const resolvedMarkets = await fetchResolvedMarkets();
  const resolvedMap = new Map(resolvedMarkets.map(m => [m.conditionId, m]));
  
  let reconciled = 0;
  
  for (const signal of pendingSignals) {
    const market = resolvedMap.get(signal.market_id);
    
    if (market && market.resolved) {
      // Determine if signal was correct
      const resolvedYes = market.outcome === 'Yes' || market.winningOutcome === 0;
      const predictedYes = signal.action === 'BUY_YES' || signal.action === 'SELL_NO';
      const wasCorrect = predictedYes === resolvedYes;
      
      // Calculate actual P&L
      const entryPrice = signal.price;
      const exitPrice = resolvedYes ? 1.0 : 0.0;
      let pnl = 0;
      
      if (signal.action === 'BUY_YES') {
        pnl = exitPrice - entryPrice;
      } else if (signal.action === 'BUY_NO') {
        pnl = (1 - exitPrice) - (1 - entryPrice);
      }
      
      // Update signal with outcome
      db.prepare(`
        UPDATE trade_signals
        SET outcome = ?,
            resolved_at = datetime('now'),
            actual_pnl = ?,
            was_correct = ?
        WHERE id = ?
      `).run(
        resolvedYes ? 'YES' : 'NO',
        pnl,
        wasCorrect ? 1 : 0,
        signal.id
      );
      
      reconciled++;
      
      console.log(`[RESOLUTION] ${signal.market_id.slice(0, 20)}... → ${wasCorrect ? '✅ CORRECT' : '❌ WRONG'} (P&L: ${(pnl * 100).toFixed(1)}%)`);
    }
  }
  
  return {
    reconciled,
    pending: pendingSignals.length - reconciled
  };
}

/**
 * Calculate live accuracy metrics
 */
function getAccuracyMetrics() {
  const db = initDb();
  
  const metrics = db.prepare(`
    SELECT 
      category,
      COUNT(*) as total,
      SUM(CASE WHEN was_correct = 1 THEN 1 ELSE 0 END) as correct,
      AVG(actual_pnl) as avg_pnl,
      AVG(confidence) as avg_confidence,
      AVG(edge) as avg_edge
    FROM trade_signals
    WHERE outcome IS NOT NULL
    AND timestamp > datetime('now', '-30 days')
    GROUP BY category
  `).all();
  
  return metrics.map(m => ({
    ...m,
    winRate: m.total > 0 ? (m.correct / m.total * 100).toFixed(1) : 0,
    calibrationError: Math.abs((m.correct / m.total * 100) - m.avg_confidence).toFixed(1)
  }));
}

/**
 * Get category-specific edge adjustment based on historical accuracy
 */
async function getCategoryEdgeAdjustment(category) {
  try {
    // Query Supabase instead of local SQLite
    const { data, error } = await supabase
      .from('trade_signals')
      .select('was_correct, confidence, outcome')
      .eq('category', category)
      .not('outcome', 'is', null);
    
    if (error) {
      console.error('[RESOLUTION] Supabase query error:', error);
      return { adjustment: 1.0, sampleSize: 0, category };
    }
    
    if (!data || data.length === 0) {
      return { adjustment: 1.0, sampleSize: 0, category };
    }
    
    const total = data.length;
    const correct = data.filter(signal => signal.was_correct === 1).length;
    const winRate = correct / total;
    const avgConfidence = data.reduce((sum, s) => sum + (s.confidence || 0), 0) / total;
    
    // Apply edge adjustment based on historical performance
    let adjustment = 1.0;
    if (total >= 10) {
      if (winRate < 0.4) adjustment = 0.8;  // Poor performance
      else if (winRate > 0.6) adjustment = 1.2; // Good performance
    }
    
    console.log(`[RESOLUTION] Category ${category}: ${winRate.toFixed(2)} win rate, ${total} samples, ${adjustment}x adjustment`);
    
    return { adjustment, sampleSize: total, category };
    
  } catch (error) {
    console.error('[RESOLUTION] Error getting category edge adjustment:', error);
    return { adjustment: 1.0, sampleSize: 0, category };
  }
}

/**
 * Start background resolution tracker
 */
function startResolutionTracker() {
  console.log('[RESOLUTION] Starting background tracker...');
  
  // Initial check
  reconcileSignals().then(result => {
    console.log(`[RESOLUTION] Initial reconciliation: ${result.reconciled} resolved, ${result.pending} pending`);
  });
  
  // Periodic check
  setInterval(async () => {
    const result = await reconcileSignals();
    if (result.reconciled > 0) {
      console.log(`[RESOLUTION] Reconciled ${result.reconciled} signals`);
      
      // Log updated accuracy
      const metrics = getAccuracyMetrics();
      metrics.forEach(m => {
        console.log(`[ACCURACY] ${m.category}: ${m.winRate}% win rate (${m.total} signals)`);
      });
    }
  }, CHECK_INTERVAL_MS);
}

module.exports = {
  fetchResolvedMarkets,
  reconcileSignals,
  getAccuracyMetrics,
  getCategoryEdgeAdjustment,
  startResolutionTracker
};