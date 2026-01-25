# ZIGMA API Documentation

*Version 2.0 | Last Updated: January 2026*

---

## 🚀 **Overview**

The ZIGMA API provides developers with access to AI-powered prediction market intelligence, real-time signals, and advanced analytics. This RESTful API enables seamless integration of ZIGMA's oracle capabilities into your applications.

### **Base URL**
```
Production: https://api.zigma.ai/v2
Sandbox: https://sandbox-api.zigma.ai/v2
```

### **Authentication**
All API requests require authentication using your ZIGMA API key and valid $ZIGMA token holdings.

```http
Authorization: Bearer YOUR_API_KEY
X-ZIGMA-Wallet: YOUR_WALLET_ADDRESS
Content-Type: application/json
```

---

## 📋 **API Key Management**

### **Getting Started**
1. **Hold $ZIGMA Tokens**: Minimum 1,000 $ZIGMA required
2. **Create API Key**: Via ZIGMA dashboard
3. **Verify Wallet**: Connect your wallet to confirm token holdings
4. **Start Building**: Make authenticated API calls

### **Rate Limits**
| Tier | Requests/Minute | Monthly Calls | $ZIGMA Required |
|------|------------------|---------------|-----------------|
| Basic | 100 | 10,000 | 1,000 |
| Pro | 1,000 | 100,000 | 10,000 |
| Enterprise | 10,000 | 1,000,000 | 100,000 |

---

## 🎯 **Core Endpoints**

### **1. Market Data**

#### **Get All Markets**
```http
GET /markets
```

**Response:**
```json
{
  "markets": [
    {
      "id": "polymarket_12345",
      "platform": "polymarket",
      "question": "Will BTC reach $100k by end of 2026?",
      "current_price": 0.65,
      "liquidity": 500000,
      "volume_24h": 250000,
      "ends_at": "2026-12-31T23:59:59Z",
      "category": "cryptocurrency"
    }
  ],
  "total": 1250,
  "page": 1,
  "per_page": 50
}
```

#### **Get Market Details**
```http
GET /markets/{market_id}
```

**Response:**
```json
{
  "id": "polymarket_12345",
  "platform": "polymarket",
  "question": "Will BTC reach $100k by end of 2026?",
  "description": "This market resolves to YES if Bitcoin...",
  "current_price": 0.65,
  "liquidity": 500000,
  "volume_24h": 250000,
  "order_book": {
    "bids": [{"price": 0.64, "size": 10000}],
    "asks": [{"price": 0.66, "size": 8000}]
  },
  "ends_at": "2026-12-31T23:59:59Z",
  "category": "cryptocurrency",
  "created_at": "2025-01-01T00:00:00Z"
}
```

---

## 🤖 **Signal Endpoints**

### **1. Get Active Signals**
```http
GET /signals
```

**Query Parameters:**
- `platform` (optional): Filter by platform
- `category` (optional): Filter by category
- `min_confidence` (optional): Minimum confidence level (0.1-1.0)
- `min_edge` (optional): Minimum edge requirement (0.01-1.0)

**Response:**
```json
{
  "signals": [
    {
      "id": "signal_abc123",
      "market_id": "polymarket_12345",
      "platform": "polymarket",
      "direction": "YES",
      "probability": 0.72,
      "edge": 0.07,
      "confidence": 0.85,
      "position_size": 0.03,
      "rationale": "Strong bullish sentiment from institutional adoption...",
      "generated_at": "2025-01-25T12:00:00Z",
      "expires_at": "2025-01-25T18:00:00Z"
    }
  ],
  "total": 15,
  "success_rate": 0.68
}
```

### **2. Get Signal History**
```http
GET /signals/history
```

**Query Parameters:**
- `market_id` (optional): Specific market signals
- `start_date` (optional): Start date (ISO 8601)
- `end_date` (optional): End date (ISO 8601)
- `status` (optional): active, expired, resolved

