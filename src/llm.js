const OpenAI = require('openai');
const { getMarketAnalyzer, calculateKelly } = require('./market_analysis');
const { getClobPrice, startPolling, stopPolling, getOrderBook } = require('./clob_price_cache');
const { crossReferenceNews } = require('./processor');
require('dotenv').config();

// LLM Configuration - Support multiple providers for testing
const USE_MOCK = process.env.USE_MOCK_LLM === 'true'; // Set to true for free testing
const PROVIDER = process.env.LLM_PROVIDER || 'xai'; // 'xai', 'openai', or 'mock'

// XAI Configuration
const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_BASE_URL = 'https://api.x.ai/v1';

// OpenAI Configuration (free credits often available for new accounts)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Mock LLM for testing without API calls
function generateMockAnalysis(marketData) {
  return {
    executiveSummary: `Mock analysis for ${marketData.question || 'Market'}: Current price at ${(marketData.yesPrice && !isNaN(marketData.yesPrice) ? marketData.yesPrice * 100 : 50).toFixed(1)}%. Market shows moderate volatility with balanced liquidity.`,
    riskAssessment: {
      level: 'MEDIUM',
      confidence: 0.75,
      reasons: ['Mock analysis - replace with real LLM', 'Balanced market conditions observed', 'Normal trading volume detected']
    },
    recommendation: {
      action: 'HOLD',
      confidence: 0.65,
      reasoning: 'Mock recommendation: Market conditions suggest waiting for clearer signals. This is test data - replace with real analysis.'
    },
    keyInsights: [
      'Mock insight 1: Market shows typical Polymarket dynamics',
      'Mock insight 2: Volume patterns suggest normal activity',
      'Mock insight 3: Price action indicates balanced sentiment'
    ],
    technicalMetrics: {
      momentum: 'NEUTRAL',
      volatility: 'MODERATE',
      liquidityScore: 0.7
    }
  };
}

// Enhanced system prompt for professional analysis
const ENHANCED_SYSTEM_PROMPT = `
You are the Agent Zigma. Today is December 18, 2025. You are aware that Google's Gemini 3 Pro holds the #1 spot on Artificial Analysis, ahead of OpenAI's GPT-5.2 Garlic. Every trade must be cross-referenced against the BOJ Dec 19 rate hike decision (likely causing Yen Carry Trade unwind, -15% Bitcoin probability penalty) and the Trump 'Directive' vs 'Final Rule' legal framework.

MANDATORY OUTPUT: Return a valid JSON object with exactly these keys:
{
  "deltaNews": number between -0.5 and 0.5 (news impact delta),
  "deltaStructure": number between -0.5 and 0.5 (structural impact delta),
  "deltaBehavior": number between -0.5 and 0.5 (behavioral impact delta),
  "deltaTime": number between -0.5 and 0.5 (time decay impact delta),
  "primaryReason": "NEWS_LAG", "STRUCTURAL_MISPRICING", "BEHAVIORAL_BIAS", "TIME_DECAY_ERROR", or "CROSS_MARKET_ARBITRAGE",
  "reasoning": string explaining your analysis,
  "uncertainty": number between 0 and 1 (quantified uncertainty in the analysis),
  "sentimentScore": number between -1 and 1 (overall sentiment from news headlines, -1 negative, 0 neutral, 1 positive)
}

RESPONSE MUST BE STRICT JSON ONLY. NO PROSE. NO MARKDOWN BLOCKS. NO ADDITIONAL TEXT. ONLY THE JSON OBJECT AS SHOWN ABOVE.

INSTRUCTIONS:
- CRITICAL LEGAL ANALYST: You are a Legal Analyst. If a market asks if a federal regulation will change, you MUST factor in the Administrative Procedure Act (APA). A Presidential Executive Order is an INTENT, not a RESOLUTION. Finalizing a Schedule III reclassification requires a 'Final Rule' in the Federal Register. If today is Dec 18 and the market ends Dec 31, a 99% probability is a HALLUCINATION. The correct delta is -0.30 for time decay.
- CRITICAL: It is December 18. For any market resolving by Dec 31, evaluate if the news event results in immediate legal resolution per the market's specific description.
- Check the market description for resolution criteria and compare to news timing. Do not assume announcement equals resolution.
- Multi-Step Reasoning: Step 1: Analyze news headlines for sentiment and relevance. Step 2: Calculate base probability from priors and data. Step 3: Adjust for deltas and assess survivability. Step 4: Quantify uncertainty based on data quality and time left.
- Uncertainty Quantification: Provide a score from 0 (certain) to 1 (highly uncertain) based on news volume, source credibility, and market maturity.
- Sentiment Integration: Aggregate sentiment from headlines as a score: positive for bullish, negative for bearish, neutral otherwise.
- Entity-Specific Sentiment: Weight news sources by credibility.
- Resolution Rule Guardrail: Parse market fine print.
- Shadow Market Tracking: Factor correlated events.
- Base deltas on market question, current price, news, fundamentals, and sentiment.
- Output deltas that adjust the market price to the true probability.
- NEVER output probabilities, confidence, or actions. Only deltas and reasoning.
`;

