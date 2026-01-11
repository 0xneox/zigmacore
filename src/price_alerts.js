const WebSocket = require('ws');
const axios = require('axios');
const { BoundedMap } = require('./utils/bounded-map');
const { initDb } = require('./db');
// ACP dependency removed - postDeepDiveOnACP no longer available

class PriceAlertManager {
  constructor() {
    this.alerts = new BoundedMap(1000); // userId -> [{marketId, condition, price, type, alertId}]
    this.marketSubscriptions = new BoundedMap(5000); // marketId -> Set of userIds
    this.ws = null;
    this.reconnectInterval = 5000;
    this.isConnected = false;
    this.priceCache = new BoundedMap(10000); // marketId -> currentPrice
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10; // Prevent infinite reconnection
  }

  async initialize() {
    console.log('Initializing WebSocket alerts...');
    await this.loadAlertsFromDatabase(); // Load persisted alerts on startup
    await this.connectToPolymarket();
    this.startReconnectionLoop();
  }

  async loadAlertsFromDatabase() {
    try {
      const db = initDb();
      const rows = db.prepare(`
        SELECT id, userId, marketId, condition, price, alertType, duration, createdAt, active
        FROM alert_subscriptions
        WHERE active = 1
      `).all();

      for (const row of rows) {
        const alert = {
          alertId: row.id,
          marketId: row.marketId,
          condition: row.condition,
          price: row.price,
          type: row.alertType,
          createdAt: row.createdAt,
          duration: row.duration,
          triggered: false
        };

        if (!this.alerts.has(row.userId)) {
          this.alerts.set(row.userId, []);
        }
        this.alerts.get(row.userId).push(alert);

        if (!this.marketSubscriptions.has(row.marketId)) {
          this.marketSubscriptions.set(row.marketId, new Set());
        }
        this.marketSubscriptions.get(row.marketId).add(row.userId);
      }

      console.log(`Loaded ${rows.length} alerts from database`);
    } catch (error) {
      console.error('Error loading alerts from database:', error);
    }
  }

  async saveAlertToDatabase(userId, alert) {
    try {
      const db = initDb();
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO alert_subscriptions
        (id, userId, marketId, condition, price, alertType, duration, createdAt, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        alert.alertId,
        userId,
        alert.marketId,
        alert.condition,
        alert.price,
        alert.type,
        alert.duration,
        alert.createdAt,
        1
      );
    } catch (error) {
      console.error('Error saving alert to database:', error);
    }
  }

  async updateAlertInDatabase(alertId, triggered) {
    try {
      const db = initDb();
      const stmt = db.prepare(`
        UPDATE alert_subscriptions
        SET active = 0
        WHERE id = ?
      `);
      stmt.run(alertId);
    } catch (error) {
      console.error('Error updating alert in database:', error);
    }
  }

  async connectToPolymarket() {
    try {
      // Connect to Polymarket's CLOB WebSocket for real-time data
      this.ws = new WebSocket('wss://clob.polymarket.com/ws');

      this.ws.on('open', () => {
        console.log('Connected to Polymarket WebSocket');
        this.isConnected = true;
        this.reconnectAttempts = 0; // Reset on successful connection
        this.subscribeToActiveMarkets();
      });

      this.ws.on('message', (data) => {
        this.handleWebSocketMessage(data);
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.isConnected = false;
      });

      this.ws.on('close', () => {
        console.log('WebSocket closed');
        this.isConnected = false;
      });

    } catch (error) {
      console.error('Failed to connect to Polymarket WebSocket:', error);
      this.isConnected = false;
    }
  }

  subscribeToActiveMarkets() {
    if (!this.ws || !this.isConnected) return;

    // Subscribe to all active markets for price updates
    const subscriptionMessage = {
      type: 'subscribe',
      channel: 'markets',
      markets: Array.from(this.marketSubscriptions.keys())
    };

    this.ws.send(JSON.stringify(subscriptionMessage));
  }