**Response:**
```json
{
  "signals": [
    {
      "id": "signal_def456",
      "market_id": "polymarket_12345",
      "direction": "YES",
      "probability": 0.68,
      "edge": 0.03,
      "confidence": 0.72,
      "position_size": 0.02,
      "outcome": "CORRECT",
      "profit_loss": 0.05,
      "generated_at": "2025-01-20T10:00:00Z",
      "resolved_at": "2025-01-22T15:30:00Z"
    }
  ],
  "total": 1250,
  "performance": {
    "win_rate": 0.68,
    "avg_edge": 0.045,
    "total_return": 0.156
  }
}
```

### **3. Create Custom Signal Request**
```http
POST /signals/request
```

**Request Body:**
```json
{
  "market_id": "polymarket_12345",
  "analysis_type": "deep",
  "include_news": true,
  "include_social": true,
  "custom_parameters": {
    "risk_tolerance": 0.05,
    "time_horizon": "7d"
  }
}
```

**Response:**
```json
{
  "request_id": "req_789xyz",
  "status": "processing",
  "estimated_completion": "2025-01-25T12:05:00Z",
  "cost_zigma": 100
}
```

---

## 📊 **Analytics Endpoints**

### **1. Market Analysis**
```http
GET /analytics/market/{market_id}
```

**Response:**
```json
{
  "market_id": "polymarket_12345",
  "analysis": {
    "price_trend": "bullish",
    "liquidity_score": 0.85,
    "volatility": 0.12,
    "sentiment": "positive",
    "news_impact": 0.08,
    "social_volume": 1250,
    "prediction_accuracy": 0.72
  },
  "recommendations": [
    {
      "action": "BUY",
      "confidence": 0.85,
      "reason": "Strong institutional buying detected"
    }
  ],
  "updated_at": "2025-01-25T12:00:00Z"
}
```

### **2. Portfolio Performance**
```http
GET /analytics/portfolio
```

**Response:**
```json
{
  "portfolio": {
    "total_value": 50000,
    "active_positions": 12,
    "win_rate": 0.68,
    "total_return": 0.156,
    "sharpe_ratio": 1.85,
    "max_drawdown": -0.08
  },
  "positions": [
    {
      "market_id": "polymarket_12345",
      "direction": "YES",
      "size": 1000,
      "entry_price": 0.65,
      "current_price": 0.68,
      "pnl": 0.046,
      "status": "active"
    }
  ],
  "performance_history": [
    {"date": "2025-01-01", "value": 43200},
    {"date": "2025-01-25", "value": 50000}
  ]
}
```

---

## 🔄 **Real-time Data**

### **WebSocket Connection**
```javascript
const ws = new WebSocket('wss://ws.zigma.ai/v2');

// Authenticate
ws.send(JSON.stringify({
  type: 'auth',
  api_key: 'YOUR_API_KEY',
  wallet: 'YOUR_WALLET_ADDRESS'
}));

// Subscribe to signals
ws.send(JSON.stringify({
  type: 'subscribe',
  channel: 'signals',
  filters: {
    platform: 'polymarket',
    min_confidence: 0.7
  }
}));

// Receive real-time signals
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'signal') {
    console.log('New signal:', data.signal);
  }
};
```

### **WebSocket Events**
- `signals`: Real-time signal updates
- `markets`: Market price changes
- `analytics`: Portfolio updates
- `system`: Maintenance notifications

---

## 🤖 **AI Chat Integration**

### **Chat with ZIGMA Oracle**
```http
POST /chat
```

**Request Body:**
```json
{
  "message": "Analyze the BTC price prediction market",
  "context": {
    "market_id": "polymarket_12345",
    "user_profile": "aggressive",
    "risk_tolerance": 0.05
  },
  "analysis_depth": "comprehensive"
}
```

**Response:**
```json
{
  "response_id": "chat_123abc",
  "message": "Based on current market conditions and institutional flows...",
  "analysis": {
    "probability": 0.72,
    "confidence": 0.85,
    "key_factors": [
      "Institutional adoption increasing",
      "Technical indicators bullish",
      "Market sentiment positive"
    ],
    "risks": [
      "Regulatory uncertainty",
      "Market volatility"
    ]
  },
  "cost_zigma": 100,
  "tokens_used": 1500,
  "response_time": 2.3
}
```

