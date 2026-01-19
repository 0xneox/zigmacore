const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const { classifyMarket } = require('./utils/classifier');
const { BoundedMap } = require('./utils/bounded-map');

const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const log = (msg) => { if (LOG_LEVEL === 'DEBUG') console.log(msg); };

const GAMMA = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';
const CACHE_FILE = path.join(__dirname, '..', 'cache', 'last_snapshot.json');

const { getVolumeSnapshots, saveVolumeSnapshot } = require('./db');
const { searchTavily, searchLLMNews } = require('./market_analysis');
const { searchNewsMultiple } = require('./news-search-multi');

const NEWS_CACHE_TTL_MS = 2 * 60 * 1000; // Reduced to 2 minutes
const MAX_NEWS_RESULTS = 12;
const HIGH_CRED_SOURCES = ['reuters', 'bloomberg', 'financial times', 'wall street journal', 'wsj', 'ap', 'associated press', 'ft'];
const POSITIVE_TERMS = ['approval', 'surge', 'record', 'beats', 'wins', 'launch', 'uphold', 'favorable', 'sec clears', 'momentum', 'support'];
const NEGATIVE_TERMS = ['probe', 'lawsuit', 'decline', 'drop', 'sell-off', 'delay', 'ban', 'halt', 'investigation', 'bearish', 'recession', 'cuts'];
const newsCache = new BoundedMap(1000);

/* =========================
   Market normalization helpers
========================= */
function normalizeMarketData(market) {
  try {
    // Parse stringified arrays if needed
    if (typeof market.outcomes === "string") {
      market.outcomes = JSON.parse(market.outcomes);
    }
    if (typeof market.outcomePrices === "string") {
      market.outcomePrices = JSON.parse(market.outcomePrices);
    }
    if (typeof market.prices === "string") {
      market.prices = JSON.parse(market.prices);
    }
  } catch (e) {
    console.error(`❌ Failed to parse outcomes/prices for: ${market.question}`);
    return null;
  }

  // Validate the arrays exist and match in length
  const outcomes = market.outcomes || market.options;
  const outcomePrices = market.outcomePrices || market.prices;

  if (
    !Array.isArray(outcomes) ||
    !Array.isArray(outcomePrices) ||
    outcomes.length !== outcomePrices.length
  ) {
    log(`❌ Invalid outcome arrays for ${market.question}, skipping`);
    return null;
  }

  return market;
}

/* =========================
   Market quality helpers
========================= */
function isDeadMarket(market) {
  // Check for extreme probabilities (dead markets)
  const outcomes = market.outcomes || market.options;
  const outcomePrices = market.outcomePrices || market.prices;

  if (!outcomes || !outcomePrices) return true;

  // If any outcome has probability >99% or <1%, it's essentially dead
  return outcomePrices.some(p => p >= 0.99 || p <= 0.01);
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(obj) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('Cache save error:', e);
  }
}

/**
 * Calculates the standard deviation of an array of numbers.
 * Used for Bollinger Band spike detection logic.
 */
function calculateStdDev(values) {
  if (!values || values.length < 2) return 0;
  const mean = values.reduce((acc, val) => acc + val, 0) / values.length;
  const squareDiffs = values.map(val => Math.pow(val - mean, 2));
  const avgSquareDiff = squareDiffs.reduce((acc, val) => acc + val, 0) / values.length;
  return Math.sqrt(avgSquareDiff);
}

/**
 * Cross-reference news from multiple sources to avoid hallucination
 * Fetches multiple queries, deduplicates, scores, and enriches with sentiment metadata
 */
async function crossReferenceNews(market = {}) {
  const question = market.question || '';
  const cacheKey = (market.id || market.slug || question || 'unknown').toString();
  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < NEWS_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const queries = buildNewsQueries(market);
    
    // Use multi-source news search with fallback chain
    const multiSourceResults = await searchNewsMultiple(queries, market, {
      maxResults: MAX_NEWS_RESULTS,
      days: 7,
      sources: ['tavily', 'openai', 'google', 'bing'] // Try all sources
    });

    if (multiSourceResults.length > 0) {
      let enriched = multiSourceResults
        .map(hit => enrichNewsResult(hit, market))
        .filter(Boolean);

      // Filter out news containing probability estimates that contradict market prices
      enriched = filterProbabilityEstimates(enriched);

      enriched = enriched
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, MAX_NEWS_RESULTS)
        .map(hit => {
          const factCheck = "Fact check not implemented yet";
          return { ...hit, factCheck };
        });

      newsCache.set(cacheKey, { timestamp: Date.now(), data: enriched });
      console.log(`✅ Found ${enriched.length} news items from multi-source search`);
      return enriched;
    }

    // Fallback to cached data if available
    if (cached) {
      console.log('⚠️  Using cached news due to no new results');
      return cached.data;
    }

    console.log('❌ No news found from any source');
    return [];

  } catch (e) {
    console.error('Cross-reference news error:', e.message);
    if (cached) return cached.data;
    return [];
  }
}

