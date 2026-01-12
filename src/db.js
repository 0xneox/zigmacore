// SQLite database for persistent storage
const Database = require('better-sqlite3');
const path = require('path');

let db = null;

// Initialize database connection with retry logic
function initDb(maxRetries = 3) {
  if (db) return db;

  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const dbPath = path.join(__dirname, '..', 'data', 'cache.sqlite');
      const fs = require('fs');
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');

      // Create tables
      db.exec(`
      CREATE TABLE IF NOT EXISTS price_cache (
        id TEXT PRIMARY KEY,
        price REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alert_subscriptions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        marketId TEXT NOT NULL,
        condition TEXT NOT NULL,
        price REAL NOT NULL,
        alertType TEXT NOT NULL,
        duration TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        active INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS analysis_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_id TEXT UNIQUE,
        last_price REAL,
        reasoning TEXT,
        confidence REAL,
        timestamp INTEGER
      );

      CREATE TABLE IF NOT EXISTS volume_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_id TEXT,
        volume REAL,
        timestamp INTEGER
      );

      CREATE TABLE IF NOT EXISTS trade_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_id TEXT,
        action TEXT,
        price REAL,
        confidence REAL,
        raw_confidence REAL,
        kelly_fraction REAL,
        edge REAL,
        category TEXT,
        outcome TEXT,
        predicted_probability REAL,
        entropy REAL,
        sentiment_score REAL,
        valid INTEGER DEFAULT 1,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_performance_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        snapshot_date TEXT NOT NULL,
        total_positions INTEGER,
        total_trades INTEGER,
        realized_pnl REAL,
        unrealized_pnl REAL,
        total_volume REAL,
        win_rate REAL,
        avg_position_size REAL,
        portfolio_health_score REAL,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, snapshot_date)
      );

      CREATE TABLE IF NOT EXISTS conversation_cache (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        context_data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS clob_price_cache (
        market_id TEXT PRIMARY KEY,
        mid_price REAL,
        bid_price REAL,
        ask_price REAL,
        bids_json TEXT,
        asks_json TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS analysis_cache_v2 (
        market_id TEXT PRIMARY KEY,
        analysis_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signal_validations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT NOT NULL,
        valid INTEGER NOT NULL,
        status TEXT NOT NULL,
        validations_json TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        signal_age INTEGER
      );

      CREATE TABLE IF NOT EXISTS calibration_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT,
        overall_calibration_error REAL NOT NULL,
        bins_json TEXT NOT NULL,
        sample_size INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learning_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        action_type TEXT NOT NULL,
        actual_accuracy REAL NOT NULL,
        predicted_accuracy REAL NOT NULL,
        learning_factor REAL NOT NULL,
        sample_size INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);

    // Run migrations to add new columns to existing tables
    runMigrations();

    console.log('Database initialized successfully');
    return db;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        console.error(`DB connection attempt ${attempt + 1} failed, retrying...`);
      }
    }
  }

  console.error('Failed to initialize database after retries:', lastError);
  throw lastError;
}

// Migration function to add new columns to existing tables
function runMigrations() {
  try {
    // Check and add columns to trade_signals table
    const tableInfo = db.pragma("table_info(trade_signals)");
    const existingColumns = tableInfo.map(col => col.name);
    
    const newColumns = [
      { name: 'raw_confidence', type: 'REAL', default: 'NULL' },
      { name: 'edge', type: 'REAL', default: 'NULL' },
      { name: 'category', type: 'TEXT', default: 'NULL' },
      { name: 'outcome', type: 'TEXT', default: 'NULL' },
      { name: 'predicted_probability', type: 'REAL', default: 'NULL' },
      { name: 'entropy', type: 'REAL', default: 'NULL' },
      { name: 'sentiment_score', type: 'REAL', default: 'NULL' },
      { name: 'valid', type: 'INTEGER', default: '1' }
    ];

    for (const col of newColumns) {
      if (!existingColumns.includes(col.name)) {
        db.exec(`ALTER TABLE trade_signals ADD COLUMN ${col.name} ${col.type} DEFAULT ${col.default}`);
        console.log(`✅ Added column '${col.name}' to trade_signals table`);
      }
    }

    // Create new tables if they don't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS signal_validations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL,
        market_id TEXT NOT NULL,
        is_valid INTEGER DEFAULT 1,
        invalidation_reason TEXT,
        price_at_validation REAL,
        volume_at_validation REAL,
        liquidity_at_validation REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (signal_id) REFERENCES trade_signals(id)
      );

      CREATE TABLE IF NOT EXISTS calibration_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        confidence_bin TEXT NOT NULL,
        category TEXT,
        predicted_confidence REAL NOT NULL,
        actual_accuracy REAL NOT NULL,
        sample_size INTEGER NOT NULL,
        adjustment REAL NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS learning_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        original_edge REAL NOT NULL,
        adjusted_edge REAL NOT NULL,
        original_confidence REAL NOT NULL,
        adjusted_confidence REAL NOT NULL,
        outcome TEXT,
        was_correct INTEGER,
        learning_factor REAL NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (signal_id) REFERENCES trade_signals(id)
      );
    `);

    console.log('✅ Database migrations completed');

  } catch (error) {
    console.error('Migration error:', error.message);
    // Continue anyway - columns might already exist
  }
}

