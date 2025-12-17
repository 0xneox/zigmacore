const axios = require('axios');
require('dotenv').config();

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

      // Get current prices and orderbook
      const [priceData, orderBook, volumeStats, liquidity, positionStats] = await Promise.all([
        this.getCurrentPrice(yesTokenId),
        this.getOrderBook(yesTokenId),
        this.getVolumeStats(marketId),
        this.getLiquidityMetrics(marketId),
        this.getPositionStats(marketId)
      ]);

      analysis.metrics = {
        currentPrice: {
          yes: priceData.mid,
          bid: priceData.bid,
          ask: priceData.ask,
          spread: priceData.spread,
          spreadPercentage: priceData.spreadPercentage
        },
        volume: volumeStats,
        liquidity: liquidity,
        positions: positionStats,
        orderBook: {
          bidDepth: orderBook.bids.reduce((sum, b) => sum + b.size, 0),
          askDepth: orderBook.asks.reduce((sum, a) => sum + a.size, 0),
          bestBid: orderBook.bids[0]?.price || 0,
          bestAsk: orderBook.asks[0]?.price || 0
        },
        walletAnalysis
      };

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
        marketId: marketData.id || marketData.slug,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  // Classify market type for better analysis
  classifyMarket(question) {
    const q = question.toLowerCase();

    if (q.includes('bitcoin') || q.includes('btc') || q.includes('eth') || q.includes('crypto')) {
      return 'CRYPTO';
    }
    if (q.includes('election') || q.includes('trump') || q.includes('biden') || q.includes('president')) {
      return 'POLITICAL';
    }
    if (q.includes('recession') || q.includes('inflation') || q.includes('fed') || q.includes('gdp')) {
      return 'MACRO';
    }

    return 'EVENT';
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
        return {
          action: 'SPECULATIVE BUY',
          confidence: Math.min(85, 60 + Math.abs(priceChange)),
          reasoning: `Crypto market shows strong momentum (${priceChange > 0 ? 'bullish' : 'bearish'}) with adequate liquidity. Suitable for speculative positioning.`,
          riskLevel: riskAssessment.level,
          timestamp: Date.now()
        };
      } else {
        return {
          action: 'MARKET FAIRLY PRICED',
          confidence: 70,
          reasoning: `Crypto market trading in fair range with good liquidity ($${liquidity.toLocaleString()}) and volume.`,
          riskLevel: riskAssessment.level,
          timestamp: Date.now()
        };
      }
    } else if (liquidity >= 10000) {
      return {
        action: 'TAIL-RISK BET',
        confidence: 55,
        reasoning: `Crypto market shows moderate activity. Consider tail-risk positioning with caution.`,
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    } else {
      return {
        action: 'AVOID',
        confidence: 40,
        reasoning: `Crypto market lacks sufficient liquidity for reliable trading.`,
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

  // Political market specific logic (high volatility, sentiment-driven)
  generatePoliticalRecommendation(metrics, riskAssessment) {
    const liquidity = metrics.liquidity.liquidityUSD;
    const volume24h = metrics.volume.volume24h;
    const priceChange = metrics.priceChange.value;

    // Political markets can be volatile but meaningful
    if (liquidity >= 30000 && volume24h >= 8000) {
      if (Math.abs(priceChange) > 15) {
        return {
          action: 'SPECULATIVE BUY',
          confidence: Math.min(75, 50 + Math.abs(priceChange) * 0.8),
          reasoning: `Political market shows significant momentum, potentially reflecting news/events. High conviction signals detected.`,
          riskLevel: riskAssessment.level,
          timestamp: Date.now()
        };
      } else {
        return {
          action: 'MARKET FAIRLY PRICED',
          confidence: 60,
          reasoning: `Political market trading normally with adequate liquidity.`,
          riskLevel: riskAssessment.level,
          timestamp: Date.now()
        };
      }
    } else {
      return {
        action: 'AVOID',
        confidence: 35,
        reasoning: `Political market lacks sufficient activity for reliable sentiment analysis.`,
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    }
  }

  // Financial market specific logic (traditional financial instruments)
  generateFinancialRecommendation(metrics, riskAssessment) {
    const liquidity = metrics.liquidity.liquidityUSD;
    const volume24h = metrics.volume.volume24h;
    const spreadPct = metrics.currentPrice.spreadPercentage;

    if (liquidity >= 50000 && volume24h >= 15000 && spreadPct <= 2.5) {
      return {
        action: 'MARKET FAIRLY PRICED',
        confidence: 75,
        reasoning: `Financial market shows professional-grade liquidity and spreads. Suitable for informed trading.`,
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    } else if (liquidity >= 25000 && volume24h >= 8000) {
      return {
        action: 'TAIL-RISK BET',
        confidence: 60,
        reasoning: `Financial market shows moderate activity. Consider conservative positioning.`,
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    } else {
      return {
        action: 'AVOID',
        confidence: 40,
        reasoning: `Financial market lacks institutional-grade liquidity.`,
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    }
  }

  // Default event market logic (original implementation)
  generateEventRecommendation(metrics, riskAssessment) {
    const liquidity = metrics.liquidity.liquidityUSD;
    const volume24h = metrics.volume.volume24h;
    const spreadPct = metrics.currentPrice.spreadPercentage;
    const priceChange = metrics.priceChange.value;

    // High risk markets
    if (riskAssessment.level === 'HIGH') {
      return {
        action: 'AVOID',
        confidence: Math.max(30, 60 - riskAssessment.score * 5),
        reasoning: `High risk event market: ${riskAssessment.reasons.join(', ')}. Not suitable for trading.`,
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    }
    // Low liquidity or high spreads
    else if (liquidity < 25000 || spreadPct > 3) {
      return {
        action: 'MARKET FAIRLY PRICED',
        confidence: 50,
        reasoning: 'Event market conditions are acceptable but not optimal. Consider waiting for better liquidity.',
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    }
    // Good fundamentals
    else if (liquidity >= 50000 && volume24h >= 10000 && spreadPct <= 2) {
      return {
        action: 'TAIL-RISK BET',
        confidence: 75,
        reasoning: `Healthy event market with strong liquidity ($${liquidity.toLocaleString()}) and volume ($${volume24h.toLocaleString()}). Good for position holding.`,

        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    }
    else {
      return {
        action: 'MARKET FAIRLY PRICED',
        confidence: 60,
        reasoning: 'Event market shows moderate activity. Monitor for improved conditions.',
        riskLevel: riskAssessment.level,
        timestamp: Date.now()
      };
    }
  }

  // Generate enhanced LLM prompt for analysis
  generateAnalysisPrompt(marketData, analysis) {
    const systemPrompt = `You are a professional market analyst for Polymarket prediction markets. Your analysis must be:

PROFESSIONAL STANDARDS:
- Use only provided data - no external knowledge or assumptions
- Be objective and fact-based, never speculative
- Include specific numbers and metrics in your analysis
- Explain your reasoning clearly and logically
- Rate confidence on a 0-100 scale based on data quality and market conditions

OUTPUT FORMAT:
- Executive Summary (2-3 sentences)
- Key Metrics Analysis (bullet points with numbers)
- Risk Assessment (LOW/MEDIUM/HIGH with specific reasons)
- Recommendation (BUY/SELL/HOLD/AVOID with confidence %)
- Price Targets (if applicable, based on current market structure)
- Market Outlook (short-term momentum assessment)

Remember: This is for educational purposes. Always DYOR and never risk more than you can afford to lose.`;

    const userPrompt = `Analyze this Polymarket data and provide a comprehensive professional assessment:

MARKET: ${marketData.question}

CURRENT METRICS:
- Price: ${analysis.metrics ? (analysis.metrics.currentPrice?.mid?.toFixed(4) || 'N/A') : 'N/A'}
- Bid/Ask: ${analysis.metrics ? (analysis.metrics.currentPrice?.bid?.toFixed(4) || 'N/A') : 'N/A'} / ${analysis.metrics ? (analysis.metrics.currentPrice?.ask?.toFixed(4) || 'N/A') : 'N/A'}
- Spread: ${analysis.metrics ? (analysis.metrics.currentPrice?.spreadPercentage?.toFixed(2) || 'N/A') : 'N/A'}%
- Volume 24h: $${analysis.metrics ? (analysis.metrics.volume?.volume24h?.toLocaleString() || 'N/A') : (analysis.basicAnalysis?.volume24h?.toLocaleString() || 'N/A')}
- Liquidity: $${analysis.metrics ? (analysis.metrics.liquidity?.liquidityUSD?.toLocaleString() || 'N/A') : (analysis.basicAnalysis?.liquidity?.toLocaleString() || 'N/A')}
- Position Stats: YES: ${analysis.metrics?.positions?.yesPositions?.toLocaleString() || 'N/A'}, NO: ${analysis.metrics?.positions?.noPositions?.toLocaleString() || 'N/A'}, Total: ${analysis.metrics?.positions?.totalPositions?.toLocaleString() || 'N/A'}
- Insider Activity: ${analysis.metrics?.positions?.insiderActivity ? `Detected ${analysis.metrics.positions.insiderActivity.count} large orders ($${analysis.metrics.positions.insiderActivity.totalSize.toLocaleString()}) - Largest: $${analysis.metrics.positions.insiderActivity.largestOrder.toLocaleString()} on ${analysis.metrics.positions.insiderActivity.side}` : 'None detected'}
- Position Changes: ${analysis.metrics?.priceChange?.positionChange ? `YES: ${analysis.metrics.priceChange.positionChange.yesChange > 0 ? '+' : ''}${analysis.metrics.priceChange.positionChange.yesChange}, NO: ${analysis.metrics.priceChange.positionChange.noChange > 0 ? '+' : ''}${analysis.metrics.priceChange.positionChange.noChange}, Total: ${analysis.metrics.priceChange.positionChange.totalChange > 0 ? '+' : ''}${analysis.metrics.priceChange.positionChange.totalChange}` : 'First measurement'}
- Price Change: ${analysis.metrics ? (analysis.metrics.priceChange?.value?.toFixed(2) || 'N/A') : 'N/A'}%

TECHNICAL ANALYSIS:
- Risk Level: ${analysis.analysis?.riskAssessment?.level || 'UNKNOWN'}
- Risk Score: ${analysis.analysis?.riskAssessment ? `${analysis.analysis.riskAssessment.score}/${analysis.analysis.riskAssessment.maxScore}` : 'N/A'}
- Risk Factors: ${analysis.analysis?.riskAssessment?.reasons?.join(', ') || 'None'}
- AI Recommendation: ${analysis.recommendation?.action || 'UNKNOWN'} (${analysis.recommendation?.confidence || 0}% confidence)

Provide your professional analysis following the format specified.`;

    return { systemPrompt, userPrompt };
  }
}

// Singleton instance
let analyzerInstance = null;

function getMarketAnalyzer() {
  if (!analyzerInstance) {
    analyzerInstance = new MarketAnalyzer();
  }
  return analyzerInstance;
}

module.exports = { MarketAnalyzer, getMarketAnalyzer };
