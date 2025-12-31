const OpenAI = require('openai');
const { getMarketAnalyzer, calculateKelly } = require('./market_analysis');
const { getClobPrice, startPolling, stopPolling, getOrderBook } = require('./clob_price_cache');
const { crossReferenceNews } = require('./processor');
require('dotenv').config();

// LLM Configuration - Support multiple providers for testing
const USE_MOCK = process.env.USE_MOCK_LLM === 'true'; // Set to true for free testing
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_BASE_URL = 'https://api.x.ai/v1';

const PROVIDER = process.env.LLM_PROVIDER
  || (OPENAI_API_KEY ? 'openai' : 'xai'); // default to OpenAI when available

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_XAI_MODEL = process.env.XAI_MODEL || 'grok-beta';
const LLM_MODEL = process.env.LLM_MODEL || (PROVIDER === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_XAI_MODEL);
const NEWS_DELTA_MODEL = process.env.NEWS_DELTA_MODEL || LLM_MODEL;

let sharedLLMClient = null;
function getLLMClient() {
  if (sharedLLMClient) return sharedLLMClient;

  if (PROVIDER === 'openai') {
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
    }
    sharedLLMClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  } else {
    if (!XAI_API_KEY) {
      throw new Error('XAI_API_KEY is required when LLM_PROVIDER=xai');
    }
    sharedLLMClient = new OpenAI({
      apiKey: XAI_API_KEY,
      baseURL: XAI_BASE_URL,
    });
  }

  return sharedLLMClient;
}

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
const ENHANCED_SYSTEM_PROMPT_TEMPLATE = `
You are the Agent Zigma. Today is {{todayDate}}. You are aware that Google's Gemini 3 Pro holds the #1 spot on Artificial Analysis, ahead of OpenAI's GPT-5.2 Garlic. Every trade must be cross-referenced against the BOJ Dec 19 rate hike decision (likely causing Yen Carry Trade unwind, -15% Bitcoin probability penalty) and the Trump 'Directive' vs 'Final Rule' legal framework. Reference market microstructure context: spread {{spread}}%, depth {{depth}}, liquidity score {{liquidityScore}}, recommended Kelly fraction {{kelly}}%.

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

function buildEnhancedSystemPrompt(context = {}) {
  const todayDate = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });

  return ENHANCED_SYSTEM_PROMPT_TEMPLATE
    .replace('{{todayDate}}', todayDate)
    .replace('{{spread}}', context.spread ?? 'N/A')
    .replace('{{depth}}', context.depth ?? 'N/A')
    .replace('{{liquidityScore}}', context.liquidityScore ?? 'N/A')
    .replace('{{kelly}}', context.kelly ?? 'N/A');
}

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

  return `You are a professional Polymarket analyst. You must return STRICT JSON ONLY (no markdown) that matches this schema:
{
  "deltaNews": number between -0.5 and 0.5,
  "deltaStructure": number between -0.5 and 0.5,
  "deltaBehavior": number between -0.5 and 0.5,
  "deltaTime": number between -0.5 and 0.5,
  "primaryReason": "NEWS_LAG" | "STRUCTURAL_MISPRICING" | "BEHAVIORAL_BIAS" | "TIME_DECAY_ERROR" | "CROSS_MARKET_ARBITRAGE",
  "reasoning": string explaining the quantitative logic behind the deltas,
  "uncertainty": number between 0 and 1 (0 = certain, 1 = highly uncertain),
  "sentimentScore": number between -1 and 1 summarizing the news tone
}

Context for your assessment:
MARKET DATA:
${marketJson}

ANALYSIS METRICS:
${analysisJson}

ORDER BOOK DATA:
${orderBookJson}

RECENT NEWS HEADLINES:
${newsText}

Current YES price: ${marketData.yesPrice}

Rules:
- Base each delta on the provided data only.
- Time-sensitive markets (resolving within 30 days) should include a negative deltaTime if no final rule or resolution event is scheduled.
- Do not output confidence percentages or trading instructions—only the JSON described above.
- Keep reasoning concise (<80 words) and cite specific datapoints when possible.