const BASIC_SYSTEM_PROMPT = `You are the Agent Zigma — a neutral, analytical observer of prediction market price and volume movement. Your purpose is to summarize market movement and liquidity signals; you must NOT make forecasts, probabilities, or predictions about future outcomes. Use only data provided in the input. Output short, factual, consistent lines that are easily readable on X and in an on-chain Deep Dive.

Rules:
- Do NOT predict future outcomes.
- Do NOT invent facts.
- Reference provided metrics only (yesPrice, noPrice, volume, liquidity, lastPrice, priceChange).
- Keep the X tweet <= 280 characters. The Deep Dive can be longer (200-400 words).
- Prefer concise bullet-style sentences for X, and a multi-paragraph expanded explanation for the Deep Dive.

Output formats:
- X (tweet): A single line that starts with an emoji status (e.g., 🟢/🟡/🔴), a one-sentence title (market), then 1-2 fact phrases (e.g., "YES up 9.6% in 1h | Volume spike: $1.2M"). End with Polymarket link.
- Deep Dive: JSON object with keys: marketId, title, summary, metrics, contextNotes, timestamp.`;

function buildDecreePrompt(markets) {
  const marketsJson = JSON.stringify(markets, null, 2);
  return `Given the following array of markets (JSON), provide:

X Decree: [single line <=280 chars for top market by priceChange, emoji + market + YES/NO change + volume]

Deep Dive Markets: [array of objects for top 5 markets, each with marketId, title, summary, metrics{currentPrice, priceChange, volume, liquidity}, contextNotes, timestamp]

Format as:
X Decree: [text]
Deep Dive: [valid JSON array]

${marketsJson}`;
}

