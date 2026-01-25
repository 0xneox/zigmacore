# ZIGMA SDK Integration Guide

*Version 2.0 | Last Updated: January 2026*

---

## 🚀 **Getting Started with ZIGMA SDK**

The ZIGMA SDK provides developers with easy access to prediction market intelligence, AI-powered signals, and real-time analytics. This guide will help you integrate ZIGMA into your applications quickly and efficiently.

---

## 📋 **Prerequisites**

### **Requirements**
- **ZIGMA Tokens**: Minimum 1,000 $ZIGMA in your wallet
- **API Key**: Generated from ZIGMA dashboard
- **Development Environment**: Node.js 16+, Python 3.8+, or Go 1.19+
- **Wallet**: Solana-compatible wallet (Phantom, Solflare, etc.)

### **Account Setup**
1. **Create ZIGMA Account**: Visit [zigma.ai](https://zigma.ai)
2. **Verify Wallet**: Connect your Solana wallet
3. **Generate API Key**: From developer dashboard
4. **Fund Wallet**: Transfer $ZIGMA tokens to your wallet

---

## 🐍 **Python SDK**

### **Installation**
```bash
pip install zigma
```

### **Basic Setup**
```python
from zigma import ZigmaClient
import asyncio

# Initialize client
client = ZigmaClient(
    api_key="your_api_key_here",
    wallet_address="your_wallet_address_here"
)

# Test connection
try:
    status = client.get_status()
    print(f"ZIGMA API Status: {status['status']}")
    print(f"Rate Limit: {status['rate_limit']}")
except Exception as e:
    print(f"Connection failed: {e}")
```

### **Getting Signals**
```python
# Get all active signals
signals = client.get_signals()
print(f"Found {len(signals)} active signals")

# Filter signals
filtered_signals = client.get_signals(
    platform="polymarket",
    min_confidence=0.7,
    min_edge=0.05,
    category="cryptocurrency"
)

for signal in filtered_signals:
    print(f"Market: {signal['question']}")
    print(f"Direction: {signal['direction']}")
    print(f"Confidence: {signal['confidence']}")
    print(f"Edge: {signal['edge']}")
    print("---")
```

### **Market Analysis**
```python
# Analyze specific market
market_id = "polymarket_12345"
analysis = client.get_market_analysis(market_id)

print(f"Market: {analysis['question']}")
print(f"Probability: {analysis['probability']}")
print(f"Sentiment: {analysis['sentiment']}")
print(f"Liquidity Score: {analysis['liquidity_score']}")

# Get recommendations
for rec in analysis['recommendations']:
    print(f"Action: {rec['action']}")
    print(f"Confidence: {rec['confidence']}")
    print(f"Reason: {rec['reason']}")
```

### **AI Chat Integration**
```python
# Chat with ZIGMA oracle
response = client.chat(
    message="What's your analysis of the BTC price prediction market?",
    market_id="polymarket_12345",
    analysis_depth="comprehensive"
)

print(f"Response: {response['message']}")
print(f"Confidence: {response['analysis']['confidence']}")
print(f"Cost: {response['cost_zigma']} ZIGMA")
```

### **Real-time Data**
```python
import asyncio

async def handle_signals():
    # WebSocket connection for real-time signals
    async for signal in client.stream_signals():
        print(f"New signal: {signal['question']}")
        print(f"Direction: {signal['direction']}")
        print(f"Confidence: {signal['confidence']}")
        
        # Auto-trade logic (example)
        if signal['confidence'] > 0.8:
            await execute_trade(signal)

async def execute_trade(signal):
    # Your trading logic here
    print(f"Executing trade for {signal['market_id']}")
    pass

# Run real-time stream
asyncio.run(handle_signals())
```

### **Portfolio Management**
```python
# Get portfolio performance
portfolio = client.get_portfolio_performance()

print(f"Total Value: ${portfolio['total_value']}")
print(f"Win Rate: {portfolio['win_rate']}")
print(f"Total Return: {portfolio['total_return']}")

# Get individual positions
for position in portfolio['positions']:
    print(f"Market: {position['market_id']}")
    print(f"PnL: {position['pnl']}")
    print(f"Status: {position['status']}")
```

---

## 🟢 **Node.js / JavaScript SDK**

### **Installation**
```bash
npm install zigma-js
```

### **Basic Setup**
```javascript
import { ZigmaClient } from 'zigma-js';

// Initialize client
const client = new ZigmaClient({
  apiKey: 'your_api_key_here',
  walletAddress: 'your_wallet_address_here'
});

// Test connection
async function testConnection() {
  try {
    const status = await client.getStatus();
    console.log('ZIGMA API Status:', status.status);
    console.log('Rate Limit:', status.rate_limit);
  } catch (error) {
    console.error('Connection failed:', error.message);
  }
}

testConnection();
```

### **Getting Signals**
```javascript
// Get all active signals
async function getSignals() {
  try {
    const signals = await client.getSignals();
    console.log(`Found ${signals.length} active signals`);
    
    // Filter signals
    const filteredSignals = await client.getSignals({
      platform: 'polymarket',
      minConfidence: 0.7,
      minEdge: 0.05,
      category: 'cryptocurrency'
    });
    
    filteredSignals.forEach(signal => {
      console.log(`Market: ${signal.question}`);
      console.log(`Direction: ${signal.direction}`);
      console.log(`Confidence: ${signal.confidence}`);
      console.log(`Edge: ${signal.edge}`);
      console.log('---');
    });
  } catch (error) {
    console.error('Error getting signals:', error.message);
  }
}

getSignals();
```

### **Market Analysis**
```javascript
// Analyze specific market
async function analyzeMarket(marketId) {
  try {
    const analysis = await client.getMarketAnalysis(marketId);
    
    console.log(`Market: ${analysis.question}`);
    console.log(`Probability: ${analysis.probability}`);
    console.log(`Sentiment: ${analysis.sentiment}`);
    console.log(`Liquidity Score: ${analysis.liquidityScore}`);
    
    // Get recommendations
    analysis.recommendations.forEach(rec => {
      console.log(`Action: ${rec.action}`);
      console.log(`Confidence: ${rec.confidence}`);
      console.log(`Reason: ${rec.reason}`);
    });
  } catch (error) {
    console.error('Error analyzing market:', error.message);
  }
}

analyzeMarket('polymarket_12345');
```

### **AI Chat Integration**
```javascript
// Chat with ZIGMA oracle
async function chatWithOracle() {
  try {
    const response = await client.chat({
      message: "What's your analysis of the BTC price prediction market?",
      marketId: 'polymarket_12345',
      analysisDepth: 'comprehensive'
    });
    
    console.log(`Response: ${response.message}`);
    console.log(`Confidence: ${response.analysis.confidence}`);
    console.log(`Cost: ${response.costZigma} ZIGMA`);
  } catch (error) {
    console.error('Error chatting with oracle:', error.message);
  }
}

chatWithOracle();
```

### **Real-time Data**
```javascript
// WebSocket connection for real-time signals
async function handleRealTimeSignals() {
  try {
    const signalStream = client.streamSignals({
      platform: 'polymarket',
      minConfidence: 0.7
    });
    
    for await (const signal of signalStream) {
      console.log(`New signal: ${signal.question}`);
      console.log(`Direction: ${signal.direction}`);
      console.log(`Confidence: ${signal.confidence}`);
      
      // Auto-trade logic (example)
      if (signal.confidence > 0.8) {
        await executeTrade(signal);
      }
    }
  } catch (error) {
    console.error('Error in signal stream:', error.message);
  }
}

async function executeTrade(signal) {
  // Your trading logic here
  console.log(`Executing trade for ${signal.marketId}`);
}

handleRealTimeSignals();
```

---

## 📱 **React Integration Example**

### **Signal Dashboard Component**
```jsx
import React, { useState, useEffect } from 'react';
import { ZigmaClient } from 'zigma-js';

function SignalDashboard() {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const client = new ZigmaClient({
    apiKey: process.env.REACT_APP_ZIGMA_API_KEY,
    walletAddress: process.env.REACT_APP_WALLET_ADDRESS
  });

  useEffect(() => {
    fetchSignals();
    // Set up real-time updates
    const subscription = client.subscribeToSignals({
      platform: 'polymarket',
      minConfidence: 0.7
    });

    subscription.on('signal', (newSignal) => {
      setSignals(prev => [newSignal, ...prev.slice(0, 9)]);
    });

    return () => subscription.unsubscribe();
  }, []);

  const fetchSignals = async () => {
    try {
      setLoading(true);
      const fetchedSignals = await client.getSignals({
        platform: 'polymarket',
        minConfidence: 0.7
      });
      setSignals(fetchedSignals);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div>Loading signals...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div className="signal-dashboard">
      <h2>Active ZIGMA Signals</h2>
      {signals.map(signal => (
        <SignalCard key={signal.id} signal={signal} />
      ))}
    </div>
  );
}

function SignalCard({ signal }) {
  return (
    <div className="signal-card">
      <h3>{signal.question}</h3>
      <div className="signal-details">
        <span className={`direction ${signal.direction.toLowerCase()}`}>
          {signal.direction}
        </span>
        <span className="confidence">
          Confidence: {(signal.confidence * 100).toFixed(1)}%
        </span>
        <span className="edge">
          Edge: {(signal.edge * 100).toFixed(1)}%
        </span>
      </div>
      <p className="rationale">{signal.rationale}</p>
      <div className="signal-meta">
        <span>Platform: {signal.platform}</span>
        <span>Generated: {new Date(signal.generatedAt).toLocaleString()}</span>
      </div>
    </div>
  );
}

export default SignalDashboard;
```

---

## 📊 **Advanced Examples**

### **Trading Bot Framework**
```python
import asyncio
from zigma import ZigmaClient

class ZigmaTradingBot:
    def __init__(self, api_key, wallet_address, config):
        self.client = ZigmaClient(api_key, wallet_address)
        self.config = config
        self.positions = {}
        
    async def run(self):
        """Main bot loop"""
        while True:
            try:
                # Get new signals
                signals = await self.get_filtered_signals()
                
                # Process each signal
                for signal in signals:
                    await self.process_signal(signal)
                
                # Monitor existing positions
                await self.monitor_positions()
                
                # Wait before next iteration
                await asyncio.sleep(self.config['check_interval'])
                
            except Exception as e:
                print(f"Bot error: {e}")
                await asyncio.sleep(60)
    
    async def get_filtered_signals(self):
        """Get signals matching bot criteria"""
        return await self.client.get_signals(
            min_confidence=self.config['min_confidence'],
            min_edge=self.config['min_edge'],
            platforms=self.config['platforms']
        )
    
    async def process_signal(self, signal):
        """Process a new signal"""
        market_id = signal['market_id']
        
        # Check if already in position
        if market_id in self.positions:
            return
        
        # Calculate position size
        position_size = self.calculate_position_size(signal)
        
        # Execute trade
        if position_size > 0:
            await self.execute_trade(signal, position_size)
    
    def calculate_position_size(self, signal):
        """Calculate optimal position size using Kelly Criterion"""
        edge = signal['edge']
        confidence = signal['confidence']
        max_position = self.config['max_position_size']
        
        # Kelly formula: f* = (bp - q) / b
        # where b = odds, p = win probability, q = loss probability
        kelly_fraction = (edge * confidence - (1 - confidence)) / edge
        
        # Apply safety limits
        position_size = min(kelly_fraction, max_position)
        
        return max(0, position_size)
    
    async def execute_trade(self, signal, position_size):
        """Execute a trade based on signal"""
        market_id = signal['market_id']
        direction = signal['direction']
        
        print(f"Executing {direction} trade for {market_id}")
        print(f"Position size: {position_size:.2%}")
        
        # Your trading logic here
        # This would integrate with your preferred exchange
        
        # Track position
        self.positions[market_id] = {
            'direction': direction,
            'size': position_size,
            'entry_price': signal['current_price'],
            'signal_id': signal['id'],
            'opened_at': signal['generated_at']
        }
    
    async def monitor_positions(self):
        """Monitor and manage existing positions"""
        for market_id, position in list(self.positions.items()):
            # Check if position should be closed
            if await self.should_close_position(market_id, position):
                await self.close_position(market_id, position)
    
    async def should_close_position(self, market_id, position):
        """Determine if position should be closed"""
        # Get current market data
        market_data = await self.client.get_market_details(market_id)
        current_price = market_data['current_price']
        
        # Calculate P&L
        pnl = self.calculate_pnl(position, current_price)
        
        # Close conditions
        if pnl <= -self.config['stop_loss']:
            return True  # Stop loss
        
        if pnl >= self.config['take_profit']:
            return True  # Take profit
        
        # Check if signal has expired
        signal = await self.client.get_signal(position['signal_id'])
        if signal['status'] == 'expired':
            return True
        
        return False
    
    def calculate_pnl(self, position, current_price):
        """Calculate position P&L"""
        entry_price = position['entry_price']
        direction = position['direction']
        
        if direction == 'YES':
            return (current_price - entry_price) / entry_price
        else:
            return (entry_price - current_price) / entry_price
    
    async def close_position(self, market_id, position):
        """Close a position"""
        print(f"Closing position for {market_id}")
        
        # Your closing logic here
        
        # Remove from tracking
        del self.positions[market_id]

# Bot configuration
config = {
    'min_confidence': 0.7,
    'min_edge': 0.05,
    'max_position_size': 0.05,  # 5% max per position
    'stop_loss': -0.1,  # 10% stop loss
    'take_profit': 0.2,  # 20% take profit
    'platforms': ['polymarket', 'kalshi'],
    'check_interval': 60  # Check every 60 seconds
}

# Run the bot
async def main():
    bot = ZigmaTradingBot(
        api_key='your_api_key',
        wallet_address='your_wallet_address',
        config=config
    )
    await bot.run()

if __name__ == '__main__':
    asyncio.run(main())
```

---

## 🔧 **Configuration & Best Practices**

### **Environment Variables**
```bash
# .env file
ZIGMA_API_KEY=your_api_key_here
ZIGMA_WALLET_ADDRESS=your_wallet_address_here
ZIGMA_ENVIRONMENT=production  # or sandbox
ZIGMA_LOG_LEVEL=info
```

### **Error Handling**
```python
import logging
from zigma import ZigmaClient, ZigmaError, RateLimitError

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class SafeZigmaClient:
    def __init__(self, api_key, wallet_address):
        self.client = ZigmaClient(api_key, wallet_address)
        self.retry_count = 3
        self.retry_delay = 1
    
    async def get_signals_with_retry(self, **kwargs):
        """Get signals with retry logic"""
        for attempt in range(self.retry_count):
            try:
                return await self.client.get_signals(**kwargs)
            except RateLimitError as e:
                wait_time = e.retry_after or self.retry_delay * (2 ** attempt)
                logger.warning(f"Rate limited, waiting {wait_time}s")
                await asyncio.sleep(wait_time)
            except ZigmaError as e:
                logger.error(f"ZIGMA API error: {e}")
                if attempt == self.retry_count - 1:
                    raise
                await asyncio.sleep(self.retry_delay)
        
        return []
```

### **Rate Limit Management**
```javascript
class RateLimitedZigmaClient {
  constructor(apiKey, walletAddress) {
    this.client = new ZigmaClient({ apiKey, walletAddress });
    this.requestQueue = [];
    this.processing = false;
    this.lastRequest = 0;
    this.minInterval = 100; // 100ms between requests
  }

  async getSignals(options = {}) {
    return this.queueRequest('getSignals', options);
  }

  async queueRequest(method, args) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ method, args, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.requestQueue.length === 0) return;
    
    this.processing = true;
    
    while (this.requestQueue.length > 0) {
      const { method, args, resolve, reject } = this.requestQueue.shift();
      
      // Rate limiting
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequest;
      
      if (timeSinceLastRequest < this.minInterval) {
        await this.sleep(this.minInterval - timeSinceLastRequest);
      }
      
      try {
        const result = await this.client[method](args);
        resolve(result);
      } catch (error) {
        reject(error);
      }
      
      this.lastRequest = Date.now();
    }
    
    this.processing = false;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

---

## 📚 **Additional Resources**

### **SDK Documentation**
- **Python SDK**: [https://pypi.org/project/zigma/](https://pypi.org/project/zigma/)
- **JavaScript SDK**: [https://www.npmjs.com/package/zigma-js](https://www.npmjs.com/package/zigma-js)
- **GitHub Repository**: [https://github.com/zigma-ai/sdk](https://github.com/zigma-ai/sdk)

### **Community & Support**
- **Developer Discord**: [https://discord.gg/zigma-devs](https://discord.gg/zigma-devs)
- **Stack Overflow**: Tag questions with `zigma-sdk`
- **GitHub Issues**: [https://github.com/zigma-ai/sdk/issues](https://github.com/zigma-ai/sdk/issues)

### **Examples & Templates**
- **Trading Bot**: Complete bot framework
- **Dashboard**: React dashboard example
- **Mobile App**: React Native integration
- **Backend Service**: Express.js integration

---

## 🚀 **Quick Start Checklist**

### **Before You Begin**
- [ ] Create ZIGMA account
- [ ] Verify wallet address
- [ ] Purchase 1,000+ $ZIGMA tokens
- [ ] Generate API key
- [ ] Install SDK

### **First Integration**
- [ ] Initialize SDK with credentials
- [ ] Test API connection
- [ ] Fetch first signals
- [ ] Implement basic error handling
- [ ] Set up rate limiting

### **Production Deployment**
- [ ] Use production API endpoints
- [ ] Implement comprehensive error handling
- [ ] Set up monitoring and logging
- [ ] Configure rate limiting
- [ ] Test with sandbox first

---

## 📞 **Support & Contact**

### **Get Help**
- **Documentation**: https://docs.zigma.ai
- **API Reference**: https://api.zigma.ai/docs
- **Status Page**: https://status.zigma.ai
- **Developer Support**: dev-support@zigma.ai

### **Report Issues**
- **Bug Reports**: GitHub Issues
- **Feature Requests**: GitHub Discussions
- **Security Issues**: security@zigma.ai

---

*ZIGMA SDK Guide v2.0 | Last Updated: January 2026*
