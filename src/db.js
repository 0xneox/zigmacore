// Supabase database for persistent storage
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

let supabase = null;

// Initialize Supabase client
function initDb() {
  if (supabase) return supabase;
  
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase configuration. Please check SUPABASE_URL and SUPABASE_ANON_KEY in .env file.');
    }
    
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('Supabase client initialized successfully');
    return supabase;
  } catch (error) {
    console.error('Failed to initialize Supabase client:', error.message);
    throw error;
  }
}


// Price cache operations with transaction support
async function savePriceCache(cache) {
  const db = initDb();
  
  try {
    const entries = Object.entries(cache).map(([id, data]) => ({
      id,
      price: data.price,
      created_at: data.timestamp
    }));
    
    // Validate data before insert
    const validEntries = entries.filter(entry => {
      if (typeof entry.price !== 'number' || entry.price < 0 || entry.price > 1) {
        console.warn(`Invalid price for ${entry.id}: ${entry.price}, skipping`);
        return false;
      }
      return true;
    });
    
    const { data, error } = await db
      .from('price_cache')
      .upsert(validEntries)
      .select();
    
    if (error) {
      console.error('Failed to save price cache:', error.message);
      throw error;
    }
    
    console.log(`Saved ${validEntries.length} price cache entries`);
  } catch (error) {
    console.error('Failed to save price cache:', error);
    throw error;
  }
}

async function loadPriceCache() {
  const db = initDb();
  const { data, error } = await db
    .from('price_cache')
    .select('id, price, created_at');
  
  if (error) {
    console.error('Failed to load price cache:', error.message);
    return {};
  }
  
  const cache = {};
  for (const row of data) {
    cache[row.id] = { price: row.price, timestamp: row.created_at };
  }
  
  return cache;
}

// Alert subscription operations
async function saveAlertSubscription(alert) {
  const db = initDb();
  const { data, error } = await db
    .from('alert_subscriptions')
    .upsert({
      id: alert.alertId,
      userId: alert.userId,
      marketId: alert.marketId,
      condition: alert.condition,
      price: alert.price,
      alertType: alert.type,
      duration: alert.duration,
      createdAt: alert.createdAt,
      active: 1
    })
    .select();
  
  if (error) {
    console.error('Failed to save alert subscription:', error.message);
    throw error;
  }
  
  return data;
}

async function getUserAlertSubscriptions(userId) {
  const db = initDb();
  const { data, error } = await db
    .from('alert_subscriptions')
    .select('*')
    .eq('userId', userId)
    .eq('active', 1);
  
  if (error) {
    console.error('Failed to get user alert subscriptions:', error.message);
    return [];
  }
  
  return data || [];
}

async function deactivateAlertSubscription(alertId) {
  const db = initDb();
  const { error } = await db
    .from('alert_subscriptions')
    .update({ active: 0 })
    .eq('id', alertId);
  
  if (error) {
    console.error('Failed to deactivate alert subscription:', error.message);
    throw error;
  }
}

async function getDbStats() {
  const db = initDb();
  try {
    const [priceCount, alertsCount, analysisCount, signalsCount] = await Promise.all([
      db.from('price_cache').select('*', { count: 'exact', head: true }),
      db.from('alert_subscriptions').select('*', { count: 'exact', head: true }).eq('active', 1),
      db.from('analysis_cache').select('*', { count: 'exact', head: true }),
      db.from('trade_signals').select('*', { count: 'exact', head: true })
    ]);
    
    return {
      priceCacheEntries: priceCount.count || 0,  // Use .count not .length
      activeAlerts: alertsCount.count || 0,
      analysisCacheEntries: analysisCount.count || 0,
      tradeSignalsCount: signalsCount.count || 0
    };
  } catch (error) {
    console.error('Failed to get DB stats:', error.message);
    return {
      priceCacheEntries: 0,
      activeAlerts: 0,
      analysisCacheEntries: 0,
      tradeSignalsCount: 0
    };
  }
}

// Analysis cache operations
async function saveAnalysisCache(marketId, lastPrice, reasoning, confidence) {
  try {
    const db = initDb();
    
    // Ensure confidence is a number, not an object
    let confidenceValue = confidence;
    if (typeof confidence === 'object' && confidence !== null) {
      confidenceValue = confidence.confidence || confidence.value || confidence.score || 0;
    }
    if (typeof confidenceValue !== 'number' || isNaN(confidenceValue)) {
      confidenceValue = 0;
    }
    
    const { data, error } = await db
      .from('analysis_cache')
      .upsert({
        market_id: marketId,
        last_price: lastPrice,
        reasoning: reasoning,
        confidence: confidenceValue,
        timestamp: Date.now()
      }, {
        onConflict: 'market_id',
        ignoreDuplicates: false
      })
      .select();
    
    if (error) {
      console.error('[DB] Failed to save analysis cache:', error.message);
      throw error;
    }
    
    return data;
  } catch (error) {
    console.error('[DB] Failed to save analysis cache:', error.message);
    throw error;
  }
}

