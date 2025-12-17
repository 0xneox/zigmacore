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

      CREATE TABLE IF NOT EXISTS acp_receipts (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        marketId TEXT,
        type TEXT NOT NULL,
        price REAL NOT NULL,
        token TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        txId TEXT,
        status TEXT DEFAULT 'completed'
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

// ACP receipt operations
function saveAcpReceipt(receipt) {
  const db = initDb();
  const insert = db.prepare(`
    INSERT INTO acp_receipts
    (id, userId, marketId, type, price, token, timestamp, txId, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    receipt.id || `receipt_${Date.now()}`,
    receipt.userId,
    receipt.marketId,
    receipt.type,
    receipt.price,
    receipt.token || 'VIRTUAL',
    receipt.timestamp || Date.now(),
    receipt.txId,
    receipt.status || 'completed'
  );
}

function getUserAcpHistory(userId, limit = 50) {
  const db = initDb();
  return db.prepare('SELECT * FROM acp_receipts WHERE userId = ? ORDER BY timestamp DESC LIMIT ?')
    .all(userId, limit);
}

// Database health check
function getDbStats() {
  const db = initDb();
  const stats = {
    priceCacheEntries: db.prepare('SELECT COUNT(*) as count FROM price_cache').get().count,
    activeAlerts: db.prepare('SELECT COUNT(*) as count FROM alert_subscriptions WHERE active = 1').get().count,
    totalAcpTransactions: db.prepare('SELECT COUNT(*) as count FROM acp_receipts').get().count
  };
  return stats;
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
  saveAcpReceipt,
  getUserAcpHistory,
  getDbStats,
  closeDb
};
