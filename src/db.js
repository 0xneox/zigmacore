// SQLite database for persistent storage
const Database = require('better-sqlite3');
const path = require('path');

let db = null;

// Initialize database connection
function initDb() {
  if (db) return db;

  try {
    const dbPath = path.join(__dirname, '..', 'data', 'cache.sqlite');
    // Ensure directory exists
    const fs = require('fs');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(dbPath);

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
        kelly_fraction REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('Database initialized successfully');
    return db;
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}

// Price cache operations
function savePriceCache(cache) {
  const db = initDb();
  const insert = db.prepare('INSERT OR REPLACE INTO price_cache (id, price, timestamp) VALUES (?, ?, ?)');

  const insertMany = db.transaction((entries) => {
    for (const [id, data] of Object.entries(entries)) {
      insert.run(id, data.price, data.timestamp);
    }
  });

  insertMany(cache);
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
  getVolumeSnapshots
};
