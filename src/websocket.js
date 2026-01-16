/**
 * WebSocket Server for Real-time Price Updates
 * Provides live market data streaming to connected clients
 */

const WebSocket = require('ws');
const { EventEmitter } = require('events');

class PriceWebSocketServer extends EventEmitter {
  constructor(server, options = {}) {
    super();
    this.wss = new WebSocket.Server({ server, path: '/ws/prices' });
    this.clients = new Set();
    this.subscriptions = new Map(); // client -> Set of market IDs
    this.priceCache = new Map(); // marketId -> price data
    this.broadcastInterval = options.broadcastInterval || 5000; // 5 seconds
    this.reconnectInterval = options.reconnectInterval || 30000; // 30 seconds
    
    this.setupServer();
  }

  setupServer() {
    this.wss.on('connection', (ws, req) => {
      const clientId = this.generateClientId();
      this.clients.add(ws);
      this.subscriptions.set(ws, new Set());
      
      console.log(`[WS] Client connected: ${clientId}`);
      
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          this.handleClientMessage(ws, data);
        } catch (error) {
          console.error('[WS] Error parsing message:', error);
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
      });

      ws.on('close', () => {
        console.log(`[WS] Client disconnected: ${clientId}`);
        this.clients.delete(ws);
        this.subscriptions.delete(ws);
      });

      ws.on('error', (error) => {
        console.error(`[WS] Client error: ${clientId}`, error);
      });

      // Send initial connection message
      ws.send(JSON.stringify({
        type: 'connected',
        clientId,
        timestamp: Date.now()
      }));
    });

    // Start periodic price broadcasts
    this.startBroadcast();
  }

  generateClientId() {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  handleClientMessage(ws, data) {
    const subscriptions = this.subscriptions.get(ws);
    
    switch (data.type) {
      case 'subscribe':
        if (data.marketId) {
          subscriptions.add(data.marketId);
          this.sendCurrentPrice(ws, data.marketId);
          console.log(`[WS] Client subscribed to market: ${data.marketId}`);
        }
        break;
      
      case 'unsubscribe':
        if (data.marketId) {
          subscriptions.delete(data.marketId);
          console.log(`[WS] Client unsubscribed from market: ${data.marketId}`);
        }
        break;
      
      case 'subscribe_batch':
        if (Array.isArray(data.marketIds)) {
          data.marketIds.forEach(id => subscriptions.add(id));
          data.marketIds.forEach(id => this.sendCurrentPrice(ws, id));
          console.log(`[WS] Client subscribed to ${data.marketIds.length} markets`);
        }
        break;
      
      case 'get_price':
        if (data.marketId) {
          this.sendCurrentPrice(ws, data.marketId);
        }
        break;
      
      default:
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
    }
  }

  sendCurrentPrice(ws, marketId) {
    const priceData = this.priceCache.get(marketId);
    if (priceData) {
      ws.send(JSON.stringify({
        type: 'price_update',
        marketId,
        ...priceData
      }));
    }
  }

  updatePrice(marketId, priceData) {
    this.priceCache.set(marketId, {
      ...priceData,
      timestamp: Date.now()
    });

    // Broadcast to all subscribed clients
    this.broadcastToSubscribers(marketId, {
      type: 'price_update',
      marketId,
      ...priceData,
      timestamp: Date.now()
    });
  }

  broadcastToSubscribers(marketId, message) {
    this.clients.forEach(client => {
      const subscriptions = this.subscriptions.get(client);
      if (subscriptions && subscriptions.has(marketId) && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }

  startBroadcast() {
    setInterval(() => {
      this.priceCache.forEach((priceData, marketId) => {
        this.broadcastToSubscribers(marketId, {
          type: 'price_update',
          marketId,
          ...priceData,
          timestamp: Date.now()
        });
      });
    }, this.broadcastInterval);
  }

  getConnectedClientsCount() {
    return this.clients.size;
  }

  getSubscriptionCount() {
    let total = 0;
    this.subscriptions.forEach(subs => {
      total += subs.size;
    });
    return total;
  }

  getStats() {
    return {
      connectedClients: this.getConnectedClientsCount(),
      totalSubscriptions: this.getSubscriptionCount(),
      cachedMarkets: this.priceCache.size,
      uptime: process.uptime()
    };
  }
}

module.exports = PriceWebSocketServer;