async function getAnalysisCache(marketId) {
  try {
    const db = initDb();
    const { data, error } = await db
      .from('analysis_cache')
      .select('*')
      .eq('market_id', marketId)
      .single();
    
    if (error && error.code !== 'PGRST116') { // PGRST116 is "not found" error
      console.error('[DB] Failed to get analysis cache:', error.message);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('[DB] Failed to get analysis cache:', error.message);
    return null;
  }
}

// Trade signals operations
async function saveTradeSignal(signal) {
  try {
    const db = initDb();
    
    const { data, error } = await db
      .from('trade_signals')
      .insert({
        market_id: signal.marketId,
        action: signal.action,
        price: signal.price,
        confidence: signal.confidence,
        edge: signal.edge,
        category: signal.category,
        status: 'EXECUTABLE', // Distinguish from manual trades
        source: 'ZIGMA_AUTO'
        // created_at will be auto-generated by database
      })
      .select();
    
    if (error) {
      console.error('[DB] Failed to save trade signal:', error.message);
      throw error;
    }
    
    console.log(`[DB] ✅ Saved executable trade signal for ${signal.marketId}`);
    return data;
  } catch (error) {
    console.error('[DB] Failed to save trade signal:', error.message);
    throw error;
  }
}

async function getTradeSignals(limit = 50, category = null, minEdge = 0) {
  try {
    const db = initDb();
    
    let query = db
      .from('trade_signals')
      .select('*')
      .eq('status', 'EXECUTABLE') // Only show auto-generated executable trades
      .order('timestamp', { ascending: false });
    
    // Filter by category if specified
    if (category && category !== 'All Categories') {
      query = query.eq('category', category);
    }
    
    // Filter by minimum edge if specified
    if (minEdge > 0) {
      query = query.gte('edge', minEdge / 100); // Convert percentage to decimal
    }
    
    const { data, error } = await query.limit(limit);
    
    if (error) {
      console.error('[DB] Failed to get trade signals:', error.message);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.error('[DB] Failed to get trade signals:', error.message);
    return [];
  }
}

// Volume snapshots operations
function saveVolumeSnapshot(marketId, volume, timestamp) {
  const db = initDb();
  // Use synchronous approach for Supabase
  db
    .from('volume_snapshots')
    .upsert({
      market_id: marketId,
      volume: volume,
      created_at: timestamp
    })
    .then(({ data, error }) => {
      if (error) {
        console.error('Failed to save volume snapshot:', error.message);
      } else {
        console.log(`Volume snapshot saved for ${marketId}`);
      }
    })
    .catch(err => {
      console.error('Volume snapshot save error:', err);
    });
}

function getVolumeSnapshots(marketId, sinceTimestamp) {
  // For now, return empty array to prevent crashes
  // TODO: Implement proper caching or make this fully async
  console.log(`[DB] Getting volume snapshots for ${marketId} since ${sinceTimestamp}`);
  return [];
}

function getUserPerformanceHistory(userId, days = 30) {
  // Return empty array for now - Supabase async would require major refactoring
  return [];
}

function saveUserPerformanceSnapshot(userId, metrics, healthScore = null) {
  // Skip for now - Supabase async would require major refactoring
  console.log(`[DB] Skipped saving user performance snapshot for ${userId} (Supabase migration)`);
}

function getUserPerformanceTrend(userId, days = 7) {
  // Return null for now - Supabase async would require major refactoring
  return null;
}

// Conversation cache operations
function saveConversationCache(id, userId, contextData, ttlMs = 3600000) {
  // Skip for now - Supabase async would require major refactoring
  console.log(`[DB] Skipped saving conversation cache for ${id} (Supabase migration)`);
}

function getConversationCache(id) {
  // Return null for now - Supabase async would require major refactoring
  return null;
}

function pruneExpiredConversationCache() {
  // Skip for now - Supabase async would require major refactoring
  console.log('[DB] Skipped conversation cache cleanup (Supabase migration)');
}

function saveClobPriceCache(marketId, priceData) {
  // Skip for now - Supabase async would require major refactoring
  console.log(`[DB] Skipped saving CLOB price cache for ${marketId} (Supabase migration)`);
}

function getClobPriceCache(marketId, maxAgeMs = 30000) {
  // Return null for now - Supabase async would require major refactoring
  return null;
}

function saveAnalysisCacheV2(marketId, analysis) {
  // Skip for now - Supabase async would require major refactoring
  console.log(`[DB] Skipped saving analysis cache V2 for ${marketId} (Supabase migration)`);
}

function getAnalysisCacheV2(marketId, maxAgeMs = 3600000) {
  // Return null for now - Supabase async would require major refactoring
  return null;
}

// Close database connection
function closeDb() {
  if (supabase) {
    supabase = null;
    console.log('Supabase client connection closed');
  }
}

module.exports = {
  initDb,
  savePriceCache,
  loadPriceCache,
  saveAlertSubscription,
  getUserAlertSubscriptions,
  deactivateAlertSubscription,
  getDbStats,
  closeDb,
  saveAnalysisCache,
  getAnalysisCache,
  saveTradeSignal,
  getTradeSignals,
  saveVolumeSnapshot,
  getVolumeSnapshots,
  saveUserPerformanceSnapshot,
  getUserPerformanceHistory,
  getUserPerformanceTrend,
  saveConversationCache,
  getConversationCache,
  pruneExpiredConversationCache,
  saveClobPriceCache,
  getClobPriceCache,
  saveAnalysisCacheV2,
  getAnalysisCacheV2
};
