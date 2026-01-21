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
  const db = supabase;
  
  // Get unreconciled signals (outcome IS NULL)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: pendingSignals, error } = await db
    .from('trade_signals')
    .select('id, market_id, action, price, confidence, edge, category, timestamp')
    .is('outcome', null)
    .gt('timestamp', thirtyDaysAgo);
  
  if (error) {
    console.error('[RESOLUTION] Failed to fetch pending signals:', error.message);
    return { reconciled: 0, pending: 0 };
  }
  
  if (!pendingSignals || pendingSignals.length === 0) {
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
      const { error: updateError } = await db
        .from('trade_signals')
        .update({
          outcome: resolvedYes ? 'YES' : 'NO',
          resolved_at: new Date().toISOString(),
          actual_pnl: pnl,
          was_correct: wasCorrect ? 1 : 0
        })
        .eq('id', signal.id);
      
      // Feed back to adaptive learning system
      try {
        const { recordSignalOutcome } = require('./adaptive-learning');
        recordSignalOutcome(
          signal.id,
          resolvedYes ? 'YES' : 'NO',
          signal.category,
          signal.action,
          signal.edge,
          signal.confidence
        );
      } catch (e) {
        console.warn('[RESOLUTION] Failed to record for adaptive learning:', e.message);
      }
      
      if (updateError) {
        console.error('[RESOLUTION] Failed to update signal:', updateError.message);
        continue;
      }
      
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
  const db = supabase;
  
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  
  // Using Supabase query instead of SQLite
  return db
    .from('trade_signals')
    .select('category, was_correct, actual_pnl, confidence, edge')
    .not('outcome', 'is', null)
    .gt('timestamp', thirtyDaysAgo)
    .then(({ data, error }) => {
      if (error) {
        console.error('[RESOLUTION] Failed to get accuracy metrics:', error.message);
        return [];
      }
      
      // Group by category and calculate metrics
      const categoryMap = new Map();
      data.forEach(signal => {
        const category = signal.category || 'OTHER';
        if (!categoryMap.has(category)) {
          categoryMap.set(category, {
            category,
            total: 0,
            correct: 0,
            avgPnl: 0,
            avgConfidence: 0,
            avgEdge: 0
          });
        }
        
        const stats = categoryMap.get(category);
        stats.total++;
        if (signal.was_correct === 1) stats.correct++;
        stats.avgPnl += signal.actual_pnl || 0;
        stats.avgConfidence += signal.confidence || 0;
        stats.avgEdge += signal.edge || 0;
      });
      
      // Calculate final metrics
      return Array.from(categoryMap.values()).map(stats => ({
        category: stats.category,
        total: stats.total,
        correct: stats.correct,
        avgPnl: stats.avgPnl / stats.total,
        avgConfidence: stats.avgConfidence / stats.total,
        avgEdge: stats.avgEdge / stats.total,
        winRate: stats.total > 0 ? (stats.correct / stats.total * 100).toFixed(1) : 0,
        calibrationError: Math.abs(((stats.correct / stats.total * 100) - (stats.avgConfidence / stats.total))).toFixed(1)
      }));
    })
    .catch(error => {
      console.error('[RESOLUTION] Error in getAccuracyMetrics:', error);
      return [];
    });
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
      
      // Log updated accuracy - getAccuracyMetrics returns a Promise!
      const metrics = await getAccuracyMetrics();
      if (Array.isArray(metrics)) {
        metrics.forEach(m => {
          console.log(`[ACCURACY] ${m.category}: ${m.winRate}% win rate (${m.total} signals)`);
        });
      }
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