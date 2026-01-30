const OpenAI = require('openai').default || require('openai'); // Handle both CJS/ESM quirks
const crypto = require('crypto');
const { getMarketAnalyzer, calculateKelly } = require('./market_analysis');
const { getClobPrice, startPolling, stopPolling, getOrderBook } = require('./clob_price_cache');
const { crossReferenceNews } = require('./processor');
const { classifyMarket } = require('./utils/classifier');
const { buildUserContext, generatePersonalizedPrompt, generatePersonalizedSummary } = require('./llm/personalized');
const { applyAdaptiveLearning, recordSignalOutcome } = require('./adaptive-learning');
const { calculateMarketEntropy, applyEntropyDiscount } = require('./utils/entropy-enhanced');
const { calculateAggregateSentiment } = require('./utils/sentiment-enhanced');
const { applyCalibration } = require('./confidence-calibration');
require('dotenv').config();

// Utility functions
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// CORRECT edge calculation with proper direction and ALL costs
function computeNetEdge(llmProbability, marketPrice, orderBook = {}) {
  // Raw edge = your probability - market price
  // Positive = market underpriced (BUY YES)
  // Negative = market overpriced (BUY NO)
  const rawEdge = llmProbability - marketPrice;

  // Polymarket costs breakdown:
  // 1. Spread: You cross half the spread when trading
  // 2. Slippage: Estimated based on order size vs book depth
  // 3. Trading fee: ~2% (not included here, handled in Kelly)
  
  // Calculate spread from order book if available
  let estimatedSpread = 0.01; // 1% default spread
  if (orderBook && orderBook.bids && orderBook.asks && 
      orderBook.bids.length > 0 && orderBook.asks.length > 0) {
    const bestBid = parseFloat(orderBook.bids[0]?.price) || 0;
    const bestAsk = parseFloat(orderBook.asks[0]?.price) || 0;
    if (bestBid > 0 && bestAsk > 0 && bestAsk > bestBid) {
      estimatedSpread = bestAsk - bestBid;
    }
  } else if (typeof orderBook?.spread === 'number') {
    estimatedSpread = orderBook.spread;
  }
  
  const spreadCost = estimatedSpread / 2; // You only cross half the spread
  const slippageCost = 0.003; // Estimated 0.3% slippage for typical trade sizes
  
  // Total execution cost (excluding fee which is handled elsewhere)
  const executionCost = spreadCost + slippageCost;
  
  // Net edge after execution costs
  const netEdge = Math.abs(rawEdge) - executionCost;

  // Determine direction
  const direction = rawEdge > 0 ? 'BUY_YES' : 'BUY_NO';

  // Minimum executable edge: 2% for signal volume generation
  const minExecutableEdge = 0.02; // 2% minimum after costs

  return {
    rawEdge,
    netEdge,
    direction,
    isExecutable: netEdge >= minExecutableEdge,
    executionCost,
    estimatedSpread
  };
}

// Conservative structural confidence based on market microstructure & liquidity
function calculateStructuralConfidence(marketData = {}, orderBook = {}) {
  const ob = orderBook || {};
  const liquidity = Math.max(0, Number(marketData.liquidity) || 0);
  const volume = Math.max(0, Number(marketData.volume24h || marketData.volume) || 0);
  const depth = (() => {
    const bids = Array.isArray(ob.bids) ? ob.bids : [];
    const asks = Array.isArray(ob.asks) ? ob.asks : [];
    const bidDepth = bids.slice(0, 5).reduce((sum, b) => sum + (Number(b?.size) || 0), 0);
    const askDepth = asks.slice(0, 5).reduce((sum, a) => sum + (Number(a?.size) || 0), 0);
    return bidDepth + askDepth;
  })();

  // Start conservative, lift slightly with structure, cap by entropy/volatility if available
  let structural = 0.35;
  if (liquidity > 100000) structural += 0.2;
  else if (liquidity > 50000) structural += 0.12;
  else if (liquidity > 20000) structural += 0.07;

  if (volume > 50000) structural += 0.08;
  else if (volume > 10000) structural += 0.04;

  if (depth > 5000) structural += 0.08;
  else if (depth > 1000) structural += 0.04;

  const entropy = typeof marketData.entropy === 'number' ? marketData.entropy : null;
  if (entropy !== null) {
    structural -= Math.max(0, (entropy - 0.25) * 0.3);
  }

  const volatility = typeof marketData.priceVolatility === 'number' ? marketData.priceVolatility : null;
  if (volatility !== null) {
    structural -= Math.max(0, (volatility - 0.1) * 0.5);
  }

  return clamp(structural, 0.1, 0.95);
}

function getEntropy(question, daysLeft) {
  const q = (question || '').toLowerCase();
  let score = 0.3;
  if (/who|which|what|when|where|how|will|does|is|are/i.test(q)) score += 0.2;
  if (/or |vs |versus /i.test(q)) score += 0.1;
  if (/top |best |winner |champion /i.test(q)) score += 0.1;
  if (/price|above|below|over|under/i.test(q)) score += 0.1;
  const timeFactor = Math.max(0, (365 - daysLeft) / 365) * 0.2;
  score += timeFactor;
  return clamp(score, 0, 1);
}

// LLM Configuration - Support multiple providers for testing
const USE_MOCK = process.env.USE_MOCK_LLM === 'true'; // Set to true for free testing
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_BASE_URL = 'https://api.x.ai/v1';

const PROVIDER = process.env.LLM_PROVIDER
  || (OPENAI_API_KEY ? 'openai' : 'xai'); // default to OpenAI when available

// Model version fallback chains for resilience
const OPENAI_MODEL_FALLBACKS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-3.5-turbo'
];

const XAI_MODEL_FALLBACKS = [
  'grok-beta',
  'grok-2',
  'grok-1'
];

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_XAI_MODEL = process.env.XAI_MODEL || 'grok-beta';

// Get model with fallback chain
function getModelWithFallback(provider, preferredModel) {
  if (preferredModel) return preferredModel;
  
  const fallbacks = provider === 'openai' ? OPENAI_MODEL_FALLBACKS : XAI_MODEL_FALLBACKS;
  const defaultModel = provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_XAI_MODEL;
  
  // Try default first, then fallbacks
  const allModels = [defaultModel, ...fallbacks.filter(m => m !== defaultModel)];
  return allModels[0]; // Return first available (would need API validation in production)
}

const LLM_MODEL = process.env.LLM_MODEL || getModelWithFallback(PROVIDER, null);
const NEWS_DELTA_MODEL = process.env.NEWS_DELTA_MODEL || LLM_MODEL;

const llmMetrics = { total: 0, errors: 0 };
function emitLLMMetrics(event = {}) {
  const payload = {
    type: 'llm_latency',
    total_calls: llmMetrics.total,
    error_count: llmMetrics.errors,
    timestamp: new Date().toISOString(),
    ...event
  };
  console.log(JSON.stringify(payload));
}

const llmCircuitBreaker = {
  failureCount: 0,
  isOpen: false,
  openUntil: 0,
  FAILURE_THRESHOLD: 12, // Increased from 5 to give breathing room while debugging
  RESET_MS: 60000 // Reduced from 5 min to 1 min for faster recovery
};

function checkCircuitBreaker() {
  if (llmCircuitBreaker.isOpen && Date.now() < llmCircuitBreaker.openUntil) {
    return false;
  }
  if (llmCircuitBreaker.isOpen && Date.now() >= llmCircuitBreaker.openUntil) {
    llmCircuitBreaker.isOpen = false;
    llmCircuitBreaker.failureCount = 0;
    console.log('[LLM] Circuit breaker reset');
  }
  return true;
}

