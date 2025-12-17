const OpenAI = require('openai');
const { getMarketAnalyzer } = require('./market_analysis');
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
const ENHANCED_SYSTEM_PROMPT = `You are a professional market analyst specializing in Polymarket prediction markets. Your role is to provide objective, data-driven analysis that helps traders make informed decisions.

PROFESSIONAL STANDARDS:
- Use ONLY the provided market data and metrics
- Be completely objective - no hype, no predictions, no emotional language
- Include specific numbers, percentages, and dollar amounts
- Explain reasoning based on market microstructure (liquidity, spreads, volume)
- Rate confidence scores based on data quality and market conditions (5-95% range, never 0%)
- Structure analysis clearly with sections and bullet points
- Provide probabilistic recommendations, not absolute predictions

OUTPUT REQUIREMENTS:
- Executive Summary: 2-3 sentences summarizing key findings
- Technical Metrics: Bullet points with current market data
- Risk Assessment: LOW/MEDIUM/HIGH with specific quantitative reasons
- Trading Recommendation: SPECULATIVE BUY/TAIL-RISK BET/MARKET FAIRLY PRICED/AVOID with confidence score (5-95%)
- Price Analysis: Current levels, spread analysis, momentum indicators
- Market Outlook: Short-term momentum based on available data

RECOMMENDATION GUIDELINES:
- SPECULATIVE BUY: When market pricing seems inefficient (high expected value)
- TAIL-RISK BET: For extreme probability markets with potential mean reversion
- MARKET FAIRLY PRICED: When current pricing reflects available information
- AVOID: Only for markets with insufficient data or extreme uncertainty

IMPORTANT: This is educational analysis only. Include standard disclaimer about financial risk.`;

const BASIC_SYSTEM_PROMPT = `You are the Oracle of Poly — a neutral, analytical observer of prediction market price and volume movement. Your purpose is to summarize market movement and liquidity signals; you must NOT make forecasts, probabilities, or predictions about future outcomes. Use only data provided in the input. Output short, factual, consistent lines that are easily readable on X and in an on-chain Deep Dive.

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
function buildEnhancedAnalysisPrompt(marketData, analysis) {
  const analysisJson = JSON.stringify(analysis, null, 2);
  const marketJson = JSON.stringify(marketData, null, 2);

  return `You are a professional Polymarket analyst. Analyze this market data and provide a comprehensive assessment:

MARKET DATA:
${marketJson}

ANALYSIS METRICS:
${analysisJson}

Provide a professional analysis covering:
1. Executive Summary (2-3 sentences)
2. Technical Metrics Analysis (with specific numbers)
3. Risk Assessment (LOW/MEDIUM/HIGH with quantitative reasons)
4. Trading Recommendation (BUY/SELL/HOLD/AVOID with confidence 0-100%)
5. Price Analysis (levels, spread, momentum)
6. Market Outlook (based on available data)

Format as structured text with clear sections:

Executive Summary: [2-3 sentences summarizing key findings]

Risk Assessment: [LOW/MEDIUM/HIGH] - [specific quantitative reasons]

Recommendation: [BUY/SELL/HOLD/AVOID] ([0-100]% confidence) - [detailed reasoning]

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