function buildNewsQueries(market = {}) {
  const base = buildNewsQuery(market);
  const tokens = extractEntityTokens(market);
  const category = classifyMarket(market.question || '');
  const categoryQuery = category && category !== 'EVENT'
    ? `${market.question || ''} ${category.toLowerCase()} prediction market news`
    : null;

  const keywordQuery = tokens.length
    ? `${tokens.slice(0, 3).join(' ')} latest developments`
    : null;

  return [base, categoryQuery, keywordQuery]
    .filter((q, idx, arr) => q && arr.indexOf(q) === idx);
}

function buildNewsQuery(market = {}) {
  const question = (market.question || '').trim();
  const cleaned = question.replace(/\?/g, '').trim();
  const seasonMatch = question.match(/20\d{2}/);
  const season = seasonMatch ? seasonMatch[0] : new Date().getFullYear();

  const subjectPatterns = [
    /Will (?:the )?(.+?) win (?:the )?(?:\d{4}\s*)?(Super Bowl|NFC|AFC)/i,
    /Will (?:the )?(.+?) (?:make|reach) (?:the )?(?:\d{4}\s*)?(Super Bowl|playoffs|NFC|AFC)/i,
    /Will (?:the )?(.+?) (?:win|claim) (?:the )?(?:\d{4}\s*)?(division|conference|championship)/i,
  ];

  let subject = null;
  for (const pattern of subjectPatterns) {
    const match = question.match(pattern);
    if (match && match[1]) {
      subject = match[1].replace(/the\s+/i, '').trim();
      break;
    }
  }

  if (!subject && /^Will\s+/i.test(question)) {
    subject = question.replace(/^Will\s+/i, '').split('?')[0].trim();
  }

  if (subject) {
    return `${subject} ${season} latest odds news analysis`;
  }

  if (cleaned.length > 0) {
    return `${cleaned} odds news analysis`;
  }

  return 'NFL futures odds news';
}

function extractHostname(url) {
  try {
    if (!url) return '';
    const hostname = new URL(url).hostname;
    return hostname.replace('www.', '');
  } catch {
    return '';
  }
}

function getSourceCredibility(source = '') {
  const normalized = source.toLowerCase();
  if (!normalized) return 0.1;
  if (HIGH_CRED_SOURCES.some(name => normalized.includes(name))) {
    return 1;
  }
  if (normalized.includes('.')) return 0.4;
  return 0.2;
}

function extractEntityTokens(market = {}) {
  const question = (market.question || '').toLowerCase();
  const tokens = question
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(token => token.length > 3 && !['will', 'this', 'that', 'have', 'with', 'from'].includes(token));
  return tokens.slice(0, 6);
}

