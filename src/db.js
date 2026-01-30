// Supabase database for persistent storage
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

let supabase = null;
let dbAvailable = true;
let inMemoryCache = {};

// Initialize Supabase client with graceful degradation
function initDb() {
  if (supabase) return supabase;
  
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      console.warn('[DB] Missing Supabase configuration. Running in degraded mode with in-memory storage.');
      dbAvailable = false;
      return createMockClient();
    }
    
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('[DB] Supabase client initialized successfully');
    dbAvailable = true;
    return supabase;
  } catch (error) {
    console.warn('[DB] Failed to initialize Supabase client:', error.message);
    console.warn('[DB] Running in degraded mode with in-memory storage.');
    dbAvailable = false;
    return createMockClient();
  }
}

// Create mock client for degraded mode
function createMockClient() {
  return {
    from: (table) => ({
      select: (columns) => ({
        eq: (field, value) => mockQuery(table, columns, field, value),
        order: (field, options) => mockQuery(table, columns),
        limit: (n) => mockQuery(table, columns),
        single: () => mockQuery(table, columns).then(data => data[0] || null)
      }),
      upsert: (data) => mockUpsert(table, data),
      insert: (data) => mockUpsert(table, data),
      update: (data) => ({
        eq: (field, value) => mockUpdate(table, data, field, value)
      }),
      delete: () => mockDelete(table)
    })
  };
}

// Mock query function for in-memory storage
async function mockQuery(table, columns, field, value) {
  if (!inMemoryCache[table]) {
    return { data: [], error: null };
  }
  
  let data = inMemoryCache[table];
  
  if (field && value !== undefined) {
    data = data.filter(item => item[field] === value);
  }
  
  return { data, error: null };
}

// Mock upsert function
async function mockUpsert(table, data) {
  if (!inMemoryCache[table]) {
    inMemoryCache[table] = [];
  }
  
  if (Array.isArray(data)) {
    data.forEach(item => {
      const index = inMemoryCache[table].findIndex(i => i.id === item.id);
      if (index >= 0) {
        inMemoryCache[table][index] = { ...inMemoryCache[table][index], ...item };
      } else {
        inMemoryCache[table].push(item);
      }
    });
  } else {
    const index = inMemoryCache[table].findIndex(i => i.id === data.id);
    if (index >= 0) {
      inMemoryCache[table][index] = { ...inMemoryCache[table][index], ...data };
    } else {
      inMemoryCache[table].push(data);
    }
  }
  
  return { data, error: null };
}

// Mock update function
async function mockUpdate(table, data, field, value) {
  if (!inMemoryCache[table]) {
    return { error: { message: 'Table not found' } };
  }
  
  inMemoryCache[table] = inMemoryCache[table].map(item => 
    item[field] === value ? { ...item, ...data } : item
  );
  
  return { error: null };
}

// Mock delete function
async function mockDelete(table) {
  if (inMemoryCache[table]) {
    inMemoryCache[table] = [];
  }
  return { error: null };
}

// Check database health
async function checkDbHealth() {
  try {
    if (!dbAvailable || !supabase) {
      return {
        status: 'degraded',
        message: 'Database unavailable - running in in-memory mode',
        available: false
      };
    }
    
    // Test database connection
    const { error } = await supabase.from('users').select('count').single();
    
    if (error) {
      console.warn('[DB] Health check failed:', error.message);
      return {
        status: 'degraded',
        message: 'Database connection failed - running in in-memory mode',
        available: false
      };
    }
    
    return {
      status: 'healthy',
      message: 'Database connection successful',
      available: true
    };
  } catch (error) {
    console.warn('[DB] Health check error:', error.message);
    return {
      status: 'degraded',
      message: 'Database error - running in in-memory mode',
      available: false
    };
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
      console.error('[DB] Failed to save price cache:', error.message);
      if (!dbAvailable) {
        console.warn('[DB] Running in degraded mode - price cache not persisted');
      }
      return;
    }
    
    console.log(`[DB] Saved ${validEntries.length} price cache entries`);
  } catch (error) {
    console.error('[DB] Failed to save price cache:', error);
    if (!dbAvailable) {
      console.warn('[DB] Running in degraded mode - price cache not persisted');
    }
  }
}

async function loadPriceCache() {
  const db = initDb();
  const { data, error } = await db
    .from('price_cache')
    .select('id, price, created_at');
  
  if (error) {
    console.error('[DB] Failed to load price cache:', error.message);
    if (!dbAvailable) {
      console.warn('[DB] Running in degraded mode - returning empty cache');
    }
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
  try {
    const db = initDb();
    // Use synchronous approach for Supabase
    db
      .from('volume_snapshots')
      .insert({ market_id: marketId, volume, timestamp })
      .then(() => {
        // Success - no logging to reduce noise
      })
      .catch((err) => {
        // Silently fail - Supabase timeouts are non-critical
        // Only log if it's not a timeout/connection error
        if (err.code !== 'ECONNABORTED' && !err.message?.includes('timed out') && !err.message?.includes('522')) {
          console.error('[DB] Volume snapshot error:', err.code || err.message);
        }
      });
  } catch (err) {
    // Silently catch initialization errors
  }
}

function getVolumeSnapshots(marketId, sinceTimestamp) {
  // For now, return empty array to prevent crashes
  // TODO: Implement proper caching or make this fully async
  // Removed verbose logging - this gets called for every market in computeMetrics
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
  saveTradeSignal,
  getTradeSignals,
  saveClobPriceCache,
  getClobPriceCache,
  saveAnalysisCacheV2,
  getAnalysisCacheV2,
  checkDbHealth,
  dbAvailable: () => dbAvailable
};
