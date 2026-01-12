const axios = require('axios');
const OpenAI = require('openai');
require('dotenv').config();

const { classifyMarket } = require('./utils/classifier');

let llmNewsClient = null;
function getLLMNewsClient() {
  if (llmNewsClient) return llmNewsClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('OPENAI_API_KEY missing – cannot enable LLM news fallback');
    return null;
  }
  llmNewsClient = new OpenAI({ apiKey });
  return llmNewsClient;
}

const LLM_NEWS_PROMPT = `You are a cautious market news assistant with up-to-date knowledge.
Given a query about a prediction market, return up to 3 verifiable headlines or state that no reliable headlines exist.
Rules:
- If you are unsure or lack recent knowledge, return an empty list.
- Only cite headlines that are well-known or published by reputable outlets.
- Provide ISO 8601 dates when possible.
- Include short factual summaries (max 180 characters).
- NEVER fabricate links; if unsure, leave url empty.

Respond strictly in JSON:
{
  "headlines": [
    {
      "title": "...",
      "summary": "...",
      "source": "...",
      "date": "YYYY-MM-DD",
      "confidence": 0.0-1.0,
      "url": ""
    }
  ]
}`;

async function searchLLMNews(query = '', marketContext = {}) {
  const enableFallback = process.env.ENABLE_LLM_NEWS_FALLBACK !== 'false';
  if (!enableFallback) return [];

  const client = getLLMNewsClient();
  if (!client || !query) return [];

  try {
    const response = await client.chat.completions.create({
      model: process.env.LLM_NEWS_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: 'system', content: LLM_NEWS_PROMPT },
        {
          role: 'user',
          content: `Query: ${query}\nMarket Question: ${marketContext.question || 'Unknown'}\nContext: ${JSON.stringify({
            id: marketContext.id,
            endDate: marketContext.endDateIso || marketContext.endDate || null
          })}`
        }
      ]
    });

    const raw = response?.choices?.[0]?.message?.content?.trim();
    if (!raw) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn('LLM news fallback JSON parse failed:', err.message);
      return [];
    }

    if (!parsed || !Array.isArray(parsed.headlines)) return [];

    return parsed.headlines
      .filter(Boolean)
      .map(headline => ({
        title: headline.title || 'LLM headline (unspecified)',
        url: headline.url || '',
        snippet: headline.summary || '',
        source: headline.source || 'LLM_FALLBACK',
        publishedDate: headline.date || null,
        relevanceScore: typeof headline.confidence === 'number' ? headline.confidence : 0.4,
        origin: 'LLM_FALLBACK'
      }));
  } catch (error) {
    console.error('LLM news fallback error:', error.message || error);
    return [];
  }
}

// Singleton instance
let analyzerInstance = null;

// Enhanced Market Analysis (inspired by Polymarket MCP Server)
class MarketAnalyzer {
  constructor() {
    this.GAMMA_API = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';
    this.CLOB_API = process.env.CLOB_API_URL || 'https://clob.polymarket.com';
  }