// Enhanced analysis prompt for premium reports
function buildEnhancedAnalysisPrompt(marketData, analysis, orderBook, news = []) {
  const analysisJson = JSON.stringify(analysis, null, 2);
  const marketJson = JSON.stringify(marketData, null, 2);
  const orderBookJson = JSON.stringify(orderBook, null, 2);
  const newsText = news.length > 0 ? news.map(n => `- ${n.title}: ${n.snippet}`).join('\n') : 'No recent news available.';

  return `You are a professional Polymarket analyst. Analyze this market data and provide a comprehensive assessment:

MARKET DATA:
${marketJson}

ANALYSIS METRICS:
${analysisJson}

ORDER BOOK DATA:
${orderBookJson}

RECENT NEWS HEADLINES:
${newsText}

Current YES price: ${marketData.yesPrice}

Provide a professional analysis covering:
1. Executive Summary (2-3 sentences)
2. Technical Metrics Analysis (with specific numbers including spread percentage, order book depth, and liquidity quality score)
3. Risk Assessment (LOW/MEDIUM/HIGH with quantitative reasons)
4. Precise Probability and Recommendation: Provide a precise probability p (e.g., 94.7%) of the event occurring based on your analysis. Only recommend BUY YES if p > current YES price + 2%, BUY NO if p > (1 - current YES price) + 2%, otherwise AVOID with confidence based on your analysis.
5. Price Analysis (levels, spread, momentum)
6. Market Outlook (based on available data)

Format as structured text with clear sections:

Executive Summary: [2-3 sentences summarizing key findings]

Risk Assessment: [LOW/MEDIUM/HIGH] - [specific quantitative reasons]

Recommendation: [BUY YES/BUY NO/AVOID] ([0-100]% confidence) - [detailed reasoning with precise probability p]

Price Analysis: [current levels, spread analysis, momentum indicators]

Market Outlook: [short-term momentum based on available data]

Include disclaimer: "This analysis is for educational purposes only and should not be considered financial advice."`;
}

async function generateDecrees(markets) {
  try {
    // If no markets, return default
    if (!markets || markets.length === 0) {
      return { xDecree: 'Market Update: No active markets found for analysis', deepDive: [] };
    }
    // Use mock response if enabled
    if (USE_MOCK || PROVIDER === 'mock') {
      console.log('[MOCK] Generating mock decrees for testing');
      const topMarket = markets[0] || {};
      const mockXDecree = `🟢 ${topMarket.question?.substring(0, 50) || 'Market'}: YES up ${(Math.random() * 10).toFixed(1)}% | Volume: $${(Math.random() * 1000000).toLocaleString()} | Polymarket link`;

      const mockDeepDive = markets.slice(0, 5).map((market, i) => ({
        marketId: market.id || `market_${i}`,
        title: market.question?.substring(0, 80) || `Market Analysis ${i + 1}`,
        summary: `Mock summary: ${market.question?.substring(0, 100) || 'Market data'} shows ${(market.priceChange * 100).toFixed(1)}% change with volume of $${(market.volume24hr || 0).toLocaleString()}.`,
        metrics: {
          currentPrice: market.yesPrice || 0,
          priceChange: market.priceChange || 0,
          volume: market.volume24hr || 0,
          liquidity: market.liquidity || 0
        },
        contextNotes: `Mock analysis for testing purposes. Replace with real LLM when credits available.`,
        timestamp: Date.now()
      }));

      return { xDecree: mockXDecree, deepDive: mockDeepDive };
    }

    const prompt = buildDecreePrompt(markets);

    let response;
    if (PROVIDER === 'openai') {
      const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
      response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: BASIC_SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        max_tokens: 400
      });
    } else {
      // Default to XAI
      const client = new OpenAI({
        apiKey: XAI_API_KEY,
        baseURL: XAI_BASE_URL,
      });
      response = await client.chat.completions.create({
        model: 'grok-beta',
        messages: [
          { role: 'system', content: BASIC_SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        max_tokens: 400
      });
    }

    const text = response.choices[0].message.content;
    // Parse text format
    const xDecreeMatch = text.match(/X Decree:\s*(.*?)(?=Deep Dive:|$)/s);
    const xDecree = xDecreeMatch ? xDecreeMatch[1].trim() : 'Market Update: Analysis in progress';

    // Clean JSON string from common LLM formatting issues
    function cleanJson(jsonString) {
      // Remove trailing commas before closing braces/brackets
      jsonString = jsonString.replace(/,(\s*[}\]])/g, '$1');
      // Remove any extra text before first [ or after last ]
      const start = jsonString.indexOf('[');
      const end = jsonString.lastIndexOf(']') + 1;
      if (start >= 0 && end > start) {
        jsonString = jsonString.substring(start, end);
      }
      return jsonString;
    }

    const deepDiveMatch = text.match(/Deep Dive:\s*(\[.*\])/s);
    let deepDive = [];
    if (deepDiveMatch) {
      try {
        const cleanJsonStr = cleanJson(deepDiveMatch[1]);
        deepDive = JSON.parse(cleanJsonStr);
      } catch (e) {
        console.error('Failed to parse deep dive JSON:', e);
        deepDive = [];
      }
    }

    return { xDecree, deepDive };
  } catch (error) {
    console.error('Error generating decrees:', error);
    // Fallback to basic algorithmic response
    const topMarket = markets[0] || {};
    const xDecree = `🟡 ${topMarket.question?.substring(0, 50) || 'Market'}: Current YES price ${(topMarket.yesPrice || 0.5) * 100}% | Volume: $${(topMarket.volume || 0).toLocaleString()} | Polymarket link`;

    const deepDive = markets.slice(0, 5).map((market, i) => ({
      marketId: market.id || `market_${i}`,
      title: market.question?.substring(0, 80) || `Market Analysis ${i + 1}`,
      summary: `${market.question?.substring(0, 100) || 'Market'} shows ${(market.priceChange * 100).toFixed(1)}% change with volume of $${(market.volume || 0).toLocaleString()}.`,
      metrics: {
        currentPrice: market.yesPrice || 0,
        priceChange: market.priceChange || 0,
        volume: market.volume || 0,
        liquidity: market.liquidity || 0
      },
      contextNotes: `Algorithmic analysis: Market data from Polymarket API.`,
      timestamp: Date.now()
    }));

    return { xDecree, deepDive };
  }
}