// Enhanced analysis for premium reports
async function generateEnhancedAnalysis(marketData, cache = {}) {
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
        price: 15,
        generatedAt: Date.now(),
        mock: true
      };
    }

    const analyzer = getMarketAnalyzer();

    // Perform comprehensive analysis
    const analysis = await analyzer.analyzeMarket(marketData, cache);

    // Generate LLM prompt
    const { systemPrompt, userPrompt } = analyzer.generateAnalysisPrompt(marketData, analysis);

    let response;
    if (PROVIDER === 'openai') {
      const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
      response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: ENHANCED_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 800,
        temperature: 0.3
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
          { role: 'system', content: ENHANCED_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 800,
        temperature: 0.3
      });
    }

    const llmAnalysis = response.choices[0].message.content;

    // Parse structured text response
    const parseStructuredText = (text) => {
      const sections = {};
      
      // Extract Executive Summary
      const execMatch = text.match(/Executive Summary:\s*(.*?)(?=Risk Assessment:|$)/s);
      sections.executiveSummary = execMatch ? execMatch[1].trim() : text.substring(0, 300);
      
      // Extract Risk Assessment
      const riskMatch = text.match(/Risk Assessment:\s*(.*?)(?=Recommendation:|$)/s);
      if (riskMatch) {
        const riskText = riskMatch[1].trim();
        const levelMatch = riskText.match(/(LOW|MEDIUM|HIGH)/i);
        sections.riskAssessment = {
          level: levelMatch ? levelMatch[1].toUpperCase() : 'UNKNOWN',
          reasons: riskText.replace(/^(LOW|MEDIUM|HIGH)\s*-\s*/i, '').split(',').map(r => r.trim())
        };
      } else {
        sections.riskAssessment = { level: 'UNKNOWN', reasons: ['Analysis incomplete'] };
      }
      
      // Extract Recommendation
      const recMatch = text.match(/Recommendation:\s*(.*?)(?=Price Analysis:|$)/s);
      if (recMatch) {
        const recText = recMatch[1].trim();
        const actionMatch = recText.match(/(SPECULATIVE BUY|TAIL-RISK BET|MARKET FAIRLY PRICED|AVOID|BUY|SELL|HOLD)/i);
        const confidenceMatch = recText.match(/(\d+)%/);

        let action = 'MARKET FAIRLY PRICED'; // Default to neutral
        let confidence = 50; // Default confidence

        if (actionMatch) {
          const matchedAction = actionMatch[1].toUpperCase();
          // Map old actions to new ones if needed
          if (matchedAction === 'BUY') action = 'SPECULATIVE BUY';
          else if (matchedAction === 'SELL') action = 'TAIL-RISK BET';
          else if (matchedAction === 'HOLD') action = 'MARKET FAIRLY PRICED';
          else action = matchedAction;
        }

        if (confidenceMatch) {
          confidence = parseInt(confidenceMatch[1]);
          // Ensure confidence is in 5-95% range, never 0%
          confidence = Math.max(5, Math.min(95, confidence));
        }

        sections.recommendation = {
          action,
          confidence,
          reasoning: recText.replace(/^(SPECULATIVE BUY|TAIL-RISK BET|MARKET FAIRLY PRICED|AVOID|BUY|SELL|HOLD)\s*\(\d+%\)\s*-\s*/i, '').trim()
        };
      } else {
        sections.recommendation = {
          action: 'MARKET FAIRLY PRICED',
          confidence: 50,
          reasoning: 'Insufficient data for specific recommendation'
        };
      }
      
      // Extract Price Analysis
      const priceMatch = text.match(/Price Analysis:\s*(.*?)(?=Market Outlook:|$)/s);
      sections.priceAnalysis = priceMatch ? priceMatch[1].trim() : 'Current price analysis not available';
      
      // Extract Market Outlook
      const outlookMatch = text.match(/Market Outlook:\s*(.*?)(?=Include disclaimer|$)/s);
      sections.marketOutlook = outlookMatch ? outlookMatch[1].trim() : 'Market outlook not available';
      
      sections.timestamp = Date.now();
      return sections;
    };

    const structuredAnalysis = parseStructuredText(llmAnalysis);

    // Combine algorithmic analysis with LLM insights
    return {
      marketId: marketData.slug || marketData.id,
      question: marketData.question,
      algorithmicAnalysis: analysis,
      llmAnalysis: structuredAnalysis,
      premium: true,
      price: 15, // VIRTUAL tokens for premium analysis
      generatedAt: Date.now()
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
      price: 15,
      generatedAt: Date.now(),
      error: error.message,
      fallback: true
    };
  }
}

module.exports = { generateDecrees, generateEnhancedAnalysis };
