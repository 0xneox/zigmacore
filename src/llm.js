const OpenAI = require('openai');
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

// Horizon discount function for time-based edge reduction
function computeHorizonDiscount(daysToResolution) {
  return Math.max(0.1, 1 - (daysToResolution / 365) * 0.5);
}

// Utility functions
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

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

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_XAI_MODEL = process.env.XAI_MODEL || 'grok-beta';
const LLM_MODEL = process.env.LLM_MODEL || (PROVIDER === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_XAI_MODEL);
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
  FAILURE_THRESHOLD: 5,
  RESET_MS: 300000
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

// Safe LLM Parse with fallback (NEW: Added to fix conf=0 bug)
function safeParseLLM(output) {
  try {
    const json = JSON.parse(output);
    if (json.confidence && json.confidence > 0) {
      console.log(`[PARSE] Successful JSON parse: confidence=${json.confidence}`);
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

  const parsed = {
    revised_prior: priorMatch ? parseFloat(priorMatch[1]) : 0.5,
    confidence: confMatch ? parseInt(confMatch[1]) : 60, // Default mid if missing
    narrative,
    sentimentScore,
    newsSources
  };

  // Ensure confidence is positive and above minimum floor
  parsed.confidence = Math.max(1, parsed.confidence);

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

const ENHANCED_SYSTEM_PROMPT_TEMPLATE = RESOLUTION_FIRST_PROMPT + `
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
  "sentimentScore": number between -1 and 1 (overall sentiment from news headlines, -1 negative, 0 neutral, 1 positive),
  "confidence": number between 1 and 100 (your confidence in this analysis as an integer),
  "newsSources": array of objects with "title", "source", "date", "url" (if available), and "relevance" (high/medium/low)
}

CRITICAL: You MUST analyze the provided news headlines and return:
1. sentimentScore: Calculate based on news sentiment (-1 to 1)
2. newsSources: Extract 3-5 most relevant news items with title, source, date, and relevance

Always include "confidence": 1-100 integer in JSON; explain why in reasoning.
IMPORTANT: For each news item mentioned in reasoning, include it in newsSources array with title, source, date, and relevance level.

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
- NEWS SOURCES: Extract 3-5 most relevant news items with title, source, date, and relevance (high/medium/low)
- SENTIMENT: Calculate sentiment score (-1 to 1) based on news headlines
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

  // Calculate base rate prior for context
  const baseRatePrior = calculateBaseRatePrior(marketData);
  const historicalContext = getHistoricalContext(marketData, baseRatePrior);

  return `You are a professional Polymarket analyst. You must return STRICT JSON ONLY (no markdown) that matches this schema:
{
  "delta": number between -0.20 and 0.20 (adjustment to the current market YES price based on news, fundamentals, and biases; positive for more likely YES, negative for less likely),
  "confidence": number between 1 and 100 (your confidence in this delta as an integer),
  "narrative": string (brief explanation of your reasoning, including how news influenced the delta),
  "sentimentScore": number between -1 and 1 (overall sentiment from news headlines, -1 negative, 0 neutral, 1 positive),
  "newsSources": array of objects with "title", "source", "date", "url" (if available), and "relevance" (high/medium/low)
}
Always include "confidence": 1-100 integer in JSON. Do NOT output absolute probabilities—only the delta adjustment to the market price.

CRITICAL: You MUST analyze the provided news headlines and return:
1. sentimentScore: Calculate based on news sentiment (-1 to 1)
2. newsSources: Extract 3-5 most relevant news items with title, source, date, and relevance

Context for your assessment:
MARKET DATA:
${marketJson}

Current YES market price (base for delta adjustment): ${marketData.yesPrice}
Historical base rate prior: ${baseRatePrior} (This is the expected probability based on historical data, state political leanings, or competitor count)

HISTORICAL CONTEXT:
${historicalContext}

ANALYSIS METRICS:
${analysisJson}

ORDER BOOK DATA:
${orderBookJson}

RECENT NEWS HEADLINES:
${newsText}

Instructions:
- First, provide the strongest argument for YES outcome.
- Second, provide the strongest argument for NO outcome.
- Then, considering both arguments, estimate the delta adjustment (between -0.20 and 0.20) to the current market price.
- Compare the market price (${marketData.yesPrice}) to the historical base rate (${baseRatePrior}). If they differ significantly, explain why in your narrative.
- Consider historical base rates, state-specific political leanings, and incumbent advantages if applicable.
- Provide confidence score based on evidence strength (e.g., high for credible news, low for speculative).
- Confidence: integer 1-100; explain why.
- Keep narrative concise (<100 words), citing specific news or data points.
- Extract 3-5 most relevant news sources with titles, sources, dates, and relevance levels.

Return ONLY the JSON object—no prose or extra text.`;
}

// Calculate base rate prior for LLM context
function calculateBaseRatePrior(marketData) {
  const question = marketData.question || '';
  const q = question.toLowerCase();

  // Detect NFL teams (32 teams = 3.1% base rate)
  if (/win the (super bowl|afc championship|nfc championship)/i.test(q)) {
    return 0.031;
  }

  // Detect NBA teams (30 teams = 3.3% base rate)
  if (/win the nba championship/i.test(q)) {
    return 0.033;
  }

  // Detect MLB teams (30 teams = 3.3% base rate)
  if (/win the (world series|mlb championship)/i.test(q)) {
    return 0.033;
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

  // Default category priors
  if (/bitcoin|ethereum|btc|eth|crypto|solana|bnb|ada|doge/i.test(q)) {
    return 0.55;
  }
  if (/recession|inflation|fed|fed rate|gdp|unemployment|economy/i.test(q)) {
    return 0.50;
  }
  if (/election|president|trump|biden|senate|congress|political|government/i.test(q)) {
    return 0.42;
  }
  if (/grammy|oscar|emmy|award|nomination/i.test(q)) {
    return 0.48;
  }

  return 0.50; // Default 50% for unknown markets
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
    }
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
  const kellyFraction = calculateKelly(marketData.yesPrice || 0.5, marketData.liquidity || 0); // Assume from market_analysis.js

  // Generate LLM prompt
  const systemPrompt = buildEnhancedSystemPrompt({
    spread: Number.isFinite(spreadPercentage) ? spreadPercentage.toFixed(2) : 'N/A',
    depth: Number.isFinite(depth) ? depth.toFixed(0) : 'N/A',
    liquidityScore: Number.isFinite(liquidityScore) ? liquidityScore : 'N/A',
    kelly: Number.isFinite(kellyFraction) ? (kellyFraction * 100).toFixed(1) : 'N/A',
    resolutionCriteria: marketData.description || 'No resolution criteria available.'
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

  const llmStart = Date.now();
  llmMetrics.total += 1;
  let llmOk = false;
  try {
    if (!checkCircuitBreaker()) {
      console.warn(`[LLM] Circuit breaker is open, using fallback for ${marketData.id}`);
      return {
        marketId: marketData.id,
        question: marketData.question,
        confidence: 50,
        action: 'HOLD',
        probability: 0.5,
        reasoning: 'LLM circuit breaker open - using fallback',
        generatedAt: Date.now(),
        fallback: true
      };
    }

    console.log(`[LLM] Starting API call for ${marketData.id}`);
    response = await llmCall();
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

    // Enhanced fallback analysis using available data
    const basePrior = typeof marketData.yesPrice === 'number' ? marketData.yesPrice : 0.5;
    let fallbackProbability = basePrior;
    let fallbackReasoning = 'LLM call failed - using enhanced fallback analysis';

    // Use news sentiment if available
    if (news && news.length > 0) {
      try {
        const sentimentAnalysis = calculateAggregateSentiment(news);
        const sentimentScore = sentimentAnalysis.score;

        // Adjust probability based on sentiment
        // Positive sentiment = more likely YES, Negative = more likely NO
        const sentimentAdjustment = sentimentScore * 0.1; // Max ±10% adjustment
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

    return {
      marketId: marketData.id,
      question: marketData.question,
      confidence: fallbackConfidence,
      action: fallbackAction,
      probability: fallbackProbability,
      reasoning: fallbackReasoning,
      deltaNews: news && news.length > 0 ? (fallbackProbability - basePrior) : 0,
      deltaStructure: 0,
      deltaBehavior: 0,
      deltaTime: 0,
      sentimentScore: news && news.length > 0 ? (fallbackProbability - basePrior) * 10 : 0,
      uncertainty: 0.5,
      generatedAt: Date.now(),
      fallback: true
    };
  }

  emitLLMMetrics({
    ok: llmOk,
    marketId: marketData.id,
    llm_latency_ms: Date.now() - llmStart,
    provider: PROVIDER,
    model: LLM_MODEL
  });

  let llmAnalysis = response?.choices?.[0]?.message?.content || '{}';

  console.log('LLM Response:', llmAnalysis);

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
    const ensureNumber = (value, fallback = 0) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const parsed = parseFloat(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return fallback;
    };

    // Compute revised_prior from delta (Change 1)
    const base_prior = clamp(ensureNumber(marketData.yesPrice, 0.5), 0.01, 0.99);
    const delta = clamp(ensureNumber(result.delta, 0), -0.20, 0.20);
    const combinedDelta = clamp(delta + newsDelta, -0.25, 0.25);
    const revised_prior = clamp(base_prior + combinedDelta, 0.01, 0.99);
    result.revised_prior = ensureNumber(result.revised_prior, revised_prior);

    const pMarket = clamp(typeof marketData.yesPrice === 'number' ? marketData.yesPrice : 0.5, 0.01, 0.99);
    const basePriorForAvg = clamp(
      typeof marketData.basePrior === 'number' && Number.isFinite(marketData.basePrior)
        ? marketData.basePrior
        : base_prior,
      0.01,
      0.99
    );
    // Use LLM's revised_prior directly - NO averaging to preserve edge
    const winProb = clamp(result.revised_prior, 0.02, 0.98);

    const daysLeft = marketData.endDateIso
      ? (new Date(marketData.endDateIso) - Date.now()) / (1000 * 60 * 60 * 24)
      : marketData.endDate
        ? (new Date(marketData.endDate) - Date.now()) / (1000 * 60 * 60 * 24)
        : 365;
    
    // Enhanced entropy calculation
    const entropyAnalysis = calculateMarketEntropy(marketData, {
      endDate: marketData.endDateIso || marketData.endDate,
      outcomes: marketData.outcomePrices || marketData.prices || []
    });
    const entropy = entropyAnalysis.entropy;

    // Enhanced sentiment analysis
    let sentimentScore = 0;
    if (news && news.length > 0) {
      const sentimentAnalysis = calculateAggregateSentiment(news);
      sentimentScore = sentimentAnalysis.score;
    }
    
    // Ensure sentimentScore is not zero if there's news
    if (news && news.length > 0 && sentimentScore === 0) {
      // Calculate sentiment from news headlines as fallback
      const positiveKeywords = ['rise', 'increase', 'growth', 'bullish', 'positive', 'up', 'gain', 'surge', 'rally', 'strong', 'good', 'excellent'];
      const negativeKeywords = ['fall', 'decrease', 'decline', 'bearish', 'negative', 'down', 'loss', 'drop', 'crash', 'weak', 'bad', 'poor'];
      
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
      sentimentScore = Math.max(-1, Math.min(1, totalSentiment / totalItems));
    }

    const liquidityUsd = Number(marketData.liquidity) || 0;
    const priceMomentum =
      typeof marketData.priceChange === 'number'
        ? Math.min(Math.max(Math.abs(marketData.priceChange) / 100, 0), 0.03)
        : 0;

    const liquidityBoost =
      liquidityUsd >= 100000 ? 0.025 :
      liquidityUsd >= 50000 ? 0.02 :
      liquidityUsd >= 20000 ? 0.01 : 0;

    const deltaBoost = Math.min(Math.abs(combinedDelta), 0.03);
    const entropyPenalty = Math.max(0, (entropy - 0.3) * 0.02);
    const baseThreshold = 0.05;
    const dynamicThreshold = Math.max(
      0.015,
      baseThreshold - liquidityBoost - deltaBoost - priceMomentum + entropyPenalty
    );

    let action = 'HOLD';
    if (winProb > pMarket + dynamicThreshold) action = 'BUY YES';
    else if (winProb < pMarket - dynamicThreshold) action = 'BUY NO';

    const rawEdge = winProb - pMarket;
    const absEdge = Math.abs(rawEdge);

    const daysToResolution = marketData.endDateIso
      ? Math.max(0, (new Date(marketData.endDateIso) - Date.now()) / (1000 * 60 * 60 * 24))
      : marketData.endDate
        ? Math.max(0, (new Date(marketData.endDate) - Date.now()) / (1000 * 60 * 60 * 24))
        : 365;
    const horizonDiscount = computeHorizonDiscount(daysToResolution);

    let normalizedConfidence = result.confidence > 1 ? result.confidence / 100 : result.confidence;
    normalizedConfidence = clamp(normalizedConfidence, 0.01, 1);
    const expectedEdge = rawEdge * normalizedConfidence * horizonDiscount;
    const absExpectedEdge = Math.abs(expectedEdge);

    const category = classifyMarket(marketData.question);
    let exposure = 0;
    let tier = 'None';

    // Liquidity-aware Kelly-style sizing
    const liqUsd = Math.max(0, Number(marketData.liquidity) || 0);
    let liquidityTier = 1.0;
    if (liqUsd < 30000) liquidityTier = 0.6;
    else if (liqUsd < 80000) liquidityTier = 0.85;
    else if (liqUsd > 300000) liquidityTier = 1.4;

    const baseKelly = calculateKelly(winProb, pMarket, 0.01, liqUsd || 10000);
    exposure = Math.min(0.05, Math.max(0, baseKelly * liquidityTier));
    if (exposure >= 0.04) tier = 'STRONG_TRADE';
    else if (exposure >= 0.02) tier = 'SMALL_TRADE';
    else if (exposure >= 0.005) tier = 'PROBE';
    else tier = 'SCOUT';

    // Conviction boost: Adjust based on edge/volatility
    const volatilityFactor = marketData.priceVolatility || 0.05; // from metrics
    // Use LLM's confidence directly - don't overwrite it with formula
    let confidenceScore = clamp(normalizedConfidence, 0.01, 1);

    // Apply adaptive learning
    const adaptiveLearning = applyAdaptiveLearning(category, action, absEdge, confidenceScore * 100);
    const adjustedEdge = adaptiveLearning.adjustedEdge;
    const adjustedConfidence = adaptiveLearning.adjustedConfidence;

    // Apply confidence calibration
    const calibratedSignal = applyCalibration({
      confidence: adjustedConfidence,
      category: category
    });
    const finalConfidence = calibratedSignal.confidence;

    // Entropy discount REMOVED - trust LLM's edge
    // const entropyDiscountedEdge = applyEntropyDiscount(entropy, adjustedEdge);
    const entropyDiscountedEdge = adjustedEdge;

    let reasoning = result.narrative || 'No detailed reasoning from LLM.';
    reasoning += ` | Conviction Tier: ${tier} | Revised Prior: ${winProb.toFixed(3)} (${category}) | Suggested Exposure: ${(exposure * 100).toFixed(0)}% bankroll.`;
    reasoning += ` | Entropy: ${(entropy * 100).toFixed(1)}% (${entropyAnalysis.uncertaintyLevel})`;
    reasoning += ` | Sentiment: ${sentimentScore > 0.1 ? 'POSITIVE' : sentimentScore < -0.1 ? 'NEGATIVE' : 'NEUTRAL'} (${(sentimentScore * 100).toFixed(1)}%)`;
    if (adaptiveLearning.sampleSize >= 20) {
      reasoning += ` | Adaptive Learning: ${adaptiveLearning.message}`;
    }
    if (calibratedSignal.confidenceAdjustment !== 0) {
      reasoning += ` | Calibration: ${(calibratedSignal.confidenceAdjustment > 0 ? '+' : '')}${calibratedSignal.confidenceAdjustment.toFixed(1)}%`;
    }

    const baseEffectiveEdge = Number((entropyDiscountedEdge * 100).toFixed(2));

    const structuredAnalysis = {
      probability: winProb,
      action,
      confidence: Math.round(finalConfidence),
      reasoning,
      kellyFraction: exposure,
      baseEffectiveEdge,
      effectiveEdge: baseEffectiveEdge,
      entropy: entropy,
      sentimentScore: sentimentScore !== 0 ? sentimentScore : extractSentimentFromNews(news),
      adaptiveLearning: adaptiveLearning,
      calibration: calibratedSignal,
      // Include factor breakdown deltas from LLM
      deltaNews: ensureNumber(result.deltaNews, newsDelta),
      deltaStructure: ensureNumber(result.deltaStructure, 0),
      deltaBehavior: ensureNumber(result.deltaBehavior, 0),
      deltaTime: ensureNumber(result.deltaTime, 0),
      primaryReason: result.primaryReason || 'ANALYSIS',
      uncertainty: ensureNumber(result.uncertainty, entropy),
      // Include news sources with citations - use LLM result or extract from news
      newsSources: Array.isArray(result.newsSources) && result.newsSources.length > 0 
        ? result.newsSources 
        : extractNewsSourcesFromNews(news)
    };
    structuredAnalysis.baseEffectiveEdge = baseEffectiveEdge;
    structuredAnalysis.effectiveEdge = baseEffectiveEdge;
    structuredAnalysis.reasoning += ` Recommended Position: ${(exposure * 100).toFixed(1)}% of bankroll.`;

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

module.exports = { generateDecrees, generateEnhancedAnalysis, generatePersonalizedAnalysis };