const crypto = require('crypto');

// Simple in-memory cache for reproducibility (in production, use Redis or DB)
const reproducibleCache = new Map();

function getBaseRate(question) {
  const PRIOR_BUCKETS = {
    MACRO: [0.10, 0.30],
    POLITICS: [0.05, 0.20],
    CELEBRITY: [0.02, 0.10],
    TECH_ADOPTION: [0.10, 0.40],
    ETF_APPROVAL: [0.20, 0.60],
    WAR_OUTCOMES: [0.05, 0.25],
    SPORTS_FUTURES: [0.02, 0.15]
  };

  // Simple classify
  const q = question.toLowerCase();
  let category = 'OTHER';
  if (/recession|inflation|fed|gdp|economy/i.test(q)) category = 'MACRO';
  if (/election|president|trump|biden|political/i.test(q)) category = 'POLITICS';
  if (/celebrity|britney|tour|concert|divorce/i.test(q)) category = 'CELEBRITY';
  if (/bitcoin|btc|crypto|tech|adoption/i.test(q)) category = 'TECH_ADOPTION';
  if (/etf|approval/i.test(q)) category = 'ETF_APPROVAL';
  if (/war|ukraine|russia|ceasefire/i.test(q)) category = 'WAR_OUTCOMES';
  if (/sports|game|win/i.test(q)) category = 'SPORTS_FUTURES';

  const bucket = PRIOR_BUCKETS[category] || [0.05, 0.20]; // Default conservative
  return (bucket[0] + bucket[1]) / 2; // Midpoint for expected prior
}