// Price cache operations with transaction support
function savePriceCache(cache) {
  const db = initDb();
  
  try {
    const insert = db.prepare('INSERT OR REPLACE INTO price_cache (id, price, timestamp) VALUES (?, ?, ?)');
    
    const insertMany = db.transaction((entries) => {
      for (const [id, data] of Object.entries(entries)) {
        // Validate data before insert
        if (typeof data.price !== 'number' || data.price < 0 || data.price > 1) {
          console.warn(`Invalid price for ${id}: ${data.price}, skipping`);
          continue;
        }
        insert.run(id, data.price, data.timestamp);
      }
    });
    
    insertMany(cache);
    console.log(`Saved ${Object.keys(cache).length} price cache entries`);
  } catch (error) {
    console.error('Failed to save price cache:', error);
    throw error;
  }
}

function loadPriceCache() {
  const db = initDb();
  const rows = db.prepare('SELECT id, price, timestamp FROM price_cache').all();
  const cache = {};

  for (const row of rows) {
    cache[row.id] = { price: row.price, timestamp: row.timestamp };
  }

  return cache;
}

// Alert subscription operations
function saveAlertSubscription(alert) {
  const db = initDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO alert_subscriptions
    (id, userId, marketId, condition, price, alertType, duration, createdAt, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    alert.alertId,
    alert.userId,
    alert.marketId,
    alert.condition,
    alert.price,
    alert.type,
    alert.duration,
    alert.createdAt,
    1
  );
}

function getUserAlertSubscriptions(userId) {
  const db = initDb();
  return db.prepare('SELECT * FROM alert_subscriptions WHERE userId = ? AND active = 1').all(userId);
}

function deactivateAlertSubscription(alertId) {
  const db = initDb();
  db.prepare('UPDATE alert_subscriptions SET active = 0 WHERE id = ?').run(alertId);
}

// Database health check
function getDbStats() {
  const db = initDb();
  const stats = {
    priceCacheEntries: db.prepare('SELECT COUNT(*) as count FROM price_cache').get().count,
    activeAlerts: db.prepare('SELECT COUNT(*) as count FROM alert_subscriptions WHERE active = 1').get().count,
    analysisCacheEntries: db.prepare('SELECT COUNT(*) as count FROM analysis_cache').get().count,
    tradeSignalsCount: db.prepare('SELECT COUNT(*) as count FROM trade_signals').get().count
  };
  return stats;
}

// Analysis cache operations
function saveAnalysisCache(marketId, lastPrice, reasoning, confidence) {
  const db = initDb();
  const insert = db.prepare('INSERT OR REPLACE INTO analysis_cache (market_id, last_price, reasoning, confidence) VALUES (?, ?, ?, ?)');
  insert.run(marketId, lastPrice, reasoning, confidence);
}

function getAnalysisCache(marketId) {
  const db = initDb();
  return db.prepare('SELECT * FROM analysis_cache WHERE market_id = ?').get(marketId);
}

// Trade signals operations
function saveTradeSignal(signal) {
  const db = initDb();
  const insert = db.prepare('INSERT INTO trade_signals (market_id, action, price, confidence, kelly_fraction) VALUES (?, ?, ?, ?, ?)');
  insert.run(signal.marketId, signal.action, signal.price, signal.confidence, signal.kellyFraction);
}

function getTradeSignals(limit = 50) {
  const db = initDb();
  return db.prepare('SELECT * FROM trade_signals ORDER BY timestamp DESC LIMIT ?').all(limit);
}

// Volume snapshots operations
function saveVolumeSnapshot(marketId, volume, timestamp) {
  const db = initDb();
  const insert = db.prepare('INSERT INTO volume_snapshots (market_id, volume, timestamp) VALUES (?, ?, ?)');
  insert.run(marketId, volume, timestamp);
}

function getVolumeSnapshots(marketId, sinceTimestamp) {
  const db = initDb();
  const select = db.prepare('SELECT volume, timestamp FROM volume_snapshots WHERE market_id = ? AND timestamp > ? ORDER BY timestamp ASC');
  return select.all(marketId, sinceTimestamp);
}