---

## 📈 **Basket Contract**

### **Get Basket Performance**
```http
GET /basket/performance
```

**Response:**
```json
{
  "basket": {
    "total_value": 2500000,
    "active_trades": 45,
    "daily_return": 0.023,
    "monthly_return": 0.156,
    "annual_return": 1.85,
    "sharpe_ratio": 2.1
  },
  "holders": {
    "total_holders": 12500,
    "your_share": 1000,
    "your_earnings": 156.50
  },
  "recent_trades": [
    {
      "market_id": "polymarket_12345",
      "direction": "YES",
      "size": 50000,
      "entry_price": 0.65,
      "current_price": 0.68,
      "pnl": 0.046,
      "status": "active"
    }
  ]
}
```

---

## 🔧 **Error Handling**

### **Error Response Format**
```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient ZIGMA token balance for this request",
    "details": {
      "required": 1000,
      "current": 500
    },
    "request_id": "req_123abc"
  }
}
```

### **Common Error Codes**
- `401`: Unauthorized (invalid API key)
- `403`: Forbidden (insufficient $ZIGMA balance)
- `429`: Rate limit exceeded
- `500`: Internal server error
- `503`: Service temporarily unavailable

---

## 📝 **Code Examples**

### **Python SDK**
```python
from zigma import ZigmaClient

# Initialize client
client = ZigmaClient(
    api_key="YOUR_API_KEY",
    wallet_address="YOUR_WALLET_ADDRESS"
)

# Get active signals
signals = client.get_signals(
    platform="polymarket",
    min_confidence=0.7,
    min_edge=0.05
)

# Get market analysis
analysis = client.get_market_analysis("polymarket_12345")

# Chat with oracle
response = client.chat(
    message="Analyze BTC market",
    market_id="polymarket_12345"
)
```

### **JavaScript SDK**
```javascript
import { ZigmaClient } from 'zigma-js';

// Initialize client
const client = new ZigmaClient({
  apiKey: 'YOUR_API_KEY',
  walletAddress: 'YOUR_WALLET_ADDRESS'
});

// Get active signals
const signals = await client.getSignals({
  platform: 'polymarket',
  minConfidence: 0.7,
  minEdge: 0.05
});

// Get market analysis
const analysis = await client.getMarketAnalysis('polymarket_12345');

// Chat with oracle
const response = await client.chat({
  message: 'Analyze BTC market',
  marketId: 'polymarket_12345'
});
```

---

## 🚀 **Getting Started Guide**

### **1. Setup**
```bash
# Install Python SDK
pip install zigma

# Install JavaScript SDK
npm install zigma-js
```

### **2. Authentication**
```python
# Python
from zigma import ZigmaClient

client = ZigmaClient(
    api_key="your_api_key",
    wallet_address="your_wallet"
)
```

### **3. First Request**
```python
# Get signals
signals = client.get_signals()
print(f"Found {len(signals)} active signals")

# Analyze market
analysis = client.get_market_analysis("market_id")
print(f"Market confidence: {analysis.confidence}")
```

---

## 📞 **Support**

### **Developer Resources**
- **Documentation**: https://docs.zigma.ai
- **SDK Downloads**: https://github.com/zigma-ai
- **Status Page**: https://status.zigma.ai
- **Developer Discord**: https://discord.gg/zigma-devs

### **Contact**
- **API Support**: api-support@zigma.ai
- **Technical Issues**: tech-support@zigma.ai
- **Business Inquiries**: business@zigma.ai

---

## 📋 **Changelog**

### **v2.0 (January 2026)**
- Added WebSocket real-time data
- Enhanced AI chat integration
- Improved rate limiting
- New basket contract endpoints

### **v1.5 (December 2025)**
- Added Kalshi platform support
- Enhanced analytics endpoints
- Improved error handling

### **v1.0 (November 2025)**
- Initial API release
- Core signal endpoints
- Basic market data

---

*ZIGMA API Documentation v2.0 | Last Updated: January 2026*