  // Fetch comprehensive market data
  async getMarketDetails(marketId) {
    try {
      const response = await axios.get(`${this.GAMMA_API}/markets/${marketId}`, {
        timeout: 8000
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching market details:', error);
      throw error;
    }
  }

  // Get current price from orderbook
  async getCurrentPrice(tokenId) {
    try {
      const [buyData, sellData] = await Promise.all([
        axios.get(`${this.CLOB_API}/price`, {
          params: { token_id: tokenId, side: 'BUY' },
          timeout: 5000
        }),
        axios.get(`${this.CLOB_API}/price`, {
          params: { token_id: tokenId, side: 'SELL' },
          timeout: 5000
        })
      ]);

      const ask = parseFloat(buyData.data.price || 0);
      const bid = parseFloat(sellData.data.price || 0);
      const mid = (bid + ask) / 2;

      return {
        tokenId,
        bid,
        ask,
        mid,
        spread: ask - bid,
        spreadPercentage: ((ask - bid) / mid) * 100,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('Error fetching current price:', error);
      throw error;
    }
  }

  // Get recent trades for wallet analysis
  async getTradeHistory(marketId, limit = 50) {
    try {
      const response = await axios.get(`${this.GAMMA_API}/markets/${marketId}/trades`, {
        params: { limit },
        timeout: 5000
      });

      return response.data.map(trade => ({
        id: trade.id,
        side: trade.side,
        price: parseFloat(trade.price),
        size: parseFloat(trade.size),
        value: parseFloat(trade.price) * parseFloat(trade.size),
        timestamp: new Date(trade.timestamp).getTime(),
        walletAddress: trade.makerAddress || trade.takerAddress, // Polymarket might provide wallet addresses
        txHash: trade.txHash
      }));
    } catch (error) {
      console.error('Error fetching trade history:', error);
      return [];
    }
  }

  // Analyze wallet patterns for insider detection
  async analyzeWalletPatterns(marketId) {
    try {
      const trades = await this.getTradeHistory(marketId, 100); // Get last 100 trades
      
      if (trades.length === 0) return { insiderWallets: [], patterns: {} };

      // Group trades by wallet
      const walletTrades = {};
      trades.forEach(trade => {
        if (trade.walletAddress) {
          if (!walletTrades[trade.walletAddress]) {
            walletTrades[trade.walletAddress] = [];
          }
          walletTrades[trade.walletAddress].push(trade);
        }
      });

      const insiderWallets = [];
      const patterns = {
        freshWallets: 0,
        singleTradeWallets: 0,
        largeTradeWallets: 0,
        totalWallets: Object.keys(walletTrades).length
      };

      // Analyze each wallet's pattern
      Object.entries(walletTrades).forEach(([wallet, walletTradesList]) => {
        const tradeCount = walletTradesList.length;
        const totalValue = walletTradesList.reduce((sum, trade) => sum + trade.value, 0);
        const largestTrade = Math.max(...walletTradesList.map(t => t.value));
        const firstTradeTime = Math.min(...walletTradesList.map(t => t.timestamp));
        const lastTradeTime = Math.max(...walletTradesList.map(t => t.timestamp));
        
        // Fresh wallet: first trade within last 24 hours
        const isFresh = (Date.now() - firstTradeTime) < (24 * 60 * 60 * 1000);
        
        // Single trade wallet
        const isSingleTrade = tradeCount === 1;
        
        // Large trade: $10k+ single trade
        const hasLargeTrade = largestTrade >= 10000;
        
        if (isFresh) patterns.freshWallets++;
        if (isSingleTrade) patterns.singleTradeWallets++;
        if (hasLargeTrade) patterns.largeTradeWallets++;

        // Flag as potential insider if: fresh wallet + single trade + large amount
        if (isFresh && isSingleTrade && hasLargeTrade) {
          insiderWallets.push({
            wallet: wallet,
            tradeCount,
            totalValue,
            largestTrade,
            firstTradeTime: new Date(firstTradeTime),
            lastTradeTime: new Date(lastTradeTime),
            side: walletTradesList[0].side,
            price: walletTradesList[0].price,
            pattern: 'FRESH_SINGLE_LARGE_TRADE',
            risk: 'VERY_HIGH'
          });
        }
        // Also flag other suspicious patterns
        else if (isSingleTrade && hasLargeTrade) {
          insiderWallets.push({
            wallet: wallet,
            tradeCount,
            totalValue,
            largestTrade,
            firstTradeTime: new Date(firstTradeTime),
            lastTradeTime: new Date(lastTradeTime),
            side: walletTradesList[0].side,
            price: walletTradesList[0].price,
            pattern: 'SINGLE_LARGE_TRADE',
            risk: 'HIGH'
          });
        }
      });

      return { insiderWallets, patterns, totalTrades: trades.length };
    } catch (error) {
      console.error('Error analyzing wallet patterns:', error);
      return { insiderWallets: [], patterns: {}, error: error.message };
    }
  }

  // Calculate volume statistics
  async getVolumeStats(marketId) {
    try {
      const market = await this.getMarketDetails(marketId);

      return {
        marketId,
        volume24h: parseFloat(market.volume24hr || 0),
        volume7d: parseFloat(market.volume7d || 0),
        volume30d: parseFloat(market.volume30d || 0),
        volumeAllTime: parseFloat(market.volumeNum || 0),
        formatted: {
          volume24h: `$${parseFloat(market.volume24hr || 0).toLocaleString()}`,
          volume7d: `$${parseFloat(market.volume7d || 0).toLocaleString()}`,
          volume30d: `$${parseFloat(market.volume30d || 0).toLocaleString()}`
        }
      };
    } catch (error) {
      console.error('Error fetching volume stats:', error);
      throw error;
    }
  }

  // Get liquidity metrics
  async getLiquidityMetrics(marketId) {
    try {
      const market = await this.getMarketDetails(marketId);
      const liquidity = parseFloat(market.liquidity || 0);

      return {
        marketId,
        liquidityUSD: liquidity,
        liquidityFormatted: `$${liquidity.toLocaleString()}`,
        liquidityRating: this.rateLiquidity(liquidity)
      };
    } catch (error) {
      console.error('Error fetching liquidity:', error);
      throw error;
    }
  }

  // Rate liquidity on a scale
  rateLiquidity(liquidity) {
    if (liquidity >= 100000) return 'EXCELLENT';
    if (liquidity >= 50000) return 'VERY_GOOD';
    if (liquidity >= 25000) return 'GOOD';
    if (liquidity >= 10000) return 'FAIR';
    if (liquidity >= 5000) return 'POOR';
    return 'VERY_POOR';
  }

  // Get position statistics (holder counts proxy via order book)
  async getPositionStats(marketId) {
    try {
      const orderBook = await this.getOrderBook(marketId);
      
      // Use order book depth as proxy for position activity
      const yesPositions = orderBook.bids.reduce((sum, b) => sum + b.size, 0);
      const noPositions = orderBook.asks.reduce((sum, a) => sum + a.size, 0);
      
      // Detect potential insider activity (large concentrated positions)
      const largeOrders = [...orderBook.bids, ...orderBook.asks]
        .filter(order => order.size > 1000) // Large orders > $1000
        .sort((a, b) => b.size - a.size);
      
      const insiderActivity = largeOrders.length > 0 ? {
        count: largeOrders.length,
        totalSize: largeOrders.reduce((sum, order) => sum + order.size, 0),
        largestOrder: largeOrders[0]?.size || 0,
        side: largeOrders[0]?.price > 0.5 ? 'YES' : 'NO'
      } : null;

      return {
        marketId,
        yesPositions,
        noPositions,
        totalPositions: yesPositions + noPositions,
        insiderActivity,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('Error fetching position stats:', error);
      return {
        marketId,
        yesPositions: 0,
        noPositions: 0,
        totalPositions: 0,
        insiderActivity: null,
        error: error.message
      };
    }
  }

  // Comprehensive market analysis (MCP Server inspired)
  async analyzeMarket(marketData, cache = {}) {
    try {
      const marketId = marketData.slug || marketData.id;
      const analysis = {
        marketId,
        question: marketData.question,
        timestamp: Date.now(),
        metrics: {},
        analysis: {},
        recommendation: {}
      };

      // EDGE FILTER: Skip markets that lack exploitable opportunities
      if (
        marketData.liquidity < 50000 ||
        marketData.volume24hr < 10000
      ) {
        return {
          marketId: marketData.slug || marketData.id,
          question: marketData.question,
          error: 'SKIPPED: Low liquidity/volume market lacks exploitable edge',
          marketType: 'LOW_QUALITY',
          recommendation: {
            action: 'AVOID',
            confidence: 5,
            reasoning: 'Market lacks sufficient liquidity or volume for meaningful analysis. No exploitable edge detected.',
            riskLevel: 'HIGH',
            timestamp: Date.now()
          },
          timestamp: Date.now()
        };
      }

      // Get tokens
      const tokens = marketData.tokens || [];
      if (tokens.length === 0) {
        // Return basic analysis for markets without token data
        return {
          marketId,
          question: marketData.question,
          error: 'No token data available',
          timestamp: Date.now(),
          basicAnalysis: {
            volume24h: parseFloat(marketData.volume24hr || 0),
            liquidity: parseFloat(marketData.liquidity || 0),
            note: 'Market lacks detailed token information'
          }
        };
      }

      // Analyze wallet patterns for insider detection
      const walletAnalysis = await this.analyzeWalletPatterns(marketId);

      // Get market details for volume stats
      const marketDetails = await this.getMarketDetails(marketId);

      // Get volume stats
      const volumeStats = await this.getVolumeStats(marketId);

      // Get liquidity
      const liquidityMetrics = await this.getLiquidityMetrics(marketId);

      // Get position stats
      const positionStats = await this.getPositionStats(marketId);

      // Get current price data
      const orderBook = await this.getOrderBook(marketId);
      const mid = orderBook.mid || (orderBook.bids && orderBook.asks ? (parseFloat(orderBook.bids[0]?.price || 0) + parseFloat(orderBook.asks[0]?.price || 0)) / 2 : null);
      
      let spread = 0;
      let spreadPercentage = 0;
      let depth = 0;
      let liquidityQualityScore = 0;

      if (orderBook.bid && orderBook.ask && mid) {
        spread = orderBook.ask - orderBook.bid;
        spreadPercentage = (spread / mid) * 100;
        
        // Calculate depth (sum of sizes in top 10 levels each side)
        const bidDepth = orderBook.bids ? orderBook.bids.slice(0, 10).reduce((sum, b) => sum + (parseFloat(b.size) || 0), 0) : 0;
        const askDepth = orderBook.asks ? orderBook.asks.slice(0, 10).reduce((sum, a) => sum + (parseFloat(a.size) || 0), 0) : 0;
        depth = bidDepth + askDepth;
        
        // Liquidity quality score: lower spread and higher depth = better score (0-100)
        const spreadScore = Math.max(0, 100 - spreadPercentage * 10); // Max 100 for 0% spread
        const depthScore = Math.min(100, depth * 1000); // Scale depth to score
        liquidityQualityScore = Math.round((spreadScore + depthScore) / 2);
      }

      const priceData = {
        mid: mid,
        spread: spread,
        spreadPercentage: spreadPercentage,
        depth: depth,
        liquidityQualityScore: liquidityQualityScore,
        volume: orderBook.volume
      };

      // Classify market type
      const marketType = classifyMarket(marketData.question);

      // Calculate price change from cache
      const lastPrice = cache[marketId]?.price;
      const lastPositions = cache[marketId]?.positions;

      const priceChange = lastPrice ? ((priceData.mid - lastPrice) / lastPrice) * 100 : 0;
      
      // Calculate position changes
      const positionChange = lastPositions ? {
        yesChange: positionStats.yesPositions - lastPositions.yesPositions,
        noChange: positionStats.noPositions - lastPositions.noPositions,
        totalChange: positionStats.totalPositions - lastPositions.totalPositions
      } : null;

      analysis.metrics.priceChange = {
        value: priceChange,
        direction: priceChange > 0 ? 'UP' : priceChange < 0 ? 'DOWN' : 'STABLE',
        lastPrice: lastPrice || priceData.mid,
        positionChange
      };

      // Risk assessment
      analysis.analysis.riskAssessment = this.assessRisk(analysis.metrics, volumeStats);

      // Generate recommendation
      analysis.recommendation = this.generateRecommendation(analysis.metrics, analysis.analysis.riskAssessment, marketType);

      return analysis;

    } catch (error) {
      console.error('Error in market analysis:', error);
      return {
        marketId: marketData.slug || marketData.id,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  // Assess market risk
  assessRisk(metrics, volumeStats) {
    let riskScore = 0;
    const reasons = [];

    // Liquidity risk
    const liquidity = metrics.liquidity.liquidityUSD;
    if (liquidity < 10000) {
      riskScore += 3;
      reasons.push('Low liquidity');
    } else if (liquidity < 50000) {
      riskScore += 1;
      reasons.push('Moderate liquidity');
    }

    // Spread risk
    const spreadPct = metrics.currentPrice.spreadPercentage;
    if (spreadPct > 5) {
      riskScore += 3;
      reasons.push('High spread');
    } else if (spreadPct > 2) {
      riskScore += 1;
      reasons.push('Moderate spread');
    }

    // Volume risk
    const volume24h = volumeStats.volume24h;
    if (volume24h < 1000) {
      riskScore += 2;
      reasons.push('Low trading volume');
    } else if (volume24h < 10000) {
      riskScore += 1;
      reasons.push('Moderate volume');
    }

    // Price movement risk
    const priceChange = Math.abs(metrics.priceChange.value);
    if (priceChange > 20) {
      riskScore += 2;
      reasons.push('High volatility');
    } else if (priceChange > 10) {
      riskScore += 1;
      reasons.push('Moderate volatility');
    }

    // Determine risk level
    let riskLevel;
    if (riskScore >= 6) riskLevel = 'HIGH';
    else if (riskScore >= 3) riskLevel = 'MEDIUM';
    else riskLevel = 'LOW';

    return {
      level: riskLevel,
      score: riskScore,
      reasons,
      maxScore: 9
    };
  }

  // Generate trading recommendation based on market type
  generateRecommendation(metrics, riskAssessment, marketType = 'EVENT') {
    const liquidity = metrics.liquidity.liquidityUSD;
    const volume24h = metrics.volume.volume24h;
    const spreadPct = metrics.currentPrice.spreadPercentage;
    const priceChange = metrics.priceChange.value;

    let recommendation, confidence, reasoning;

    // Adjust thresholds and logic based on market type
    switch (marketType.toUpperCase()) {
      case 'CRYPTO':
        // Crypto markets can handle more volatility and lower liquidity
        return this.generateCryptoRecommendation(metrics, riskAssessment);

      case 'MACRO':
        // Macro markets need more stability and higher volume
        return this.generateMacroRecommendation(metrics, riskAssessment);

      case 'POLITICAL':
        // Political markets are highly volatile and sentiment-driven
        return this.generatePoliticalRecommendation(metrics, riskAssessment);

      case 'FINANCIAL':
        // Financial markets need strong fundamentals
        return this.generateFinancialRecommendation(metrics, riskAssessment);

      default:
        // Default event market logic
        return this.generateEventRecommendation(metrics, riskAssessment);
    }
  }

  // Crypto market specific logic (higher tolerance for volatility)
  generateCryptoRecommendation(metrics, riskAssessment) {
    const liquidity = metrics.liquidity.liquidityUSD;
    const volume24h = metrics.volume.volume24h;
    const spreadPct = metrics.currentPrice.spreadPercentage;
    const priceChange = metrics.priceChange.value;

    // Crypto markets can tolerate higher spreads and lower liquidity
    if (liquidity >= 25000 && volume24h >= 5000) {
      if (Math.abs(priceChange) > 10) {
        const reasoning = `Crypto market shows strong momentum (${priceChange > 0 ? 'bullish' : 'bearish'}) with adequate liquidity. Suitable for speculative positioning.`;
        return {
          action: 'SPECULATIVE BUY',
          confidence: Math.min(85, 60 + Math.abs(priceChange)),
          reasoning: spreadPct > 5 ? reasoning + ` ⚠️ High slippage warning: ${spreadPct.toFixed(2)}% spread detected.` : reasoning,
          riskLevel: riskAssessment.level,
          timestamp: Date.now()
        };
      } else {
        const reasoning = `Crypto market trading in fair range with good liquidity ($${liquidity.toLocaleString()}) and volume.`;
        return {
          action: 'MARKET FAIRLY PRICED',
          confidence: 70,
          reasoning: spreadPct > 5 ? reasoning + ` ⚠️ High slippage warning: ${spreadPct.toFixed(2)}% spread detected.` : reasoning,
          riskLevel: riskAssessment.level,
          timestamp: Date.now()
        };
      }
    } else if (liquidity >= 10000) {
      const reasoning = `Crypto market shows moderate activity. Consider tail-risk positioning with caution.`;
      return {
        action: 'TAIL-RISK BET',
        confidence: 55,
        reasoning: spreadPct > 5 ? reasoning + ` ⚠️ High slippage warning: ${spreadPct.toFixed(2)}% spread detected.` : reasoning,
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    } else {
      const reasoning = `Crypto market lacks sufficient liquidity for reliable trading.`;
      return {
        action: 'AVOID',
        confidence: 40,
        reasoning: spreadPct > 5 ? reasoning + ` ⚠️ High slippage warning: ${spreadPct.toFixed(2)}% spread detected.` : reasoning,
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    }
  }

  // Macro market specific logic (requires higher volume and stability)
  generateMacroRecommendation(metrics, riskAssessment) {
    const liquidity = metrics.liquidity.liquidityUSD;
    const volume24h = metrics.volume.volume24h;
    const spreadPct = metrics.currentPrice.spreadPercentage;

    if (liquidity >= 75000 && volume24h >= 25000 && spreadPct <= 2) {
      return {
        action: 'MARKET FAIRLY PRICED',
        confidence: 80,
        reasoning: `Macro market shows strong fundamentals with excellent liquidity and volume. Suitable for informed positioning.`,
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    } else if (liquidity >= 50000 && volume24h >= 15000) {
      return {
        action: 'TAIL-RISK BET',
        confidence: 65,
        reasoning: `Macro market shows adequate activity but may lack full efficiency. Consider informed tail-risk positions.`,
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    } else {
      return {
        action: 'AVOID',
        confidence: 45,
        reasoning: `Macro market lacks sufficient volume/liquidity for reliable analysis.`,
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    }
  }
}

// Kelly Criterion calculation for optimal bet sizing
function calculateKelly(winProb, price, edgeBuffer = 0.01, liquidity = 10000) {
  // Ensure all inputs are numbers
  const p = Number(winProb);
  const priceNum = Number(price);
  const liqNum = Number(liquidity);

  // 1. Safety check: No edge or invalid price
  if (p <= (priceNum + edgeBuffer) || priceNum <= 0 || priceNum >= 1) {
    return 0; 
  }

  const rawEdge = Math.abs(p - priceNum);
  // Removed minimum edge threshold for MVP

  // 2. Standard Kelly: (p*b - q) / b
  // b = net odds (e.g., if price is 0.25, b is 3)
  const b = (1 - priceNum) / priceNum;
  const q = 1 - p;
  let fullKelly = (p * b - q) / b;

  // 3. Liquidity Scaling (More aggressive for MVP)
  // If liquidity < 1000, we don't bet.
  const liquidityMultiplier =
    liqNum < 1000 ? 0 :
    liqNum < 5000 ? 0.9 :
    liqNum < 20000 ? 1.0 :
    liqNum >= 100000 ? 1.2 : 1.1;

  // Apply multipliers with 2x Kelly multiplier and 5% max position cap
  const MAX_POSITION_SIZE = 0.05; // 5% max of bankroll
  const finalKelly = Math.min(fullKelly * 2.0 * liquidityMultiplier, MAX_POSITION_SIZE);
  
  return Math.max(0, finalKelly); // Return 0 if no valid edge
}

// Simple in-memory cache for Tavily searches (expires after 1 hour)
const tavilyCache = new Map();
const TAVILY_TTL_MS = 60 * 60 * 1000;
const TAVILY_MAX_RETRIES = 3;
const TAVILY_BACKOFF_MS = 1000;

async function searchTavily(query = '') {
  const cacheKey = (query || '').toLowerCase().trim();
  const cachedEntry = cacheKey ? tavilyCache.get(cacheKey) : null;
  const now = Date.now();

  if (cachedEntry && (now - cachedEntry.timestamp) < TAVILY_TTL_MS) {
    console.log('Using cached Tavily results for query:', query);
    return cachedEntry.results;
  }

  const performRequest = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          search_depth: 'basic'
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`Tavily HTTP ${response.status}`);
      }
      const data = await response.json();
      return data.results || [];
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  };

  for (let attempt = 1; attempt <= TAVILY_MAX_RETRIES; attempt++) {
    try {
      const results = await performRequest();
      if (cacheKey) {
        tavilyCache.set(cacheKey, { results, timestamp: now });
      }
      console.log('Fetched new Tavily results for query:', query);
      return results;
    } catch (error) {
      const isLastAttempt = attempt === TAVILY_MAX_RETRIES;
      if (error.name === 'AbortError') {
        console.log(`Tavily search timed out (attempt ${attempt})`);
      } else {
        console.error(`Tavily search error (attempt ${attempt}):`, error.message || error);
      }
      if (isLastAttempt) {
        if (cachedEntry) {
          console.log('Returning stale Tavily cache for query due to repeated failures:', query);
          return cachedEntry.results;
        }
        return [];
      }
      await new Promise(resolve => setTimeout(resolve, TAVILY_BACKOFF_MS * attempt));
    }
  }

  return cachedEntry?.results || [];
}

function getMarketAnalyzer() {
  if (!analyzerInstance) {
    analyzerInstance = new MarketAnalyzer();
  }
  return analyzerInstance;
}

module.exports = { MarketAnalyzer, getMarketAnalyzer, calculateKelly, searchTavily, searchLLMNews };