  startReconnectionLoop() {
    setInterval(() => {
      if (!this.isConnected && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        console.log(`Attempting to reconnect to Polymarket WebSocket... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        this.connectToPolymarket();
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.warn('Maximum WebSocket reconnection attempts reached. Giving up until next restart.');
      }
    }, this.reconnectInterval);
  }

  handleWebSocketMessage(data) {
    try {
      const message = JSON.parse(data.toString());

      // Validate message format
      if (!message || typeof message !== 'object') {
        console.warn('Invalid WebSocket message: not an object');
        return;
      }

      if (message.type === 'price_update') {
        // Validate price_update message structure
        if (!message.market || typeof message.market !== 'object') {
          console.warn('Invalid price_update: missing or invalid market object');
          return;
        }

        if (!message.market.id || typeof message.market.id !== 'string') {
          console.warn('Invalid price_update: missing or invalid market.id');
          return;
        }

        if (typeof message.market.price !== 'number' || !Number.isFinite(message.market.price)) {
          console.warn('Invalid price_update: missing or invalid market.price');
          return;
        }

        if (message.market.price < 0 || message.market.price > 1) {
          console.warn('Invalid price_update: price out of valid range [0, 1]');
          return;
        }

        const marketId = message.market.id;
        const newPrice = message.market.price;

        // Update price cache
        this.priceCache.set(marketId, newPrice);

        // Check alerts for this market
        this.checkAlertsForMarket(marketId, newPrice);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  async subscribePriceAlert(userId, marketId, condition, price, alertType = 'above', duration = 'daily') {
    try {
      // Generate unique alert ID
      const alertId = `${userId}_${marketId}_${Date.now()}`;

      // Create alert object
      const alert = {
        alertId,
        marketId,
        condition,
        price: parseFloat(price),
        type: alertType,
        createdAt: Date.now(),
        duration,
        triggered: false
      };

      // Add to user's alerts
      if (!this.alerts.has(userId)) {
        this.alerts.set(userId, []);
      }
      this.alerts.get(userId).push(alert);

      // Add user to market subscription
      if (!this.marketSubscriptions.has(marketId)) {
        this.marketSubscriptions.set(marketId, new Set());
      }
      this.marketSubscriptions.get(marketId).add(userId);

      // Save to database for persistence
      await this.saveAlertToDatabase(userId, alert);

      // Update WebSocket subscriptions
      this.subscribeToActiveMarkets();

      console.log(`Price alert created for user ${userId}: ${condition} ${marketId} at ${price}`);
      return { success: true, alertId, message: 'Price alert subscription created successfully' };
    } catch (error) {
      console.error('Error creating price alert:', error);
      return { success: false, error: error.message };
    }
  }

  async checkAlertsForMarket(marketId, currentPrice) {
    const subscribedUsers = this.marketSubscriptions.get(marketId);
    if (!subscribedUsers) return;

    for (const userId of subscribedUsers) {
      const userAlerts = this.alerts.get(userId);
      if (!userAlerts) continue;

      for (const alert of userAlerts) {
        if (alert.marketId !== marketId || alert.triggered) continue;

        let shouldTrigger = false;

        if (alert.type === 'above' && currentPrice >= alert.price) {
          shouldTrigger = true;
        } else if (alert.type === 'below' && currentPrice <= alert.price) {
          shouldTrigger = true;
        } else if (alert.type === 'change' && Math.abs(currentPrice - alert.price) >= alert.condition) {
          shouldTrigger = true;
        }

        if (shouldTrigger) {
          await this.triggerAlert(userId, alert, currentPrice);
        }
      }
    }
  }

  async triggerAlert(userId, alert, currentPrice) {
    try {
      alert.triggered = true;
      alert.triggeredAt = Date.now();
      alert.triggerPrice = currentPrice;

      const alertPayload = {
        type: 'price_alert_triggered',
        userId,
        alertId: alert.alertId,
        marketId: alert.marketId,
        condition: alert.condition,
        targetPrice: alert.price,
        currentPrice,
        alertType: alert.type,
        timestamp: Date.now(),
        message: `🚨 Price Alert: ${alert.marketId} ${alert.condition} ${alert.price} - Current: ${currentPrice}`
      };

      // Send notification (ACP removed - mock success)
      const result = { success: true, txId: 'mock-alert-' + Date.now() };
      console.log(`Mock alert sent for user ${userId}: ${alert.marketId} at ${currentPrice} (ACP removed)`);

      // Mark alert as inactive in database
      await this.updateAlertInDatabase(alert.alertId, true);

      // Optionally remove one-time alerts
      if (alert.duration === 'once') {
        this.removeAlert(userId, alert.alertId);
      }

      return result;

    } catch (error) {
      console.error('Error triggering alert:', error);
    }
  }

  removeAlert(userId, alertId) {
    const userAlerts = this.alerts.get(userId);
    if (userAlerts) {
      const index = userAlerts.findIndex(alert => alert.alertId === alertId);
      if (index !== -1) {
        userAlerts.splice(index, 1);
        console.log(`Removed alert ${alertId} for user ${userId}`);
      }
    }
  }

  getUserAlerts(userId) {
    return this.alerts.get(userId) || [];
  }

  getActiveSubscriptions() {
    const result = {};
    for (const [marketId, users] of this.marketSubscriptions) {
      result[marketId] = Array.from(users);
    }
    return result;
  }

  getConnectionStatus() {
    return {
      connected: this.isConnected,
      websocketDisabled: false,
      marketsSubscribed: this.marketSubscriptions.size,
      totalAlerts: Array.from(this.alerts.values()).reduce((sum, alerts) => sum + alerts.length, 0),
      priceCacheSize: this.priceCache.size,
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

// Singleton instance
let alertManagerInstance = null;

function getPriceAlertManager() {
  if (!alertManagerInstance) {
    alertManagerInstance = new PriceAlertManager();
  }
  return alertManagerInstance;
}

module.exports = { PriceAlertManager, getPriceAlertManager };