function dedupeNewsResults(results = []) {
  const seen = new Set();
  return results.filter(hit => {
    const key = ((hit.url || hit.link || hit.title || '')).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Filter out news that contains probability estimates (e.g., "43% chance", "50% probability")
// These can bias the LLM away from market prices
function filterProbabilityEstimates(results = []) {
  return results.filter(hit => {
    const title = (hit.title || hit.name || '').toLowerCase();
    const snippet = (hit.snippet || hit.content || hit.description || '').toLowerCase();
    const text = `${title} ${snippet}`;

    // Filter out patterns like "43% chance", "50% probability", "75% likely"
    // But allow general percentage references like "up 5%", "down 10%"
    const probPatterns = [
      /(\d+)%\s*(chance|probability|likely|odds|bet)/i,
      /chance\s+of\s+(\d+)%/i,
      /probability\s+of\s+(\d+)%/i,
      /(\d+)%\s+chance/i,
    ];

    return !probPatterns.some(pattern => pattern.test(text));
  });
}

function enrichNewsResult(hit = {}, market = {}) {
  const title = hit.title || hit.name || '';
  if (!title) return null;
  const snippet = hit.snippet || hit.content || hit.description || '';
  const url = hit.url || hit.link || '';
  const sourceRaw = (hit.source || hit.site || hit.publisher || '').toString();
  const source = sourceRaw ? sourceRaw.trim() : extractHostname(url) || 'unknown';
  const publishedAtRaw = hit.published_date || hit.published_at || hit.publishedAt || hit.date || hit.timestamp;
  const publishedMs = publishedAtRaw ? Date.parse(publishedAtRaw) : NaN;
  const recencyHours = Number.isFinite(publishedMs) ? (Date.now() - publishedMs) / (1000 * 60 * 60) : null;
  const sentiment = computeSentimentScore(`${title}\n${snippet}`);
  const sourceCred = getSourceCredibility(source);
  const question = (market.question || '').toLowerCase();
  const entityTokens = extractEntityTokens(market);
  const entityMatch = entityTokens.some(token => token && title.toLowerCase().includes(token));
  const questionOverlap = question && title.toLowerCase().includes(question.split('?')[0].slice(0, 32));
  const recencyScore = recencyHours == null ? 0.2 : Math.max(0, 1 - (recencyHours / 72));

  const relevanceScore =
    Math.abs(sentiment) * 0.4 +
    recencyScore * 0.25 +
    sourceCred * 0.2 +
    (entityMatch ? 0.1 : 0) +
    (questionOverlap ? 0.05 : 0) +
    ((hit.score || 0) / 100) * 0.05 +
    (hit.query?.includes('prediction') ? 0.05 : 0);

  return {
    title,
    snippet,
    url,
    source,
    publishedAtRaw,
    recencyHours,
    sentiment,
    sourceCred,
    relevanceScore: Number(relevanceScore.toFixed(3)),
    entityMatch,
    questionOverlap
  };
}

function computeSentimentScore(text = '') {
  const normalized = text.toLowerCase();
  if (!normalized) return 0;
  let score = 0;
  POSITIVE_TERMS.forEach(term => {
    if (normalized.includes(term)) score += 1;
  });
  NEGATIVE_TERMS.forEach(term => {
    if (normalized.includes(term)) score -= 1;
  });
  return Math.max(-1, Math.min(1, score / 5));
}

/* =========================
   Market selection
========================= */
function pickMarkets(enriched) {
  const snapshot = loadCache(); // Load last_snapshot.json
  
  const withVelocity = enriched.map(m => {
    const oldVol = snapshot[m.id]?.volume || m.volume;
    m.volumeVelocity = ((m.volume - oldVol) / (oldVol || 1)) * 100;
    return m;
  });
  
  // v1.5.1 – less aggressive volume spike rejection
  const VOLUME_VELOCITY_BLACK_SWAN_THRESHOLD = 950; // was 650–700 probably

  withVelocity.forEach(m => {
    if (m.volumeVelocity > VOLUME_VELOCITY_BLACK_SWAN_THRESHOLD) {
      m.riskLevel = 'VERY_HIGH';
      if (m.volumeVelocity > 1500) {
        m.veto = true; // veto extreme spikes
      }
    }
  });
  
  const spikes = withVelocity.filter(m => m.volumeVelocity > 300 && !m.veto)
    .sort((a, b) => b.volumeVelocity - a.volumeVelocity);
    
  spikes.forEach(m => log(`🚀 VOLUME SPIKE DETECTED: ${m.question} - ${m.volumeVelocity.toFixed(0)}% increase!`));
  
  const byVolume = [...withVelocity]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5);

  const byMovement = [...withVelocity]
    .sort((a, b) => Math.abs(b.priceChange) - Math.abs(a.priceChange))
    .slice(0, 5);

  const byVolumeVelocity = [...withVelocity]
    .filter(m => m.volumeVelocity > 0) // Only markets with positive velocity
    .sort((a, b) => b.volumeVelocity - a.volumeVelocity)
    .slice(0, 5);

  const extremeProbs = [...withVelocity]
    .filter(m => m.yesPrice !== null && m.yesPrice > 0.01 && m.yesPrice < 0.99)
    .sort(
      (a, b) =>
        Math.abs(0.5 - b.yesPrice) - Math.abs(0.5 - a.yesPrice)
    )
    .slice(0, 3);

  log('⚡ Extreme probability markets:');
  extremeProbs.forEach(m => {
    const dir = m.yesPrice >= 0.5 ? 'YES' : 'NO';
    const prob = m.yesPrice >= 0.5 ? m.yesPrice : 1 - m.yesPrice;
    log(
      `- ${m.question.slice(0, 60)}: ${dir} ${(prob * 100).toFixed(
        1
      )}% | Vol $${m.volume.toLocaleString()}`
    );
  });

  log('🚀 Volume velocity markets:');
  byVolumeVelocity.slice(0, 3).forEach(m => {
    log(
      `- ${m.question.slice(0, 60)}: ${m.volumeVelocity.toFixed(0)}% velocity | Current Vol: $${m.volume.toLocaleString()} | Old Vol: $${(snapshot[m.id]?.volume || 0).toLocaleString()}`
    );
  });

  log('🔥 Spike markets:');
  spikes.forEach(m => {
    log(
      `- ${m.question.slice(0, 60)}: ${m.volumeVelocity.toFixed(0)}% SPIKE | Vol $${m.volume.toLocaleString()}`
    );
  });
  const aboutToBond = enriched
    .filter(m => m.yesPrice > 0.7 || m.yesPrice < 0.3)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 3);

  log(
    `Market selection: ${byVolume.length} by volume, ${byMovement.length} by movement, ${byVolumeVelocity.length} by velocity, ${spikes.length} spikes, ${aboutToBond.length} high-probability`
  );

  // Prioritize spike markets first, then others
  const candidates = [...spikes, ...byVolume, ...byMovement, ...byVolumeVelocity, ...aboutToBond].filter(m => !m.veto);
  return Array.from(
    new Map(
      candidates.map(m => [m.id, m])
    ).values()
  );
}

module.exports = {
  loadCache,
  saveCache,
  pickMarkets,
  crossReferenceNews
};