// Enhanced analysis for premium reports
async function generateEnhancedAnalysis(marketData, orderBook, news = [], cache = {}) {
  function getEntropy(question, daysLeft) {
    let entropy = 0.1; // base
    const q = question.toLowerCase();
    if (/politics|election/i.test(q)) entropy += 0.3;
    if (/war|ceasefire/i.test(q)) entropy += 0.4;
    if (/celebrity/i.test(q)) entropy += 0.2;
    if (daysLeft > 365) entropy += 0.2;
    return Math.min(entropy, 0.8);
  }

  function safeParseLLM(responseText) {
    // Find JSON block
    const jsonStart = responseText.indexOf('{');
    const jsonEnd = responseText.lastIndexOf('}') + 1;
    const jsonStr = responseText.substring(jsonStart, jsonEnd);

    try {
      let parsed = JSON.parse(jsonStr);

      parsed.reasoning = parsed.reasoning || parsed["reasoning"] || "No detailed reasoning provided by LLM — default analysis applied.";

      // Flatten nested
      if (parsed["Precise Probability and Recommendation"]) {
        parsed = { ...parsed, ...parsed["Precise Probability and Recommendation"] };
      }

      const deltaNews = parsed.deltaNews || 0;
      const deltaStructure = parsed.deltaStructure || 0;
      const deltaBehavior = parsed.deltaBehavior || 0;
      const deltaTime = parsed.deltaTime || 0;
      const primaryReason = parsed.primaryReason || "NONE";

      const uncertainty = parsed.uncertainty || 0;
      const sentimentScore = parsed.sentimentScore || 0;

      return {
        winProb: 0.5, // Will be overridden
        action: "AVOID", // Will be overridden
        confidence: 0.7, // Adjusted by uncertainty
        reasoning: parsed.reasoning,
        deltaNews: Math.sign(deltaNews) * Math.min(Math.abs(deltaNews) + Math.abs(sentimentScore) * 0.1, 0.5), // Integrate sentiment
        deltaStructure,
        deltaBehavior,
        deltaTime,
        primaryReason,
        uncertainty,
        sentimentScore
      };
    } catch (e) {
      // Fallback regex or defaults
      console.error('JSON parse failed:', e);
      return {
        winProb: 0.5,
        action: "AVOID",
        confidence: 80,
        reasoning: "Fallback extraction from LLM response",
        deltaNews: 0,
        deltaStructure: 0,
        deltaBehavior: 0,
        deltaTime: 0,
        primaryReason: "NONE",
        uncertainty: 1, // High uncertainty
        sentimentScore: 0 // Neutral
      };
    }
  }

  try {
    // Use mock response if enabled
    if (USE_MOCK || PROVIDER === 'mock') {
      console.log('[MOCK] Generating mock enhanced analysis for testing');
      return {
        marketId: marketData.slug || marketData.id,
        question: marketData.question,
        algorithmicAnalysis: {}, // Would normally be from analyzer
        llmAnalysis: generateMockAnalysis(marketData),
        premium: true,
        generatedAt: Date.now(),
        mock: true
      };
    }

    const analyzer = getMarketAnalyzer();

    // Perform comprehensive analysis
    const analysis = await analyzer.analyzeMarket(marketData, cache);

    // Calculate Kelly fraction for position sizing
    const algorithmicConfidence = analysis.recommendation?.confidence || 50;
    const currentPrice = analysis.metrics?.currentPrice?.mid || 0.5;
    const kellyFraction = calculateKelly(algorithmicConfidence / 100, currentPrice);
    if (!analysis.recommendation) analysis.recommendation = {};
    analysis.recommendation.kellyFraction = kellyFraction;

    // Get order book for spread calculation
    const orderBook = await getOrderBook(marketData.id);
    const spreadPercentage = orderBook && orderBook.ask && orderBook.bid ? ((orderBook.ask - orderBook.bid) / orderBook.mid) * 100 : 0;
    const depth = orderBook ? (orderBook.bids?.slice(0, 10).reduce((sum, b) => sum + (parseFloat(b.size) || 0), 0) || 0) + (orderBook.asks?.slice(0, 10).reduce((sum, a) => sum + (parseFloat(a.size) || 0), 0) || 0) : 0;
    const liquidityScore = spreadPercentage > 0 ? Math.max(0, Math.round(100 - spreadPercentage * 2)) : 50; // Simple score

    // Generate LLM prompt
    let systemPrompt = ENHANCED_SYSTEM_PROMPT
      .replace('{{spread}}', spreadPercentage.toFixed(2))
      .replace('{{depth}}', depth.toFixed(0))
      .replace('{{liquidityScore}}', liquidityScore)
      .replace('{{kelly}}', (kellyFraction * 100).toFixed(1))
      .replace(/market_price/g, currentPrice.toFixed(3));
    const userPrompt = buildEnhancedAnalysisPrompt(marketData, analysis, orderBook, news);

    let response;
    const llmCall = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      try {
        if (PROVIDER === 'openai') {
          const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
          return await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 800,
            temperature: 0
          });
        } else {
          // Default to XAI
          const client = new OpenAI({
            apiKey: XAI_API_KEY,
            baseURL: XAI_BASE_URL,
          });
          return await client.chat.completions.create({
            model: 'grok-beta',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 800,
            temperature: 0
          });
        }
      } finally {
        clearTimeout(timeoutId);
      }
    };

    // Calculate news metrics for delta adjustment (moved outside try-catch to fix scope issue)
    let headline_count = news.length;
    let source_weight = 1.0;
    if (news.some(h => h.title && (h.title.toLowerCase().includes('reuters') || h.title.toLowerCase().includes('financial times') || h.title.toLowerCase().includes('wall street journal') || h.title.toLowerCase().includes('wsj')))) {
      source_weight = 2.0;
    }
    let novelty_decay = 1.0; // Simple, no repetition tracking yet
    let deltaNews_magnitude = 0;
    if (headline_count > 0) {
      deltaNews_magnitude = Math.min(0.30, (headline_count * 0.03) * source_weight * novelty_decay);
    }

    try {
      console.log(`[LLM] Starting API call for ${marketData.id}`);
      response = await llmCall();
      console.log(`[LLM] API call completed for ${marketData.id}`);
    } catch (error) {
      console.log(`[LLM] API call failed for ${marketData.id}: ${error.message}`);
      if (error.name === 'AbortError') {
        console.log('LLM call timed out');
      } else {
        const newsResults = await crossReferenceNews(marketData);
        const news = newsResults.slice(0, 5).map(r => ({title: r.title, snippet: r.snippet}));
        console.log(`Headlines found: ${news.length}`);
        console.log(`NEWS for ${marketData.question}: ${news.map(n => n.title).join(' | ')}`);

        // Update news metrics for fallback
        headline_count = news.length;
        source_weight = 1.0;
        if (news.some(h => h.title.toLowerCase().includes('reuters') || h.title.toLowerCase().includes('financial times') || h.title.toLowerCase().includes('wall street journal') || h.title.toLowerCase().includes('wsj'))) {
          source_weight = 2.0;
        }
        novelty_decay = 1.0;
        deltaNews_magnitude = 0;
        if (headline_count > 0) {
          deltaNews_magnitude = Math.min(0.30, (headline_count * 0.03) * source_weight * novelty_decay);
        }

        // Direct fallback analysis instead of recursive call
        return {
          marketId: marketData.slug || marketData.id,
          question: marketData.question,
          algorithmicAnalysis: {},
          llmAnalysis: {
            executiveSummary: `${marketData.question || 'Market'} shows current YES price at ${(marketData.yesPrice || 0.5) * 100}%. Volume: $${(marketData.volume || 0).toLocaleString()}.`,
            technicalMetrics: {
              currentPrice: marketData.yesPrice || 0.5,
              volume: marketData.volume || 0,
              liquidity: marketData.liquidity || 0
            },
            riskAssessment: { level: 'UNKNOWN', confidence: 0.5, reasons: ['Data analysis incomplete'] },
            recommendation: { action: 'HOLD', confidence: 50, reasoning: 'Insufficient analysis data' },
            priceAnalysis: `Current price: ${marketData.yesPrice || 0.5}`,
            marketOutlook: "Limited data available for outlook.",
            confidence: 50,
            timestamp: Date.now()
          },
          premium: true,
          generatedAt: Date.now(),
          error: error.message,
          fallback: true,
          confidence: 50,
          action: 'AVOID',
          probability: 0.5,
          reasoning: 'Fallback analysis due to LLM failure'
        };
      }
    }

    // Deterministic caching: hash marketID + date + headlines for reproducibility
    const headlinesStr = news.map(n => n.title + n.snippet).join('');
    const headlinesHash = crypto.createHash('md5').update(headlinesStr).digest('hex');
    const cacheKey = `${marketData.id}_${new Date().toDateString()}_${headlinesHash}`;

    let llmAnalysis;
    const cachedLLM = reproducibleCache.get(cacheKey);
    if (cachedLLM) {
      console.log('Using cached LLM response for deterministic reproducibility');
      llmAnalysis = cachedLLM;
    } else {
      llmAnalysis = response.choices[0].message.content;
      reproducibleCache.set(cacheKey, llmAnalysis);
      console.log('Cached new LLM response for reproducibility');
    }

    const result = safeParseLLM(llmAnalysis);

    // Override deltaNews with evidence-weighted value
    if (headline_count === 0) {
      result.deltaNews = 0;
    } else {
      result.deltaNews = Math.sign(result.deltaNews) * deltaNews_magnitude;
    }

    // Canonical P_zigma = clamp(P_prior + deltas, 0.01, 0.99)
    const pMarket = marketData.yesPrice;
    const pPrior = getBaseRate(marketData.question);

    function logit(p) {
      if (p <= 0) return -Infinity;
      if (p >= 1) return Infinity;
      return Math.log(p / (1 - p));
    }

    function sigmoid(x) {
      return 1 / (1 + Math.exp(-x));
    }

    const wMarket = 0.6;
    const wPrior = 0.3;
    const wDeltas = 0.1;
    let logitZigma = wMarket * logit(pMarket) + wPrior * logit(pPrior) + wDeltas * (result.deltaNews + result.deltaStructure + result.deltaBehavior + result.deltaTime);
    let winProb = sigmoid(logitZigma);
    winProb = Math.max(0.01, Math.min(0.99, winProb));

    console.log(`Probability chain: P_market: ${(pMarket*100).toFixed(1)}%, P_prior: ${(pPrior*100).toFixed(1)}%, Δ_news: ${(result.deltaNews*100).toFixed(1)}%, Δ_struct: ${(result.deltaStructure*100).toFixed(1)}%, Δ_behavior: ${(result.deltaBehavior*100).toFixed(1)}%, Δ_time: ${(result.deltaTime*100).toFixed(1)}% → P_zigma: ${(winProb*100).toFixed(1)}%, EDGE: ${(Math.abs(winProb - pMarket)*100).toFixed(1)}%`);

    let action = "NO_TRADE"; // default
    const rawEdge = Math.abs(winProb - pMarket);
    const daysLeft = marketData.endDateIso ? (new Date(marketData.endDateIso) - Date.now()) / (1000 * 60 * 60 * 24) : 365;
    const entropy = getEntropy(marketData.question, daysLeft);
    const confidenceScore = 0.7;
    const liquidityFactor = Math.min(marketData.liquidity / 75000, 1);
    const effectiveEdge = rawEdge * confidenceScore * (1 - entropy) * liquidityFactor;
    console.log(`Effective Edge: ${(effectiveEdge*100).toFixed(1)}% (raw ${(rawEdge*100).toFixed(1)}%, conf ${confidenceScore}, entropy ${entropy}, liqFactor ${liquidityFactor})`);

    // Edge survivability test: check if edge holds for short-term (1 day) and long-term (9 months)
    const shortTermEntropy = getEntropy(marketData.question, 1);
    const longTermEntropy = getEntropy(marketData.question, 270);
    const shortTermEdge = rawEdge * confidenceScore * (1 - shortTermEntropy) * liquidityFactor;
    const longTermEdge = rawEdge * confidenceScore * (1 - longTermEntropy) * liquidityFactor;
    console.log(`Survivability test: short-term ${(shortTermEdge*100).toFixed(1)}%, long-term ${(longTermEdge*100).toFixed(1)}%`);

    if (effectiveEdge >= 0.18 && shortTermEdge >= 0.18 && longTermEdge >= 0.18) {
      if (winProb > pMarket) action = "BUY YES";
      else action = "BUY NO";
    }

    let exposure = 0;
    let tier = 'None';
    if (rawEdge >= 0.30) { exposure = 1.0; tier = 'A'; }
    else if (rawEdge >= 0.20) { exposure = 0.5; tier = 'B'; }
    else if (rawEdge >= 0.15) { exposure = 0.25; tier = 'C'; }

    let reasoning = result.reasoning;
    if (result.primaryReason !== "NONE") {
      reasoning += ` | Primary: ${result.primaryReason}`;
    }
    reasoning += ` | Conviction Tier: ${tier}`;

    if (!result) {
      // Fallback
      console.error('LLM parsing completely failed, using defaults');
      structuredAnalysis = {
        probability: 0.5,
        action: "AVOID",
        confidence: 50,
        reasoning: "LLM response parsing failed"
      };
    } else {
      structuredAnalysis = {
        probability: winProb,
        action: action,
        confidence: 80, // TODO: base on edge?
        reasoning: reasoning
      };
    }

    // Clean probability (already clamped)
    structuredAnalysis.probability = winProb;

    structuredAnalysis.kellyFraction = exposure;
    structuredAnalysis.reasoning += ` Recommended Position: ${(exposure * 100).toFixed(1)}% of bankroll.`;

    return {
      marketId: marketData.id,
      question: marketData.question,
      confidence: structuredAnalysis.confidence, 
      action: structuredAnalysis.action,
      probability: structuredAnalysis.probability,
      reasoning: structuredAnalysis.reasoning,
      primaryReason: result.primaryReason,
      llmAnalysis: structuredAnalysis,
      generatedAt: Date.now(),
      pPrior: pPrior,
      deltas: {
        deltaNews: result.deltaNews,
        deltaStructure: result.deltaStructure,
        deltaBehavior: result.deltaBehavior,
        deltaTime: result.deltaTime,
        time: -10
      },
      entropy: entropy,
      effectiveEdge: effectiveEdge,
      confidenceScore: confidenceScore
    };

  } catch (error) {
    console.error('Error generating enhanced analysis:', error);

    // Fallback to basic algorithmic analysis
    const basicAnalysis = {
      executiveSummary: `${marketData.question || 'Market'} shows current YES price at ${(marketData.yesPrice || 0.5) * 100}%. Volume: $${(marketData.volume || 0).toLocaleString()}.`,
      technicalMetrics: {
        currentPrice: marketData.yesPrice || 0.5,
        volume: marketData.volume || 0,
        liquidity: marketData.liquidity || 0
      },
      riskAssessment: { level: 'UNKNOWN', confidence: 0.5, reasons: ['Data analysis incomplete'] },
      recommendation: { action: 'HOLD', confidence: 50, reasoning: 'Insufficient analysis data' },
      priceAnalysis: `Current price: ${marketData.yesPrice || 0.5}`,
      marketOutlook: "Limited data available for outlook.",
      confidence: 50,
      timestamp: Date.now()
    };

    return {
      marketId: marketData.slug || marketData.id,
      question: marketData.question,
      algorithmicAnalysis: {},
      llmAnalysis: basicAnalysis,
      premium: true,
      generatedAt: Date.now(),
      error: error.message,
      fallback: true,
      confidence: basicAnalysis.confidence || 50,
      action: basicAnalysis.recommendation?.action || 'AVOID',
      probability: 0.5,
      reasoning: basicAnalysis.recommendation?.reasoning || basicAnalysis.priceAnalysis || 'Fallback analysis'
    };
  }
}

module.exports = { generateDecrees, generateEnhancedAnalysis };