Return ONLY the JSON object—no prose or extra text.`;
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
  if (!question) return 0.05;
  const PRIOR_BUCKETS = {
    MACRO: [0.10, 0.30],
    POLITICS: [0.05, 0.20],
    CELEBRITY: [0.02, 0.10],
    TECH_ADOPTION: [0.10, 0.40],
    ETF_APPROVAL: [0.20, 0.60],
    WAR_OUTCOMES: [0.05, 0.25],
    SPORTS_FUTURES: [0.02, 0.15]
  };

  const SPORTS_PRIORS = {
    "Will the Buccaneers win the 2026 NFC Championship": 0.015, // ~1.5% odds based on current futures
    // Add more as needed, e.g., "Will the Chiefs win the 2026 Super Bowl": 0.20
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

  // Check for specific prior
  if (SPORTS_PRIORS[question]) {
    return SPORTS_PRIORS[question];
  }

  if (category === 'SPORTS_FUTURES') {
    let prior = 0.10; // default for sports
    const q = question.toLowerCase();
    if (/super bowl.*winner/i.test(q)) prior = 0.04;
    else if (/championship.*winner/i.test(q)) prior = 0.125;
    else if (/division.*winner/i.test(q)) prior = 0.25;
    return prior;
  }

  const bucket = PRIOR_BUCKETS[category] || [0.05, 0.20]; // Default conservative
  return (bucket[0] + bucket[1]) / 2; // Midpoint for expected prior
}

// Enhanced analysis for premium reports
async function generateEnhancedAnalysis(marketData, orderBook, news = [], cache = {}) {
  if (!marketData || typeof marketData.yesPrice !== 'number') {
    return {
      marketId: marketData?.id || 'unknown',
      question: marketData?.question || 'Unknown',
      algorithmicAnalysis: {},
      llmAnalysis: {
        executiveSummary: 'Market data incomplete',
        technicalMetrics: {},
        riskAssessment: { level: 'UNKNOWN', confidence: 0.5, reasons: ['Data incomplete'] },
        recommendation: { action: 'AVOID', confidence: 50, reasoning: 'Incomplete market data' },
        priceAnalysis: 'N/A',
        marketOutlook: 'N/A',
        confidence: 50,
        timestamp: Date.now()
      },
      premium: true,
      generatedAt: Date.now(),
      error: 'Invalid market data',
      fallback: true,
      confidence: 50,
      action: 'AVOID',
      probability: 0.5,
      reasoning: 'Invalid market data'
    };
  }
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
    if (!responseText) {
      return {
        winProb: 0.5,
        action: "AVOID",
        confidence: 50,
        reasoning: "LLM response undefined",
        deltaNews: 0,
        deltaStructure: 0,
        deltaBehavior: 0,
        deltaTime: 0,
        primaryReason: "NONE",
        uncertainty: 1,
        sentimentScore: 0
      };
    }
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
    const spreadPercentage = orderBook && orderBook.ask && orderBook.bid && orderBook.mid
      ? ((orderBook.ask - orderBook.bid) / orderBook.mid) * 100
      : 0;
    const depth = orderBook
      ? (orderBook.bids?.slice(0, 10).reduce((sum, b) => sum + (parseFloat(b.size) || 0), 0) || 0) +
        (orderBook.asks?.slice(0, 10).reduce((sum, a) => sum + (parseFloat(a.size) || 0), 0) || 0)
      : 0;
    const liquidityScore = spreadPercentage > 0 ? Math.max(0, Math.round(100 - spreadPercentage * 2)) : 50; // Simple score

    // Generate LLM prompt
    const systemPrompt = buildEnhancedSystemPrompt({
      spread: Number.isFinite(spreadPercentage) ? spreadPercentage.toFixed(2) : 'N/A',
      depth: Number.isFinite(depth) ? depth.toFixed(0) : 'N/A',
      liquidityScore: Number.isFinite(liquidityScore) ? liquidityScore : 'N/A',
      kelly: Number.isFinite(kellyFraction) ? (kellyFraction * 100).toFixed(1) : 'N/A'
    });
    const userPrompt = buildEnhancedAnalysisPrompt(marketData, analysis, orderBook || {}, news);

    const client = getLLMClient();
    let response;
    const llmCall = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      try {
        return await client.chat.completions.create({
          model: LLM_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 800,
          temperature: 0
        });
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

    let llmAnalysis = response?.choices?.[0]?.message?.content || '{}';

    // Compute news delta if news available

    // Compute news delta if news available
    let newsDelta = 0;
    if (news.length > 0) {
      const newsSummary = news.map(n => n.title + ' ' + n.snippet).join('\n').substring(0, 1000); // limit length
      const deltaPrompt = `Based ONLY on the provided news summary, does it make the YES outcome more likely (+), less likely (-), or neutral (0) compared to current market odds? Respond with only: +X%, -X%, or 0% where X is 5-20.\n\nNews summary:\n${newsSummary}`;
      try {
        const deltaResponse = await client.chat.completions.create({
          model: NEWS_DELTA_MODEL,
          messages: [{ role: 'user', content: deltaPrompt }],
          max_tokens: 20,
          temperature: 0
        });
        const deltaText = deltaResponse.choices[0].message.content.trim();
        if (deltaText === '0%') {
          newsDelta = 0;
        } else if (deltaText.startsWith('+')) {
          const num = parseFloat(deltaText.replace('+', '').replace('%', ''));
          newsDelta = isNaN(num) ? 0 : Math.min(num, 20) / 100;
        } else if (deltaText.startsWith('-')) {
          const num = parseFloat(deltaText.replace('-', '').replace('%', ''));
          newsDelta = isNaN(num) ? 0 : -Math.min(num, 20) / 100;
        }
      } catch (e) {
        console.error('News delta computation failed:', e);
        newsDelta = 0;
      }
    }

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const result = safeParseLLM(llmAnalysis);

    // Blend LLM delta with deterministic news delta
    result.deltaNews = clamp((result.deltaNews ?? 0) + newsDelta, -0.5, 0.5);

    const pMarket = clamp(typeof marketData.yesPrice === 'number' ? marketData.yesPrice : 0.5, 0.01, 0.99);
    const pPrior = clamp(getBaseRate(marketData.question), 0.01, 0.99);

    function logit(p) {
      if (p == null || isNaN(p)) return 0; // neutral logit
      if (p <= 0) return -Infinity;
      if (p >= 1) return Infinity;
      return Math.log(p / (1 - p));
    }

    function sigmoid(x) {
      return 1 / (1 + Math.exp(-x));
    }

    const deltaSum =
      (result.deltaNews || 0) +
      (result.deltaStructure || 0) +
      (result.deltaBehavior || 0) +
      (result.deltaTime || 0);

    const zigmaLogit = ((logit(pPrior) + logit(pMarket)) / 2) + deltaSum;
    const winProb = clamp(sigmoid(zigmaLogit), 0.01, 0.99);

    let action = 'HOLD';
    if (winProb > pMarket + 0.05) action = 'BUY YES';
    else if (winProb < pMarket - 0.05) action = 'BUY NO';

    const rawEdge = Math.abs(winProb - pMarket);

    let exposure = 0;
    let tier = 'None';
    if (rawEdge >= 0.30) { exposure = 1.0; tier = 'A'; }
    else if (rawEdge >= 0.20) { exposure = 0.5; tier = 'B'; }
    else if (rawEdge >= 0.15) { exposure = 0.25; tier = 'C'; }

    const daysLeft = marketData.endDateIso
      ? (new Date(marketData.endDateIso) - Date.now()) / (1000 * 60 * 60 * 24)
      : marketData.endDate
        ? (new Date(marketData.endDate) - Date.now()) / (1000 * 60 * 60 * 24)
        : 365;
    const entropy = getEntropy(marketData.question, daysLeft || 365);
    const liquidityFactor = marketData.liquidity ? Math.min(marketData.liquidity / 50000, 1) : 0.5;
    const effectiveEdge = rawEdge * (1 - entropy) * liquidityFactor;

    const confidenceScore = clamp((1 - (result.uncertainty ?? 0.5)) * 0.6 + effectiveEdge * 0.4, 0.05, 0.95);
    const confidencePercent = Math.round(confidenceScore * 100);

    const q = marketData.question.toLowerCase();
    let category = 'OTHER';
    if (/recession|inflation|fed|gdp|economy/i.test(q)) category = 'MACRO';
    if (/election|president|trump|biden|political/i.test(q)) category = 'POLITICS';
    if (/celebrity|britney|tour|concert|divorce/i.test(q)) category = 'CELEBRITY';
    if (/bitcoin|btc|crypto|tech|adoption/i.test(q)) category = 'TECH_ADOPTION';
    if (/etf|approval/i.test(q)) category = 'ETF_APPROVAL';
    if (/war|ukraine|russia|ceasefire/i.test(q)) category = 'WAR_OUTCOMES';
    if (/sports|game|win/i.test(q)) category = 'SPORTS_FUTURES';

    let reasoning = result.reasoning || 'No detailed reasoning from LLM.';
    if (result.primaryReason && result.primaryReason !== "NONE") {
      reasoning += ` | Primary: ${result.primaryReason}`;
    }
    reasoning += ` | Conviction Tier: ${tier} | Prior: ${pPrior.toFixed(3)} (${category} bucket) | Suggested Exposure: ${(exposure * 100).toFixed(0)}% bankroll.`;

    const structuredAnalysis = {
      probability: winProb,
      action,
      confidence: confidencePercent,
      reasoning,
      kellyFraction: exposure
    };
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