// User performance snapshot operations
function saveUserPerformanceSnapshot(userId, metrics, healthScore = null) {
  const db = initDb();
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const insert = db.prepare(`
    INSERT OR REPLACE INTO user_performance_snapshots
    (user_id, snapshot_date, total_positions, total_trades, realized_pnl, unrealized_pnl,
     total_volume, win_rate, avg_position_size, portfolio_health_score, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    userId,
    today,
    metrics.totalPositions || 0,
    metrics.totalTrades || 0,
    metrics.realizedPnl || 0,
    metrics.unrealizedPnl || 0,
    metrics.totalVolume || 0,
    metrics.winRate || 0,
    metrics.averagePositionSize || 0,
    healthScore,
    Date.now()
  );
}

function getUserPerformanceHistory(userId, days = 30) {
  const db = initDb();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffIso = cutoffDate.toISOString().split('T')[0];

  const select = db.prepare(`
    SELECT * FROM user_performance_snapshots
    WHERE user_id = ? AND snapshot_date >= ?
    ORDER BY snapshot_date ASC
  `);

  return select.all(userId, cutoffIso);
}

function getUserPerformanceTrend(userId, days = 7) {
  const history = getUserPerformanceHistory(userId, days);
  if (history.length < 2) return null;

  const first = history[0];
  const last = history[history.length - 1];

  return {
    periodDays: days,
    snapshots: history.length,
    realizedPnlChange: (last.realized_pnl || 0) - (first.realized_pnl || 0),
    unrealizedPnlChange: (last.unrealized_pnl || 0) - (first.unrealized_pnl || 0),
    winRateChange: (last.win_rate || 0) - (first.win_rate || 0),
    healthScoreChange: (last.portfolio_health_score || 0) - (first.portfolio_health_score || 0),
    totalTradesAdded: (last.total_trades || 0) - (first.total_trades || 0)
  };
}

// Persistent cache operations
function saveConversationCache(id, userId, contextData, ttlMs = 30 * 60 * 1000) {
  const db = initDb();
  const now = Date.now();
  const expiresAt = now + ttlMs;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO conversation_cache (id, user_id, context_data, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  insert.run(id, userId, JSON.stringify(contextData), now, expiresAt);
}

function getConversationCache(id) {
  const db = initDb();
  const now = Date.now();

  const select = db.prepare(`
    SELECT context_data, expires_at FROM conversation_cache
    WHERE id = ? AND expires_at > ?
  `);

  const row = select.get(id, now);
  if (!row) return null;

  try {
    return JSON.parse(row.context_data);
  } catch (e) {
    console.error('Failed to parse conversation cache:', e.message);
    return null;
  }
}

function pruneExpiredConversationCache() {
  const db = initDb();
  const now = Date.now();

  const del = db.prepare('DELETE FROM conversation_cache WHERE expires_at < ?');
  const result = del.run(now);

  if (result.changes > 0) {
    console.log(`Pruned ${result.changes} expired conversation cache entries`);
  }
}

function saveClobPriceCache(marketId, priceData) {
  const db = initDb();
  const now = Date.now();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO clob_price_cache
    (market_id, mid_price, bid_price, ask_price, bids_json, asks_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    marketId,
    priceData.mid || null,
    priceData.bid || null,
    priceData.ask || null,
    JSON.stringify(priceData.bids || []),
    JSON.stringify(priceData.asks || []),
    now
  );
}

function getClobPriceCache(marketId, maxAgeMs = 10000) {
  const db = initDb();
  const now = Date.now();
  const cutoff = now - maxAgeMs;

  const select = db.prepare(`
    SELECT mid_price, bid_price, ask_price, bids_json, asks_json, updated_at
    FROM clob_price_cache
    WHERE market_id = ? AND updated_at > ?
  `);

  const row = select.get(marketId, cutoff);
  if (!row) return null;

  return {
    mid: row.mid_price,
    bid: row.bid_price,
    ask: row.ask_price,
    bids: JSON.parse(row.bids_json || '[]'),
    asks: JSON.parse(row.asks_json || '[]'),
    ts: row.updated_at
  };
}

function saveAnalysisCacheV2(marketId, analysis) {
  const db = initDb();
  const now = Date.now();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO analysis_cache_v2 (market_id, analysis_json, updated_at)
    VALUES (?, ?, ?)
  `);

  insert.run(marketId, JSON.stringify(analysis), now);
}

function getAnalysisCacheV2(marketId, maxAgeMs = 60000) {
  const db = initDb();
  const now = Date.now();
  const cutoff = now - maxAgeMs;

  const select = db.prepare(`
    SELECT analysis_json FROM analysis_cache_v2
    WHERE market_id = ? AND updated_at > ?
  `);

  const row = select.get(marketId, cutoff);
  if (!row) return null;

  try {
    return JSON.parse(row.analysis_json);
  } catch (e) {
    console.error('Failed to parse analysis cache:', e.message);
    return null;
  }
}

// Close database connection (for graceful shutdown)
function closeDb() {
  if (db) {
    db.close();
    db = null;
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
