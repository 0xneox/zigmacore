// Resolution monitoring system for tracking signal outcomes
const axios = require('axios');
const { initDb } = require('./db');

const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

/**
 * Check if a market has resolved on Polymarket
 */
async function checkMarketResolution(marketId) {
  try {
    const response = await axios.get(`${POLYMARKET_API}/markets/${marketId}`, {
      timeout: 10000
    });
    
    const market = response.data;
    
    if (market.closed && market.resolvedOutcome !== null) {
      return {
        resolved: true,
        outcome: market.resolvedOutcome, // 'YES' or 'NO'
        resolvedAt: market.endDate || new Date().toISOString(),
        marketQuestion: market.question
      };
    }
    
    return { resolved: false };
  } catch (error) {
    console.error(`[RESOLUTION] Failed to check market ${marketId}:`, error.message);
    return { resolved: false, error: error.message };
  }
}

/**
 * Check multiple markets for resolution
 */
async function checkPendingResolutions() {
  const db = initDb();
  
  try {
    // Get all pending and executed signals
    const { data: signals, error } = await db
      .from('trade_signals')
      .select('*')
      .in('status', ['PENDING', 'EXECUTED'])
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    console.log(`[RESOLUTION] Checking ${signals.length} pending signals...`);
    
    const resolutions = [];
    
    for (const signal of signals) {
      const resolution = await checkMarketResolution(signal.market_id);
      
      if (resolution.resolved) {
        console.log(`[RESOLUTION] ✅ Market resolved: ${resolution.marketQuestion}`);
        console.log(`[RESOLUTION] Outcome: ${resolution.outcome}`);
        
        // Update signal with outcome
        await updateSignalOutcome(signal, resolution);
        resolutions.push({ signal, resolution });
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    if (resolutions.length > 0) {
      console.log(`[RESOLUTION] ✅ Updated ${resolutions.length} resolved signals`);
      
      // Recalculate performance metrics
      await updatePerformanceMetrics();
    }
    
    return resolutions;
  } catch (error) {
    console.error('[RESOLUTION] Error checking resolutions:', error.message);
    return [];
  }
}

/**
 * Update signal with resolution outcome
 */
async function updateSignalOutcome(signal, resolution) {
  const db = initDb();
  
  try {
    // Determine if signal won or lost
    const action = signal.action;
    const actualResult = resolution.outcome;
    
    let outcome;
    if (action === 'BUY YES' && actualResult === 'YES') {
      outcome = 'WIN';
    } else if (action === 'BUY NO' && actualResult === 'NO') {
      outcome = 'WIN';
    } else if (action === 'BUY YES' && actualResult === 'NO') {
      outcome = 'LOSS';
    } else if (action === 'BUY NO' && actualResult === 'YES') {
      outcome = 'LOSS';
    } else {
      outcome = 'PUSH';
    }
    
    // Calculate P&L
    const entryPrice = signal.price || 0;
    const shares = signal.shares || 100; // Default to $100 position
    const exitPrice = actualResult === 'YES' ? 1.0 : 0.0;
    
    let pnl, roi;
    if (action === 'BUY YES') {
      if (actualResult === 'YES') {
        pnl = shares * (1 - entryPrice);
        roi = (1 - entryPrice) / entryPrice;
      } else {
        pnl = -shares * entryPrice;
        roi = -1;
      }
    } else if (action === 'BUY NO') {
      if (actualResult === 'NO') {
        pnl = shares * (1 - entryPrice);
        roi = (1 - entryPrice) / entryPrice;
      } else {
        pnl = -shares * entryPrice;
        roi = -1;
      }
    }
    
    // Update signal in database
    const { error } = await db
      .from('trade_signals')
      .update({
        status: 'RESOLVED',
        outcome,
        actual_result: actualResult,
        exit_price: exitPrice,
        pnl: pnl.toFixed(2),
        roi: roi.toFixed(4),
        resolved_at: resolution.resolvedAt
      })
      .eq('id', signal.id);
    
    if (error) throw error;
    
    console.log(`[RESOLUTION] ✅ Updated signal ${signal.id}: ${outcome} (P&L: ${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)})`);
    
    return { outcome, pnl, roi };
  } catch (error) {
    console.error('[RESOLUTION] Failed to update signal outcome:', error.message);
    throw error;
  }
}

/**
 * Update aggregate performance metrics
 */
async function updatePerformanceMetrics() {
  const db = initDb();
  
  try {
    // Get all resolved signals
    const { data: signals, error } = await db
      .from('trade_signals')
      .select('*')
      .eq('status', 'RESOLVED');
    
    if (error) throw error;
    
    if (signals.length === 0) {
      console.log('[RESOLUTION] No resolved signals yet');
      return;
    }
    
    // Calculate metrics
    const totalSignals = signals.length;
    const winningSignals = signals.filter(s => s.outcome === 'WIN').length;
    const losingSignals = signals.filter(s => s.outcome === 'LOSS').length;
    const winRate = winningSignals / totalSignals;
    
    const totalPnl = signals.reduce((sum, s) => sum + parseFloat(s.pnl || 0), 0);
    const avgRoi = signals.reduce((sum, s) => sum + parseFloat(s.roi || 0), 0) / totalSignals;
    const avgEdge = signals.reduce((sum, s) => sum + parseFloat(s.edge || 0), 0) / totalSignals;
    const avgConfidence = signals.reduce((sum, s) => sum + parseFloat(s.confidence || 0), 0) / totalSignals;
    
    const wins = signals.filter(s => s.outcome === 'WIN');
    const losses = signals.filter(s => s.outcome === 'LOSS');
    
    const avgWin = wins.length > 0 ? wins.reduce((sum, s) => sum + parseFloat(s.pnl || 0), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((sum, s) => sum + parseFloat(s.pnl || 0), 0) / losses.length : 0;
    const maxWin = wins.length > 0 ? Math.max(...wins.map(s => parseFloat(s.pnl || 0))) : 0;
    const maxLoss = losses.length > 0 ? Math.min(...losses.map(s => parseFloat(s.pnl || 0))) : 0;
    
    const totalWinAmount = wins.reduce((sum, s) => sum + parseFloat(s.pnl || 0), 0);
    const totalLossAmount = Math.abs(losses.reduce((sum, s) => sum + parseFloat(s.pnl || 0), 0));
    const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : 0;
    
    // Calculate Sharpe ratio (simplified)
    const returns = signals.map(s => parseFloat(s.roi || 0));
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;
    
    // Update or insert performance metrics
    const { error: upsertError } = await db
      .from('performance_metrics')
      .upsert({
        period: 'all_time',
        period_start: new Date('2026-01-01').toISOString(),
        period_end: new Date().toISOString(),
        total_signals: totalSignals,
        resolved_signals: totalSignals,
        winning_signals: winningSignals,
        losing_signals: losingSignals,
        win_rate: winRate.toFixed(4),
        total_pnl: totalPnl.toFixed(2),
        total_roi: avgRoi.toFixed(4),
        avg_edge: avgEdge.toFixed(4),
        avg_confidence: avgConfidence.toFixed(4),
        sharpe_ratio: sharpeRatio.toFixed(4),
        profit_factor: profitFactor.toFixed(4),
        avg_win: avgWin.toFixed(2),
        avg_loss: avgLoss.toFixed(2),
        max_win: maxWin.toFixed(2),
        max_loss: maxLoss.toFixed(2),
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'period,period_start'
      });
    
    if (upsertError) throw upsertError;
    
    console.log('[RESOLUTION] ✅ Updated performance metrics:');
    console.log(`  Win Rate: ${(winRate * 100).toFixed(1)}% (${winningSignals}/${totalSignals})`);
    console.log(`  Total P&L: $${totalPnl.toFixed(2)}`);
    console.log(`  Sharpe Ratio: ${sharpeRatio.toFixed(2)}`);
    console.log(`  Profit Factor: ${profitFactor.toFixed(2)}`);
    
  } catch (error) {
    console.error('[RESOLUTION] Failed to update performance metrics:', error.message);
  }
}

/**
 * Get upcoming resolutions (markets resolving soon)
 */
async function getUpcomingResolutions(daysAhead = 7) {
  const db = initDb();
  
  try {
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + daysAhead);
    
    const { data: signals, error } = await db
      .from('trade_signals')
      .select('*')
      .in('status', ['PENDING', 'EXECUTED'])
      .lte('resolution_date', endDate.toISOString())
      .order('resolution_date', { ascending: true });
    
    if (error) throw error;
    
    return signals;
  } catch (error) {
    console.error('[RESOLUTION] Failed to get upcoming resolutions:', error.message);
    return [];
  }
}

/**
 * Manual resolution for markets that don't auto-resolve
 */
async function manualResolve(marketId, outcome, actualResult) {
  const db = initDb();
  
  try {
    const { data: signal, error } = await db
      .from('trade_signals')
      .select('*')
      .eq('market_id', marketId)
      .single();
    
    if (error) throw error;
    
    await updateSignalOutcome(signal, {
      resolved: true,
      outcome: actualResult,
      resolvedAt: new Date().toISOString()
    });
    
    await updatePerformanceMetrics();
    
    console.log(`[RESOLUTION] ✅ Manually resolved ${marketId}: ${outcome}`);
  } catch (error) {
    console.error('[RESOLUTION] Failed to manually resolve:', error.message);
    throw error;
  }
}

module.exports = {
  checkMarketResolution,
  checkPendingResolutions,
  updateSignalOutcome,
  updatePerformanceMetrics,
  getUpcomingResolutions,
  manualResolve
};