function recordLLMFailure() {
  llmCircuitBreaker.failureCount++;
  if (llmCircuitBreaker.failureCount >= llmCircuitBreaker.FAILURE_THRESHOLD) {
    llmCircuitBreaker.isOpen = true;
    llmCircuitBreaker.openUntil = Date.now() + llmCircuitBreaker.RESET_MS;
    console.error('[LLM] Circuit breaker opened due to repeated failures');
  }
}

function recordLLMSuccess() {
  llmCircuitBreaker.failureCount = 0;
}

let sharedLLMClient = null;
let clientInitializing = false;
let clientInitPromise = null;

async function getLLMClient() {
  if (sharedLLMClient) return sharedLLMClient;
  
  // If initialization is in progress, wait for it
  if (clientInitializing && clientInitPromise) {
    return clientInitPromise;
  }
  
  // Start initialization
  clientInitializing = true;
  clientInitPromise = (async () => {
    try {
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
    } finally {
      clientInitializing = false;
    }
  })();
  
  return clientInitPromise;
}

// Safe LLM Parse with fallback (NEW: Added to fix conf=0 bug)
function safeParseLLM(output) {
  if (!output || typeof output !== 'string') {
    console.error('[PARSE] Invalid output type:', typeof output);
    return { revised_prior: 0.5, confidence: 40, narrative: 'Parse error: invalid input' };
  }
  
  try {
    // Sanitize input to prevent injection attacks
    const sanitized = output.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
    
    // Try to extract JSON from markdown code blocks if present
    let jsonStr = sanitized;
    const codeBlockMatch = sanitized.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }
    
    // Try to find JSON object in the response
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    
    const json = JSON.parse(jsonStr);
    
    // Validate required fields
    if (typeof json.confidence === 'number' && json.confidence > 0) {
      console.log(`[PARSE] Successful JSON parse: confidence=${json.confidence}, revised_prior=${json.revised_prior}`);
      return json;
    } else if (json.revised_prior !== undefined) {
      // Has probability but missing/invalid confidence
      console.log(`[PARSE] JSON has revised_prior but invalid confidence, using default`);
      json.confidence = 50;
      return json;
    }
  } catch (e) {
    console.error('[PARSE] JSON parse failed:', e.message);
  }

  // Fallback regex if JSON fails or conf=0/missing
  const confMatch = output.match(/confidence["']?\s*[:=]?\s*(\d+)/i);
  const priorMatch = output.match(/revised_prior["']?\s*[:=]?\s*([0-9.]+)/i);
  const narrative = output.replace(/{.*}/s, '').trim() || 'Fallback narrative from parse error';

  // Try to extract sentimentScore from output
  const sentimentMatch = output.match(/sentimentScore["']?\s*[:=]?\s*([-0-9.]+)/i);
  const sentimentScore = sentimentMatch ? parseFloat(sentimentMatch[1]) : 0;

  // Try to extract newsSources from output
  let newsSources = [];
  const newsSourcesMatch = output.match(/newsSources["']?\s*[:=]\s*\[(.*?)\]/is);
  if (newsSourcesMatch) {
    try {
      newsSources = JSON.parse(`[${newsSourcesMatch[1]}]`);
      if (!Array.isArray(newsSources)) newsSources = [];
    } catch (e) {
      console.error('[PARSE] Failed to parse newsSources:', e.message);
    }
  }

  const rawConf = confMatch ? parseInt(confMatch[1]) : 40; // Conservative default
  const parsed = {
    revised_prior: priorMatch ? parseFloat(priorMatch[1]) : 0.5,
    confidence: Math.max(1, Math.min(100, rawConf)), // Enforce [1, 100]
    narrative,
    sentimentScore,
    newsSources
  };

  console.log(`[PARSE] Fallback used: confidence=${parsed.confidence}, sentimentScore=${parsed.sentimentScore}, newsSources=${parsed.newsSources.length}`);
  return parsed;
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
const RESOLUTION_FIRST_PROMPT = `First, quote exact resolution criteria from market: [insert market.resolutionCriteria]. Then, build binary checklist: 1. Condition A met? (prob) 2. Condition B? etc. Only then narrative. Base on facts, not vibes. For YES: list 2-3 bull points. For NO: 2-3 bear. End with delta vs market.`;

const ENHANCED_SYSTEM_PROMPT_TEMPLATE = `
You are Agent Zigma, a professional prediction market analyst. Today is {{todayDate}}. You are aware that Google's Gemini 3 Pro holds the #1 spot on Artificial Analysis, ahead of OpenAI's GPT-5.2 Garlic. Every trade must be cross-referenced against the BOJ Dec 19 rate hike decision (likely causing Yen Carry Trade unwind, -15% Bitcoin probability penalty) and the Trump 'Directive' vs 'Final Rule' legal framework. Reference market microstructure context: spread {{spread}}%, depth {{depth}}, liquidity score {{liquidityScore}}, recommended Kelly fraction {{kelly}}%.

MANDATORY OUTPUT SCHEMA:
{
  "revised_prior": number between 0.01 and 0.99 (YOUR probability estimate for YES outcome),
  "confidence": integer between 1 and 100 (how certain you are in this estimate),
  "reasoning": string (explain your analysis in 2-3 sentences),
  "sentimentScore": number between -1 and 1 (news sentiment),
  "newsSources": array of {"title": string, "source": string, "relevance": "high"|"medium"|"low"},
  "uncertainty": number between 0 and 1 (data quality and time risk),
  "direction": string ("OVERPRICED" if market price > your probability, "UNDERPRICED" if market price < your probability, "FAIR" if within 2%)
}

CRITICAL INSTRUCTIONS:
1. revised_prior is your ABSOLUTE probability for YES (0.01 to 0.99)
2. If market is at 60% and you think it should be 70%, return revised_prior: 0.70
3. If market is at 60% and you think it should be 40%, return revised_prior: 0.40
4. confidence is how CERTAIN you are (1-100), NOT the probability
5. Base revised_prior on: news sentiment, historical data, base rates, market inefficiencies

REAL MONEY TRADING INSTRUCTIONS (Building Track Record):
1. We are trading REAL MONEY - target 2-5% edge with 75%+ confidence for 10-15 signals per cycle
2. Markets have inefficiencies. Look for ANY mispricing (2-5% difference)
3. If evidence supports YES, output probability 2-5% HIGHER than market price
4. If evidence supports NO, output probability 2-5% LOWER than market price
5. Recommend trades with 75%+ confidence - we need volume to build track record
6. Calculate independent probability from evidence - avoid market anchoring

Edge Detection Rules (2-5% target):
- Recommend if market is mispriced by 2%+ with reasonable confidence
- Look for: stale prices, news not reflected, data-driven miscalculations, structural edges
- Sports: injuries/lineup changes not priced, schedule strength, playoff math, recent form
- Crypto: technical breakouts, fundamental catalysts, on-chain data, sentiment shifts
- Politics: polling updates, structural advantages, historical base rates, demographic shifts
- Macro: Fed data, economic indicators, policy changes, market expectations
- Require 75%+ confidence - if uncertain, output confidence < 75 and we skip the trade
- Focus on SHORT-TERM markets (<6 months) with clear resolution criteria

CALIBRATION EXAMPLES:
Example 1: "Will Bitcoin reach $100k in 2026?" (Bitcoin already at $95k in Jan 2026)
- Market: 83% YES
- Analysis: Strong momentum, near target, favorable macro
- Output: revised_prior: 0.85, confidence: 75, direction: "UNDERPRICED"
- Reasoning: Already close to target with 11 months remaining

Example 2: "Will Team X win championship?" (1 of 32 teams)
- Market: 8% YES (overpriced vs 3.1% base rate)
- Analysis: Recent injuries, tough schedule
- Output: revised_prior: 0.02, confidence: 70, direction: "OVERPRICED"
- Reasoning: Market inefficiency detected, strong edge

Example 3: "Will Governor win re-election in California?"
- Market: 72% YES
- Analysis: Incumbent advantage in blue state, strong polling
- Output: revised_prior: 0.78, confidence: 75, direction: "UNDERPRICED"
- Reasoning: Historical base rate 70% + incumbent boost

Example 4: "Will the Knicks make the NBA Playoffs?" (Strong team, good record)
- Market: 97.8% YES
- Analysis: Top of conference, strong roster, favorable schedule
- Output: revised_prior: 0.95, confidence: 80, direction: "FAIR"
- Reasoning: Near-certain based on current standing and historical data

ANALYSIS STEPS:
Step 1: Calculate base rate prior (historical YES rate for this category)
Step 2: Analyze news headlines for bullish/bearish signals
Step 3: Adjust base rate by news sentiment (max Â±20%)
Step 4: Compare to market price - if significantly different, explain why
Step 5: Set confidence based on evidence quality (high evidence = high confidence)

CRITICAL LEGAL ANALYST: You are a Legal Analyst. If a market asks if a federal regulation will change, you MUST factor in the Administrative Procedure Act (APA). A Presidential Executive Order is an INTENT, not a RESOLUTION. Finalizing a Schedule III reclassification requires a 'Final Rule' in the Federal Register. If today is Dec 18 and the market ends Dec 31, a 99% probability is a HALLUCINATION.

You MUST analyze the provided news headlines and return:
1. sentimentScore: Calculate based on news sentiment (-1 to 1)
2. newsSources: Extract 3-5 most relevant news items with title, source, and relevance

RESPONSE MUST BE STRICT JSON ONLY. NO PROSE. NO MARKDOWN BLOCKS. NO ADDITIONAL TEXT. ONLY THE JSON OBJECT AS SHOWN ABOVE.
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
    .replace('{{kelly}}', context.kelly ?? 'N/A')
    .replace('[insert market.resolutionCriteria]', context.resolutionCriteria ?? 'No resolution criteria available.');
}

const BASIC_SYSTEM_PROMPT = `You are the Agent Zigma â€” a neutral, analytical observer of prediction market price and volume movement. Your purpose is to summarize market movement and liquidity signals; you must NOT make forecasts, probabilities, or predictions about future outcomes. Use only data provided in the input. Output short, factual, consistent lines that are easily readable on X and in an on-chain Deep Dive.

Rules:
- Do NOT predict future outcomes.
- Do NOT invent facts.
- Reference provided metrics only (yesPrice, noPrice, volume, liquidity, lastPrice, priceChange).
- Keep the X tweet <= 280 characters. The Deep Dive can be longer (200-400 words).
- Prefer concise bullet-style sentences for X, and a multi-paragraph expanded explanation for the Deep Dive.

Output formats:
- X (tweet): A single line that starts with an emoji status (e.g., ðŸŸ¢/ðŸŸ¡/ðŸ”´), a one-sentence title (market), then 1-2 fact phrases (e.g., "YES up 9.6% in 1h | Volume spike: $1.2M"). End with Polymarket link.
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

  // Calculate base rate prior for context
  const baseRatePrior = calculateBaseRatePrior(marketData);
  const historicalContext = getHistoricalContext(marketData, baseRatePrior);

  return `You are a professional Polymarket analyst. You must return STRICT JSON ONLY (no markdown) that matches this schema:
{
  "revised_prior": number between 0 and 1 (your probability estimate for YES outcome),
  "delta": number between -0.20 and 0.20 (difference from market price, for reference),
  "confidence": number between 1 and 100 (your confidence in this revised_prior as an integer),
  "narrative": string (brief explanation of your reasoning, including how news influenced the revised_prior),
  "sentimentScore": number between -1 and 1 (overall sentiment from news headlines, -1 negative, 0 neutral, 1 positive),
  "newsSources": array of objects with "title", "source", "date", "url" (if available), and "relevance" (high/medium/low)
}
Always include "confidence": 1-100 integer in JSON. Output your revised_prior (0 to 1) as your probability estimate for YES outcome.

CRITICAL: You MUST analyze the provided news headlines and return:
1. sentimentScore: Calculate based on news sentiment (-1 to 1)
2. newsSources: Extract 3-5 most relevant news items with title, source, date, and relevance

Context for your assessment:
MARKET DATA:
${marketJson}

Current YES market price: ${marketData.yesPrice} (THIS IS THE MOST RELIABLE SIGNAL - thousands of traders have analyzed this market)
Historical base rate prior: ${baseRatePrior} (Use as a starting point, but TRUST THE MARKET PRICE if it's significantly different)

HISTORICAL CONTEXT:
${historicalContext}

ANALYSIS METRICS:
${analysisJson}

ORDER BOOK DATA:
${orderBookJson}

RECENT NEWS HEADLINES:
${newsText}

CRITICAL INSTRUCTIONS:
1. The market price (${marketData.yesPrice}) reflects the wisdom of thousands of traders with real money at stake
2. If the market price is >80%, your revised_prior should be in the 75-95% range unless you have VERY strong evidence otherwise
3. If the market price is >90%, your revised_prior should be in the 85-98% range unless you have EXTREMELY strong evidence otherwise
4. Historical base rates are just starting points - the market knows more than historical averages
5. DO NOT be overly conservative - the market is usually right

CRITICAL WARNING: News headlines may contain outdated or incorrect probability estimates (e.g., "43% chance"). DO NOT trust these numbers. The current market price (${marketData.yesPrice}) reflects the most up-to-date information from thousands of traders. Base your revised_prior on the market price, historical base rates, and qualitative news sentiment, NOT on any percentage numbers mentioned in news headlines.

Instructions:
- First, provide the strongest argument for YES outcome.
- Second, provide the strongest argument for NO outcome.
- Then, considering both arguments, estimate the revised_prior probability (between 0 and 1) for the YES outcome.
- Compare the market price (${marketData.yesPrice}) to the historical base rate (${baseRatePrior}). If they differ significantly, explain why in your narrative.
- Consider historical base rates, state-specific political leanings, and incumbent advantages if applicable.
- Provide confidence score based on evidence strength (e.g., high for credible news, low for speculative).
- Confidence: integer 1-100; explain why.
- Keep narrative concise (<100 words), citing specific news or data points.
- Extract 3-5 most relevant news sources with titles, sources, dates, and relevance levels.

Return ONLY the JSON objectâ€”no prose or extra text.`;
}

// Calculate base rate prior for LLM context
// Enhanced with sophisticated adjustments for:
// - Incumbent advantage (12% boost based on political science research)
// - Home-field advantage (8% boost for sports teams)
// - Crypto ATH bias correction (15% reduction for recency bias)
// - Momentum bias correction (10% reduction for overreactions)
// - Anti-incumbent environments (12% reduction when applicable)
function calculateBaseRatePrior(marketData) {
  const question = marketData.question || '';
  const q = question.toLowerCase();

  // Historical category base rates (YES resolution rates)
  const CATEGORY_BASE_RATES = {
    'CRYPTO': 0.55, // Increased from 0.42 - crypto markets are more efficient
    'POLITICS': 0.55, // Increased from 0.48 - polling data is reliable
    'SPORTS': 0.35,
    'SPORTS_FUTURES': 0.50, // Increased from 0.35 - playoffs are more predictable
    'SPORTS_PLAYER': 0.32,
    'MACRO': 0.50, // Increased from 0.44
    'ECONOMY': 0.50, // Increased from 0.44
    'ETF_APPROVAL': 0.55,
    'TECH_ADOPTION': 0.50, // Increased from 0.46
    'TECH': 0.50, // Increased from 0.46
    'ENTERTAINMENT': 0.50,
    'CELEBRITY': 0.40,
    'EVENT': 0.50,
    'OTHER': 0.50
  };

  // Detect NFL teams (32 teams = 3.1% base rate)
  if (/win the (super bowl|afc championship|nfc championship)/i.test(q)) {
    return 0.031;
  }

  // Detect NBA teams (30 teams = 3.3% base rate)
  if (/win the nba championship/i.test(q)) {
    return 0.033;
  }

  // Detect NBA playoffs (much higher base rate than winning championship)
  if (/make the (nba|playoffs)/i.test(q)) {
    return 0.65; // ~65% of teams make playoffs (20 of 30)
  }

  // Detect MLB teams (30 teams = 3.3% base rate)
  if (/win the (world series|mlb championship)/i.test(q)) {
    return 0.033;
  }

  // Detect MLB playoffs
  if (/make the (mlb|playoffs)/i.test(q)) {
    return 0.65;
  }

  // Detect NHL teams (32 teams = 3.1% base rate)
  if (/win the (stanley cup|nhl championship)/i.test(q)) {
    return 0.031;
  }

  // Detect Premier League teams (20 teams = 5% base rate)
  if (/win the (premier league|epl)/i.test(q)) {
    return 0.05;
  }

  // Detect binary elections (2 main candidates = 50% base rate)
  if (/win the (2024|2025|2026|2028) (presidential|election)/i.test(q)) {
    return 0.5;
  }

  // Detect state governor races - use state-specific priors
  if (/win the (governor|governorship) in (2024|2025|2026|2028)/i.test(q)) {
    const stateMatch = q.match(/(?:in|for) ([a-z]+) (?:governor|governorship)/i);
    if (stateMatch) {
      const state = stateMatch[1].toLowerCase();
      const STATE_POLITICAL_PRIORS = {
        'idaho': 0.99,
        'south dakota': 0.99,
        'wyoming': 0.99,
        'north dakota': 0.98,
        'utah': 0.95,
        'oklahoma': 0.95,
        'arkansas': 0.95,
        'kansas': 0.93,
        'nebraska': 0.93,
        'alabama': 0.92,
        'mississippi': 0.92,
        'tennessee': 0.92,
        'kentucky': 0.90,
        'louisiana': 0.90,
        'rhode island': 0.80,
        'massachusetts': 0.85,
        'maryland': 0.80,
        'hawaii': 0.90,
        'vermont': 0.85,
        'new york': 0.75,
        'california': 0.70,
        'illinois': 0.70,
        'washington': 0.70,
        'oregon': 0.70,
        'connecticut': 0.75,
        'delaware': 0.75,
        'pennsylvania': 0.55,
        'michigan': 0.55,
        'wisconsin': 0.55,
        'arizona': 0.52,
        'georgia': 0.52,
        'nevada': 0.52,
        'north carolina': 0.50,
        'florida': 0.48,
        'texas': 0.45,
        'ohio': 0.48,
      };
      if (STATE_POLITICAL_PRIORS[state]) {
        return STATE_POLITICAL_PRIORS[state];
      }
    }
  }

  // Detect multi-candidate events
  const teamMatch = q.match(/(\d{1,2}) (teams|candidates|options)/i);
  if (teamMatch) {
    const count = parseInt(teamMatch[1]);
    if (count > 0 && count <= 100) {
      return 1 / count;
    }
  }

  // Category-based priors as fallback
  const category = (marketData.category || '').toUpperCase();
  let prior = CATEGORY_BASE_RATES.OTHER; // Default 50% for unknown markets

  if (category && CATEGORY_BASE_RATES[category] != null) {
    prior = CATEGORY_BASE_RATES[category];
  } else {
    // Fuzzy category detection from question text
    if (/bitcoin|ethereum|btc|eth|crypto|solana|bnb|ada|doge/i.test(q)) {
      prior = CATEGORY_BASE_RATES.CRYPTO;
    } else if (/recession|inflation|fed|fed rate|gdp|unemployment|economy|macro/i.test(q)) {
      prior = CATEGORY_BASE_RATES.MACRO;
    } else if (/election|president|trump|biden|senate|congress|political|government/i.test(q)) {
      prior = CATEGORY_BASE_RATES.POLITICS;
    } else if (/grammy|oscar|emmy|award|nomination/i.test(q)) {
      prior = CATEGORY_BASE_RATES.ENTERTAINMENT;
    }
  }

  // CRITICAL: Adjust for Bitcoin price targets when already close to target
  if (/bitcoin|btc/i.test(q) && /reach.*\$[\d,]+k|hit.*\$[\d,]+k|above.*\$[\d,]+k/i.test(q)) {
    const priceMatch = q.match(/[\$]?([\d,]+)k/i);
    if (priceMatch) {
      const targetPrice = parseInt(priceMatch[1].replace(',', '')) * 1000;
      // If target is $100k or less and we're in 2026, probability should be high
      // Bitcoin is currently around $100k+ in January 2026
      if (targetPrice <= 120000) {
        prior = Math.max(prior, 0.75); // At least 75% if target is $120k or less
      }
    }
  }

  // Sophisticated adjustments to base rate prior
  
  // Incumbent advantage detection (political science standard: ~12% boost)
  if (/incumbent|re-election|seeking re-election|running for re-election/i.test(q)) {
    prior *= 1.12;
    prior = Math.min(prior, 0.95); // Cap at 95% to avoid extreme values
  }

  // Home-field advantage for sports (8% boost based on sports analytics)
  if (/home|at home|home field|home court|home ice/i.test(q) && 
      (category === 'SPORTS' || category === 'SPORTS_FUTURES' || category === 'SPORTS_PLAYER' ||
       /football|basketball|baseball|hockey|soccer|game|match|win|beat|defeat/i.test(q))) {
    prior *= 1.08;
    prior = Math.min(prior, 0.95); // Cap at 95%
  }

  // Recency bias correction for crypto (markets overestimate continuation after ATH)
  if ((category === 'CRYPTO' || /bitcoin|ethereum|btc|eth|crypto|solana|bnb|ada|doge/i.test(q)) && 
      /all-time high|ath|new high|record high|hit \$[0-9]+k|reached \$[0-9]+/i.test(q)) {
    prior *= 0.85; // Markets tend to overestimate continuation after new highs
  }

  // Momentum bias correction (markets overreact to recent trends)
  if (/surge|spike|soar|skyrocket|plummet|crash|collapse|boom|burst/i.test(q)) {
    prior *= 0.90; // Slight correction for momentum overreaction
  }

  // Incumbent disadvantage in anti-establishment environments
  if (/incumbent|re-election/i.test(q) && 
      (/anti-incumbent|anti-establishment|throw the bums out|change|time for change/i.test(q) ||
       /approval rating.*below.*40|unpopular.*incumbent/i.test(q))) {
    prior *= 0.88; // Reduce incumbent advantage in hostile environment
  }

  // Ensure prior stays within reasonable bounds
  prior = Math.max(0.01, Math.min(prior, 0.99));
  
  return prior;
}

// Get historical context for LLM
function getHistoricalContext(marketData, baseRatePrior) {
  const question = marketData.question || '';
  const q = question.toLowerCase();
  let context = [];

  // Political context
  if (/governor|governorship/i.test(q)) {
    const stateMatch = q.match(/(?:in|for) ([a-z]+) (?:governor|governorship)/i);
    if (stateMatch) {
      const state = stateMatch[1].toLowerCase();
      context.push(`State: ${state.toUpperCase()} - Historical win rate for majority party: ${(baseRatePrior * 100).toFixed(0)}%`);
      
      if (baseRatePrior > 0.90) {
        context.push(`This is a solid ${state.toUpperCase()} state - the majority party has won >90% of recent elections`);
      } else if (baseRatePrior > 0.70) {
        context.push(`This is a leaning ${state.toUpperCase()} state - the majority party typically wins`);
      } else {
        context.push(`This is a competitive ${state.toUpperCase()} state - elections are often close`);
      }

      if (/incumbent|re-election|running for re-election/i.test(q)) {
        context.push(`Incumbent advantage: Governors running for re-election typically have a 10-15% boost in win rate`);
      }
      
      // Anti-incumbent context
      if (/incumbent|re-election/i.test(q) && 
          (/anti-incumbent|anti-establishment|throw the bums out|change|time for change/i.test(q) ||
           /approval rating.*below.*40|unpopular.*incumbent/i.test(q))) {
        context.push(`Anti-incumbent environment: Incumbent advantage may be reduced due to political climate or low approval ratings`);
      }
    }
  }

  // General incumbent advantage context
  if (/incumbent|re-election|seeking re-election/i.test(q)) {
    context.push(`Incumbent advantage: Historical data shows incumbents typically have a 10-15% higher win rate due to name recognition, fundraising advantages, and institutional support`);
  }

  // Sports home-field advantage context
  if (/home|at home|home field|home court|home ice/i.test(q) && 
      (/football|basketball|baseball|hockey|soccer|game|match|win|beat|defeat/i.test(q))) {
    context.push(`Home-field advantage: Teams playing at home historically win ~8% more often due to crowd support, travel fatigue for opponents, and familiarity with the venue`);
  }

  // Crypto ATH context
  if ((/bitcoin|ethereum|btc|eth|crypto|solana|bnb|ada|doge/i.test(q)) && 
      /all-time high|ath|new high|record high|hit \$[0-9]+k|reached \$[0-9]+/i.test(q)) {
    context.push(`ATH bias correction: Crypto markets tend to overestimate continuation after all-time highs - historical data shows mean reversion is common after new peaks`);
  }

  // Momentum bias context
  if (/surge|spike|soar|skyrocket|plummet|crash|collapse|boom|burst/i.test(q)) {
    context.push(`Momentum bias: Markets often overreact to recent dramatic price movements - applying correction for potential mean reversion`);
  }

  // Sports context
  if (/win the (super bowl|nba championship|world series|stanley cup)/i.test(q)) {
    context.push(`Championship markets are highly competitive - even favorites often lose due to single-elimination format`);
  }

  // Entertainment context
  if (/grammy|oscar|emmy/i.test(q)) {
    context.push(`Award markets depend on critical reception and industry trends - early favorites can be upset`);
  }

  return context.join('. ');
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
      const mockXDecree = `ðŸŸ¢ ${topMarket.question?.substring(0, 50) || 'Market'}: YES up ${(Math.random() * 10).toFixed(1)}% | Volume: $${(Math.random() * 1000000).toLocaleString()} | Polymarket link`;

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
        temperature: 0.7
      });
    } else {
      // XAI provider logic here if needed
    }

    const content = response.choices[0].message.content.trim();
    const [xDecreePart, deepDivePart] = content.split('Deep Dive:');
    const xDecree = xDecreePart.replace('X Decree:', '').trim();
    const deepDiveJson = deepDivePart.trim();

    let deepDive;
    try {
      deepDive = JSON.parse(deepDiveJson);
    } catch (e) {
      console.error('Failed to parse deep dive JSON:', e);
      deepDive = [];
    }

    return { xDecree, deepDive };
  } catch (error) {
    console.error('Error generating decrees:', error);
    return { xDecree: 'Error generating market update', deepDive: [] };
  }
}

// Main enhanced analysis function
async function generateEnhancedAnalysis(marketData) {
  function getEntropy(question, daysLeft) {
    let entropy = 0.1; // base
    const q = question.toLowerCase();
    if (/politics|election/i.test(q)) entropy += 0.3;
    if (/war|ceasefire/i.test(q)) entropy += 0.4;
    if (/celebrity/i.test(q)) entropy += 0.2;
    if (daysLeft > 365) entropy += 0.2;
    return Math.min(entropy, 0.8);
  }
  const analysis = getMarketAnalyzer(marketData);
  const orderBook = getOrderBook(marketData.conditionId);
  const newsResults = await crossReferenceNews(marketData);
  const news = newsResults.slice(0, 5).map(r => ({title: r.title, snippet: r.snippet}));
  console.log(`Headlines found: ${news.length}`);
  console.log(`NEWS for ${marketData.question}: ${news.map(n => n.title).join(' | ')}`);

  const spreadPercentage = orderBook ? (parseFloat(orderBook.asks[0]?.price || 0) - parseFloat(orderBook.bids[0]?.price || 0)) * 100 : 0;
  const depth = orderBook ?
    (orderBook.bids?.slice(0, 10).reduce((sum, b) => sum + (parseFloat(b.size) || 0), 0) || 0) +
    (orderBook.asks?.slice(0, 10).reduce((sum, a) => sum + (parseFloat(a.size) || 0), 0) || 0)
  : 0;
  const liquidityScore = spreadPercentage > 0 ? Math.max(0, Math.round(100 - spreadPercentage * 2)) : 50; // Simple score
  // Kelly calculation: (prob, price, edge, liquidity)
  // Use market price as both prob and price for initial structural estimate
  const marketPriceForKelly = marketData.yesPrice || 0.5;
  const kellyFraction = calculateKelly(marketPriceForKelly, marketPriceForKelly, 0, marketData.liquidity || 10000);

  // Generate LLM prompt
  const systemPrompt = buildEnhancedSystemPrompt({
    spread: Number.isFinite(spreadPercentage) ? spreadPercentage.toFixed(2) : 'N/A',
    depth: Number.isFinite(depth) ? depth.toFixed(0) : 'N/A',
    liquidityScore: Number.isFinite(liquidityScore) ? liquidityScore : 'N/A',
    kelly: Number.isFinite(kellyFraction) ? (kellyFraction * 100).toFixed(1) : 'N/A',
    resolutionCriteria: marketData.description || 'No resolution criteria available.'
  });
  const userPrompt = buildEnhancedAnalysisPrompt(marketData, analysis, orderBook || {}, news);

  const client = await getLLMClient();
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
        // PATCH: Increase max_tokens to prevent truncation
        max_tokens: 2000,  // INCREASED from 800
        temperature: 0,
        // PATCH: Add response_format for reliable JSON
        response_format: { type: "json_object" }
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const llmStart = Date.now();
  llmMetrics.total += 1;
  let llmOk = false;
  
  // Enhanced fallback analysis using available data (shared between circuit breaker and LLM failures)
  const getEnhancedFallback = (reason) => {
    // Use base rate prior, not market price, to avoid zero-edge markets
    const basePrior = calculateBaseRatePrior(marketData);
    let fallbackProbability = basePrior;
    let fallbackReasoning = reason;

    // Use news sentiment if available
    if (news && news.length > 0) {
      try {
        const sentimentAnalysis = calculateAggregateSentiment(news);
        const sentimentScore = sentimentAnalysis.score;

        // Adjust probability based on sentiment
        // Positive sentiment = more likely YES, Negative = more likely NO
        const sentimentAdjustment = sentimentScore * 0.1; // Max Â±10% adjustment
        fallbackProbability = Math.max(0.05, Math.min(0.95, basePrior + sentimentAdjustment));

        fallbackReasoning += `. News sentiment: ${sentimentScore > 0.3 ? 'bullish' : sentimentScore < -0.3 ? 'bearish' : 'neutral'} (${sentimentScore.toFixed(2)})`;
      } catch (e) {
        console.error('Sentiment analysis failed in fallback:', e);
      }
    }

    // Use market structure for additional insights
    const liquidityUsd = Number(marketData.liquidity) || 0;
    const spread = orderBook ? (parseFloat(orderBook.asks[0]?.price || 0) - parseFloat(orderBook.bids[0]?.price || 0)) * 100 : 0;

    let liquidityAssessment = 'moderate';
    if (liquidityUsd < 20000) liquidityAssessment = 'low';
    else if (liquidityUsd > 100000) liquidityAssessment = 'high';

    fallbackReasoning += `. Liquidity: ${liquidityAssessment} ($${(liquidityUsd/1000).toFixed(0)}k)`;

    // Calculate action based on fallback probability
    const daysLeft = marketData.endDateIso
      ? (new Date(marketData.endDateIso) - Date.now()) / (1000 * 60 * 60 * 24)
      : 365;

    const threshold = Math.max(0.03, 0.05 - (liquidityUsd >= 50000 ? 0.01 : 0));
    let fallbackAction = 'HOLD';
    if (fallbackProbability > basePrior + threshold) fallbackAction = 'BUY YES';
    else if (fallbackProbability < basePrior - threshold) fallbackAction = 'BUY NO';

    // Calculate confidence based on data quality
    let fallbackConfidence = 50;
    if (news && news.length > 0) fallbackConfidence += 10;
    if (liquidityUsd > 50000) fallbackConfidence += 5;
    if (spread < 0.02) fallbackConfidence += 5;

    // Calculate edge for fallback
    const fallbackEdge = fallbackProbability - (marketData.yesPrice || 0.5);
    const fallbackNetEdge = Math.max(0, Math.abs(fallbackEdge) - 0.01); // Account for spread
    
    return {
      marketId: marketData.id,
      question: marketData.question,
      confidence: fallbackConfidence,
      action: fallbackAction,
      probability: fallbackProbability,
      originalProbability: fallbackProbability,
      adjustedProbability: fallbackProbability,
      revised_prior: fallbackProbability,
      reasoning: fallbackReasoning,
      sentimentScore: news && news.length > 0 ? Math.max(-1, Math.min(1, (fallbackProbability - basePrior) * 5)) : 0,
      uncertainty: 0.5,
      generatedAt: Date.now(),
      fallback: true,
      kellyFraction: 0.01, // Conservative for fallback
      baseEffectiveEdge: fallbackNetEdge * 100,
      effectiveEdge: fallbackNetEdge * 100,
      entropy: 0.5,
      edge: {
        raw: fallbackEdge,
        rawPercent: fallbackEdge * 100,
        net: fallbackNetEdge,
        netPercent: fallbackNetEdge * 100,
        direction: fallbackEdge > 0 ? 'BUY_YES' : 'BUY_NO',
        isExecutable: fallbackNetEdge >= 0.01
      }
    };
  };

  // Declare newsDeltaResult outside try block for proper scope
  let newsDeltaResult = 0;

  try {
    if (!checkCircuitBreaker()) {
      console.warn(`[LLM] Circuit breaker is open, using enhanced fallback for ${marketData.id}`);
      return getEnhancedFallback('LLM circuit breaker open - using enhanced fallback analysis');
    }

    console.log(`[LLM] Starting API call for ${marketData.id}`);
    
    // Execute news delta computation in parallel with main LLM call to prevent stale data
    const [llmResponse, newsDeltaResultValue] = await Promise.all([
      llmCall(),
      (async () => {
        if (news.length === 0) return 0;
        try {
          const newsSummary = news.map(n => n.title + ' ' + n.snippet).join('\n').substring(0, 1000);
          const deltaPrompt = `Based ONLY on the provided news summary, does it make the YES outcome more likely (+), less likely (-), or neutral (0) compared to current market odds? Respond with only: +X%, -X%, or 0% where X is 5-20.\n\nNews summary:\n${newsSummary}`;
          const deltaResponse = await client.chat.completions.create({
            model: NEWS_DELTA_MODEL,
            messages: [{ role: 'user', content: deltaPrompt }],
            max_tokens: 20,
            temperature: 0
          });
          const deltaText = deltaResponse.choices[0].message.content.trim();
          if (deltaText === '0%') {
            return 0;
          } else if (deltaText.startsWith('+')) {
            const num = parseFloat(deltaText.replace('+', '').replace('%', ''));
            return isNaN(num) ? 0 : Math.min(num, 20) / 100;
          } else if (deltaText.startsWith('-')) {
            const num = parseFloat(deltaText.replace('-', '').replace('%', ''));
            return isNaN(num) ? 0 : -Math.min(num, 20) / 100;
          }
          return 0;
        } catch (e) {
          console.error('News delta computation failed:', e);
          return 0;
        }
      })()
    ]);
    
    newsDeltaResult = newsDeltaResultValue;
    response = llmResponse;
    llmOk = true;
    recordLLMSuccess();
    console.log(`[LLM] API call completed for ${marketData.id}`);
  } catch (error) {
    recordLLMFailure();
    llmMetrics.errors += 1;
    emitLLMMetrics({
      ok: false,
      marketId: marketData.id,
      llm_latency_ms: Date.now() - llmStart,
      provider: PROVIDER,
      model: LLM_MODEL,
      error: error.message
    });
    console.error(`[LLM] API call failed for ${marketData.id}: ${error.message}`);
    console.error(`[LLM] Error stack: ${error.stack}`);
    console.error(`[LLM] Client type: ${typeof sharedLLMClient}, has chat: ${!!sharedLLMClient?.chat}, has completions: ${!!sharedLLMClient?.chat?.completions}`);

    return getEnhancedFallback('LLM call failed - using enhanced fallback analysis');
  }

  emitLLMMetrics({
    ok: llmOk,
    marketId: marketData.id,
    llm_latency_ms: Date.now() - llmStart,
    provider: PROVIDER,
    model: LLM_MODEL
  });

  let llmAnalysis = response?.choices?.[0]?.message?.content || '{}';
  const newsDelta = newsDeltaResult ?? 0;

  console.log('LLM Response:', llmAnalysis);
  console.log('News Delta:', newsDelta);

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const result = safeParseLLM(llmAnalysis);
    const ensureNumber = (value, fallback = 0) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const parsed = parseFloat(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return fallback;
    };

    // Extract probability (revised_prior) from LLM - TRUST LLM's value but validate
    let rawLlmProb = ensureNumber(result.revised_prior, null);
    
    // Validate LLM probability is reasonable
    if (rawLlmProb === null || rawLlmProb <= 0 || rawLlmProb >= 1) {
      // LLM returned invalid probability, use market price as fallback
      console.log(`[WARNING] Invalid LLM probability: ${rawLlmProb}, falling back to market price`);
      rawLlmProb = marketData.yesPrice || 0.5;
    }
    
    // Check for extreme divergence from market (potential hallucination)
    const marketPrice = marketData.yesPrice || 0.5;
    const divergence = Math.abs(rawLlmProb - marketPrice);
    if (divergence > 0.4) {
      // LLM probability diverges >40% from market - likely hallucination
      // Dampen towards market price
      console.log(`[WARNING] Large divergence (${(divergence * 100).toFixed(1)}%) from market - dampening`);
      rawLlmProb = marketPrice + (rawLlmProb - marketPrice) * 0.5; // 50% dampen
    }
    
    const llmProbability = clamp(rawLlmProb, 0.01, 0.99);

    // Extract confidence (certainty) from LLM - normalize to 0-1 scale
    let llmConfidence = result.confidence;
    if (typeof llmConfidence === 'number' && Number.isFinite(llmConfidence)) {
      if (llmConfidence > 1) {
        // Confidence is in percentage (1-100), convert to decimal
        llmConfidence = Math.min(100, Math.max(1, llmConfidence)) / 100;
      } else if (llmConfidence > 0) {
        // Already in decimal scale (0-1), ensure bounds
        llmConfidence = Math.min(1, Math.max(0.01, llmConfidence));
      } else {
        // Zero or negative - invalid, use conservative default
        console.log(`[WARNING] Invalid LLM confidence: ${llmConfidence}, using 0.4`);
        llmConfidence = 0.4;
      }
    } else {
      // Non-numeric - use conservative default
      console.log(`[WARNING] Non-numeric LLM confidence: ${typeof llmConfidence}, using 0.4`);
      llmConfidence = 0.4; // Conservative default (was 0.5)
    }

    // Extract sentiment score from LLM result or calculate from news
    let sentimentScore = result.sentimentScore || 0;
    if (news && news.length > 0 && sentimentScore === 0) {
      const sentimentAnalysis = calculateAggregateSentiment(news);
      sentimentScore = sentimentAnalysis.score;
    }

    // DO NOT recalculate probability - trust LLM's revised_prior
    const winProb = llmProbability;

    // Sentiment adjustment - ONLY for position sizing, NOT for edge calculation
    // Guard: only apply if sentiment is strong AND consistent across multiple sources
    let adjustedWinProb = winProb;
    const strongSentiment = Math.abs(sentimentScore) > 0.6;
    const sufficientSources = news.length >= 3;
    const sentimentConsistent = news.length > 0 && 
      news.filter(n => {
        const text = ((n.title || '') + ' ' + (n.snippet || '')).toLowerCase();
        const positive = /surge|rise|gain|bullish|positive|win|success/i.test(text);
        const negative = /fall|drop|crash|bearish|negative|lose|fail/i.test(text);
        return (sentimentScore > 0 && positive) || (sentimentScore < 0 && negative);
      }).length >= Math.ceil(news.length * 0.6); // 60% of sources must agree
    
    if (strongSentiment && sufficientSources && sentimentConsistent) {
      const sentimentAdjustment = sentimentScore * 0.015; // Max ±1.5% adjustment
      adjustedWinProb = Math.max(0.01, Math.min(0.99, winProb + sentimentAdjustment));
      console.log(`[SENTIMENT] Applied ${(sentimentAdjustment * 100).toFixed(2)}% adjustment (score=${sentimentScore.toFixed(2)}, sources=${news.length})`);
    }

    // Calculate edge with spread and fee adjustments
    const pMarket = marketData.yesPrice || 0.5;
    const edgeAnalysis = computeNetEdge(winProb, pMarket, orderBook || {}); // Use RAW probability for edge
    const rawEdge = edgeAnalysis.rawEdge;
    const netEdge = edgeAnalysis.netEdge; // Use net edge consistently throughout
    const direction = edgeAnalysis.direction;

    // Set action based on direction
    let action = 'HOLD';
    if (netEdge >= 0.01) { // Use netEdge for execution decision (1% minimum)
      action = direction === 'BUY_YES' ? 'BUY YES' : 'BUY NO';
    }

    // Position sizing - use RAW probability, not sentiment-adjusted
    // Kelly formula: f* = (bp - q) / b where b=odds, p=win prob, q=1-p
    const baseKelly = calculateKelly(winProb, pMarket, 0.01, marketData.liquidity || 10000);
    const exposure = Math.min(0.05, Math.max(0, baseKelly));

    // Calculate entropy for additional context
    const entropyAnalysis = calculateMarketEntropy(marketData, {
      endDate: marketData.endDateIso || marketData.endDate,
      outcomes: marketData.outcomePrices || marketData.prices || []
    });
    const entropy = entropyAnalysis.entropy;

    // Calculate absolute edge and confidence score
    const absEdge = Math.abs(rawEdge);
    const confidenceScore = llmConfidence;

    // Classify market category for adaptive learning
    const category = classifyMarket(marketData.question);

    // Determine trade tier based on exposure
    let tier = 'SCOUT';
    if (exposure >= 0.04) tier = 'STRONG_TRADE';
    else if (exposure >= 0.02) tier = 'SMALL_TRADE';
    else if (exposure >= 0.005) tier = 'PROBE';

    // Apply adaptive learning (single source of confidence adjustment)
    const adaptiveLearning = applyAdaptiveLearning(category, action, absEdge, confidenceScore * 100);
    const adjustedEdge = adaptiveLearning.adjustedEdge;
    const adjustedConfidence = adaptiveLearning.adjustedConfidence;
    const finalConfidence = adjustedConfidence;

    // Entropy discount removed - trust LLM's edge but use netEdge for consistency
    const entropyDiscountedEdge = netEdge; // Use netEdge instead of adjustedEdge

    let reasoning = result.narrative || 'No detailed reasoning from LLM.';
    reasoning += ` | Conviction Tier: ${tier} | Revised Prior: ${adjustedWinProb.toFixed(3)} (${category}) | Suggested Exposure: ${(exposure * 100).toFixed(0)}% bankroll.`;
    reasoning += ` | Entropy: ${(entropy * 100).toFixed(1)}% (${entropyAnalysis.uncertaintyLevel})`;
    reasoning += ` | Sentiment: ${sentimentScore > 0.1 ? 'POSITIVE' : sentimentScore < -0.1 ? 'NEGATIVE' : 'NEUTRAL'} (${(sentimentScore * 100).toFixed(1)}%)`;
    
    // Add sentiment adjustment to reasoning if applied - reduced adjustment
    if (Math.abs(sentimentScore) > 0.5 && news.length >= 5) {
      const sentimentAdjustment = sentimentScore * 0.02; // Reduced adjustment
      reasoning += ` | Sentiment adjustment: ${(sentimentAdjustment * 100).toFixed(1)}%`;
    }
    if (adaptiveLearning.sampleSize >= 20) {
      reasoning += ` | Adaptive Learning: ${adaptiveLearning.message}`;
    }
    // Calibration removed to avoid double confidence dampening

    const baseEffectiveEdge = Number((netEdge * 100).toFixed(2)); // Use netEdge for consistency

    // Calculate factor breakdown for display
    // deltaNews: Impact from news sentiment (-0.2 to +0.2)
    const deltaNews = sentimentScore !== 0 ? sentimentScore * 0.15 : 0; // Scale sentiment to ±15%
    
    // deltaStructure: Market structure quality based on liquidity and spread
    const liquidityUsd = Number(marketData.liquidity) || 0;
    const spreadCost = edgeAnalysis.spreadCost || 0.01;
    let deltaStructure = 0;
    if (liquidityUsd > 100000 && spreadCost < 0.015) {
      deltaStructure = 0.05; // Good structure
    } else if (liquidityUsd < 20000 || spreadCost > 0.03) {
      deltaStructure = -0.05; // Poor structure
    }
    
    // deltaBehavior: Behavioral mispricing (difference between LLM and market)
    const deltaBehavior = rawEdge; // Use raw edge as behavioral signal
    
    // deltaTime: Time decay factor based on days remaining
    const daysLeft = marketData.endDateIso
      ? (new Date(marketData.endDateIso) - Date.now()) / (1000 * 60 * 60 * 24)
      : 365;
    let deltaTime = 0;
    if (daysLeft < 7) {
      deltaTime = -0.08; // High time decay
    } else if (daysLeft < 30) {
      deltaTime = -0.03; // Moderate time decay
    } else if (daysLeft > 180) {
      deltaTime = 0.02; // Time working in favor
    }

    const structuredAnalysis = {
      probability: winProb, // Use RAW LLM probability for edge calculation
      adjustedProbability: adjustedWinProb, // Sentiment-adjusted for reference only
      originalProbability: winProb, // Preserve original LLM probability (same as probability)
      action,
      confidence: Math.round(finalConfidence),
      reasoning,
      kellyFraction: exposure,
      baseEffectiveEdge,
      effectiveEdge: baseEffectiveEdge, // Both point to same netEdge value
      entropy: entropy,
      sentimentScore: sentimentScore !== 0 ? sentimentScore : extractSentimentFromNews(news),
      adaptiveLearning: adaptiveLearning,
      // Factor breakdown for display
      deltaNews,
      deltaStructure,
      deltaBehavior,
      deltaTime,
      calibration: {
        confidence: Number(finalConfidence.toFixed(2)),
        rawConfidence: Number(finalConfidence.toFixed(2)),
        confidenceAdjustment: 0,
        calibrationSampleSize: adaptiveLearning.sampleSize || 0,
        message: 'Calibration skipped (adaptive learning in control)'
      },
      revised_prior: llmProbability, // Use validated LLM probability
      uncertainty: ensureNumber(result.uncertainty, entropy),
      newsSources: Array.isArray(result.newsSources) && result.newsSources.length > 0
        ? result.newsSources
        : extractNewsSourcesFromNews(news),
      // Edge fields - all in percentage for display, decimal for calculation
      edge: {
        raw: rawEdge,                    // Decimal, signed (-1 to 1)
        rawPercent: rawEdge * 100,       // Percentage, signed
        net: netEdge,                    // Decimal, absolute
        netPercent: netEdge * 100,       // Percentage, absolute
        direction: direction,
        spreadCost: edgeAnalysis.spreadCost,
        executionCost: edgeAnalysis.executionCost || edgeAnalysis.spreadCost,
        isExecutable: edgeAnalysis.isExecutable
      }
    };
    structuredAnalysis.baseEffectiveEdge = baseEffectiveEdge;
    structuredAnalysis.effectiveEdge = baseEffectiveEdge;
    structuredAnalysis.reasoning += ` Recommended Position: ${(exposure * 100).toFixed(1)}% of bankroll.`;
    
    // Log key metrics for debugging
    console.log(`[ANALYSIS] ${marketData.question?.slice(0, 40)}... | ` +
      `LLM=${(llmProbability * 100).toFixed(1)}% | ` +
      `Market=${(pMarket * 100).toFixed(1)}% | ` +
      `Edge=${(rawEdge * 100).toFixed(2)}% (${direction}) | ` +
      `Net=${(netEdge * 100).toFixed(2)}% | ` +
      `Conf=${Math.round(finalConfidence)}%`);

    return structuredAnalysis;
}

function extractNewsSourcesFromNews(news = []) {
  if (!Array.isArray(news) || news.length === 0) return [];
  
  return news.slice(0, 5).map((item, idx) => ({
    title: item.title || 'Unknown title',
    source: item.source || extractSourceFromUrl(item.url) || 'Unknown source',
    date: item.publishedDate || item.date || new Date().toISOString().split('T')[0],
    url: item.url || null,
    relevance: idx < 2 ? 'high' : idx < 4 ? 'medium' : 'low'
  }));
}

function extractSentimentFromNews(news = []) {
  if (!Array.isArray(news) || news.length === 0) return 0;
  
  const positiveKeywords = ['rise', 'increase', 'growth', 'bullish', 'positive', 'up', 'gain', 'surge', 'rally', 'strong', 'good', 'excellent', 'success', 'win', 'beat', 'outperform'];
  const negativeKeywords = ['fall', 'decrease', 'decline', 'bearish', 'negative', 'down', 'loss', 'drop', 'crash', 'weak', 'bad', 'poor', 'fail', 'miss', 'underperform'];
  
  let positiveCount = 0;
  let negativeCount = 0;
  
  news.forEach(item => {
    const title = (item.title || '').toLowerCase();
    const snippet = (item.snippet || '').toLowerCase();
    const text = title + ' ' + snippet;
    
    positiveKeywords.forEach(keyword => {
      if (text.includes(keyword)) positiveCount++;
    });
    
    negativeKeywords.forEach(keyword => {
      if (text.includes(keyword)) negativeCount++;
    });
  });
  
  const totalSentiment = positiveCount - negativeCount;
  const totalItems = news.length || 1;
  return Math.max(-1, Math.min(1, totalSentiment / totalItems));
}

function extractSourceFromUrl(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace('www.', '');
  } catch {
    return null;
  }
}

/**
 * Generate personalized market analysis for a specific user
 * @param {Object} marketData - Market data
 * @param {Object} userProfile - User profile with metrics and analysis
 * @returns {Object} - Personalized analysis result
 */
async function generatePersonalizedAnalysis(marketData, userProfile) {
  try {
    // Build user context from profile
    const userContext = buildUserContext(userProfile);

    // Generate personalized prompt
    const personalizedPrompt = generatePersonalizedPrompt(marketData, userContext);

    // Call LLM with personalized prompt
    const client = getLLMClient();
    const response = await client.chat.completions.create({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: 'You are a personalized Polymarket trading advisor. Provide analysis tailored to the specific trader\'s profile, strengths, weaknesses, and risk tolerance.' },
        { role: 'user', content: personalizedPrompt }
      ],
      max_tokens: 1000,
      temperature: 0.3
    });

    const llmOutput = response?.choices?.[0]?.message?.content || '{}';
    const parsedResult = safeParseLLM(llmOutput);

    // Generate personalized summary
    const summary = generatePersonalizedSummary(parsedResult, userContext);

    return {
      ...parsedResult,
      personalizedSummary: summary,
      userContext: userContext,
      generatedAt: Date.now()
    };
  } catch (error) {
    console.error('[PERSONALIZED LLM] Analysis failed:', error.message);
    // Fallback to standard analysis
    return await generateEnhancedAnalysis(marketData);
  }
}

module.exports = { generateDecrees, generateEnhancedAnalysis, generatePersonalizedAnalysis, computeNetEdge };
