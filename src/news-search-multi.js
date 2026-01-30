/**
 * Multi-Source News Search Module
 * Provides fallback mechanisms for news search using multiple sources
 */

const axios = require('axios');
const OpenAI = require('openai');
require('dotenv').config();

// Cache configuration
const newsCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// User agent rotation for avoiding blocks
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Search news using Tavily API
 */
async function searchTavily(query = '', options = {}) {
  const { maxResults = 10, days = 7 } = options;
  const cacheKey = `tavily:${query.toLowerCase().trim()}:${days}`;
  const cached = newsCache.get(cacheKey);
  const now = Date.now();

  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    console.log('Using cached Tavily results for:', query);
    return cached.results;
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('TAVILY_API_KEY not set, skipping Tavily search');
    return [];
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: 'basic',
          max_results: maxResults,
          days,
          include_answer: false,
          include_raw_content: false,
          include_images: false
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        console.error(`Tavily API error: ${response.status}`);
        return [];
      }

      const data = await response.json();
      const results = (data.results || []).map(item => ({
        title: item.title || '',
        url: item.url || '',
        snippet: item.content || item.snippet || '',
        source: item.source || 'Tavily',
        publishedDate: item.published_date || null,
        score: item.score || 0,
        relevance: item.relevance_score || 0
      }));

      newsCache.set(cacheKey, { results, timestamp: now });
      console.log(`Fetched ${results.length} Tavily results for: ${query}`);
      return results;
    } finally {
      clearTimeout(timeout);
    }

  } catch (error) {
    console.error('Tavily search error:', error.message);
    return [];
  }
}

/**
 * Search news using OpenAI LLM knowledge
 */
async function searchOpenAINews(query = '', marketContext = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('OPENAI_API_KEY not set, skipping OpenAI news search');
    return [];
  }

  try {
    const client = new OpenAI({ apiKey, timeout: 15000 });

    const prompt = `You are a news search assistant. Given this query about a prediction market, return up to 5 recent, verifiable news headlines related to the topic.

Query: ${query}
Market Question: ${marketContext.question || 'Unknown'}

Rules:
- Only return real, recent news from well-known sources (Reuters, Bloomberg, WSJ, AP, etc.)
- If you don't have specific recent information, return an empty list
- Include publication dates when possible
- Provide brief summaries (max 150 characters)
- NEVER fabricate news or links

Respond in JSON format:
{
  "headlines": [
    {
      "title": "...",
      "summary": "...",
      "source": "...",
      "date": "YYYY-MM-DD",
      "url": ""
    }
  ]
}`;

    const response = await client.chat.completions.create({
      model: process.env.LLM_NEWS_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 800
    });

    const content = response?.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = JSON.parse(content);
      }
    } catch (e) {
      console.warn('Failed to parse OpenAI news response:', e.message);
      return [];
    }

    if (!parsed?.headlines || !Array.isArray(parsed.headlines)) {
      return [];
    }

    const results = parsed.headlines
      .filter(h => h.title && h.title.trim())
      .map(h => ({
        title: h.title,
        url: h.url || '',
        snippet: h.summary || '',
        source: h.source || 'OpenAI_Knowledge',
        publishedDate: h.date || null,
        score: 0.5,
        relevance: 0.5,
        origin: 'LLM_FALLBACK'
      }));

    console.log(`OpenAI found ${results.length} news items for: ${query}`);
    return results;

  } catch (error) {
    console.error('OpenAI news search error:', error.message);
    return [];
  }
}

/**
 * Search news using Google News RSS (if available)
 */
async function searchGoogleNews(query = '') {
  try {
    // Try Google News RSS feed
    const encodedQuery = encodeURIComponent(query);
    const rssUrl = `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-US&gl=US&ceid=US:en`;

    const response = await fetch(rssUrl, {
      headers: { 'User-Agent': getRandomUserAgent() },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      return [];
    }

    const text = await response.text();
    
    // Parse RSS XML with safer regex (prevent catastrophic backtracking)
    const items = [];
    // Use simpler pattern without negative lookahead to avoid ReDoS
    const itemRegex = /<item>(.*?)<\/item>/gs;
    
    // Limit iterations to prevent infinite loops on malformed XML
    let iterations = 0;
    const MAX_ITERATIONS = 100;
    let match;

    while ((match = itemRegex.exec(text)) !== null && iterations < MAX_ITERATIONS) {
      iterations++;
      const itemText = match[1];
      
      // Extract fields with safe regex patterns
      const titleMatch = itemText.match(/<title>([^<]*)<\/title>/);
      const linkMatch = itemText.match(/<link>([^<]*)<\/link>/);
      const pubDateMatch = itemText.match(/<pubDate>([^<]*)<\/pubDate>/);
      const descMatch = itemText.match(/<description>([^<]*)<\/description>/);
      
      if (titleMatch) {
        items.push({
          title: titleMatch[1].replace(/<[^>]*>/g, '').trim(),
          url: linkMatch ? linkMatch[1].trim() : '',
          snippet: descMatch ? descMatch[1].replace(/<[^>]*>/g, '').substring(0, 200) : '',
          source: 'Google_News',
          publishedDate: pubDateMatch ? new Date(pubDateMatch[1]).toISOString().split('T')[0] : null,
          score: 0.6,
          relevance: 0.6,
          origin: 'RSS_FEED'
        });
      }
    }

    console.log(`Google News found ${items.length} items for: ${query}`);
    return items.slice(0, 10);

  } catch (error) {
    console.error('Google News search error:', error.message);
    return [];
  }
}

/**
 * Search news using Bing News API (if key available)
 */
async function searchBingNews(query = '', options = {}) {
  const apiKey = process.env.BING_API_KEY;
  if (!apiKey) {
    return [];
  }

  try {
    const endpoint = 'https://api.bing.microsoft.com/v7.0/news/search';
    const params = new URLSearchParams({
      q: query,
      count: 10,
      offset: 0,
      mkt: 'en-US',
      safeSearch: 'Moderate'
    });

    const response = await fetch(`${endpoint}?${params}`, {
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const results = (data.value || []).map(item => ({
      title: item.name || '',
      url: item.url || '',
      snippet: item.description || '',
      source: item.provider?.[0]?.name || 'Bing',
      publishedDate: item.datePublished || null,
      score: 0.7,
      relevance: 0.7,
      origin: 'BING_API'
    }));

    console.log(`Bing News found ${results.length} items for: ${query}`);
    return results;

  } catch (error) {
    console.error('Bing News search error:', error.message);
    return [];
  }
}

/**
 * Unified news search with fallback chain
 */
async function searchNews(query = '', marketContext = {}, options = {}) {
  const { maxResults = 10, days = 7 } = options;
  const sources = options.sources || ['tavily', 'openai', 'google', 'bing'];

  console.log(`Starting multi-source news search for: ${query}`);

  // Try each source in order until we get results
  for (const source of sources) {
    let results = [];

    switch (source.toLowerCase()) {
      case 'tavily':
        results = await searchTavily(query, { maxResults, days });
        break;
      case 'openai':
        results = await searchOpenAINews(query, marketContext);
        break;
      case 'google':
        results = await searchGoogleNews(query);
        break;
      case 'bing':
        results = await searchBingNews(query, options);
        break;
    }

    if (results && results.length > 0) {
      console.log(`✅ Found ${results.length} results from ${source}`);
      return results.slice(0, maxResults);
    }

    console.log(`⚠️  No results from ${source}, trying next source...`);
  }

  console.log(`❌ No news found for: ${query}`);
  return [];
}

/**
 * Search multiple queries and aggregate results
 */
async function searchNewsMultiple(queries = [], marketContext = {}, options = {}) {
  if (!Array.isArray(queries) || queries.length === 0) {
    return [];
  }

  const allResults = [];
  const seenUrls = new Set();
  const MAX_SEEN_URLS = 1000; // Limit to prevent memory growth

  for (const query of queries) {
    const results = await searchNews(query, marketContext, options);
    
    for (const result of results) {
      // Deduplicate by URL
      if (result.url && !seenUrls.has(result.url)) {
        // Limit seenUrls to prevent unbounded growth
        if (seenUrls.size < MAX_SEEN_URLS) {
          seenUrls.add(result.url);
        }
        allResults.push(result);
      } else if (!result.url) {
        allResults.push(result);
      }
    }
  }

  // Sort by relevance/score
  allResults.sort((a, b) => (b.relevance || b.score || 0) - (a.relevance || a.score || 0));

  console.log(`Aggregated ${allResults.length} unique results from ${queries.length} queries`);
  return allResults.slice(0, options.maxResults || 15);
}

/**
 * Clear news cache
 */
function clearNewsCache() {
  newsCache.clear();
  console.log('News cache cleared');
}

/**
 * Get cache statistics
 */
function getCacheStats() {
  const now = Date.now();
  let total = 0;
  let expired = 0;
  let active = 0;

  for (const [key, value] of newsCache.entries()) {
    total++;
    if ((now - value.timestamp) >= CACHE_TTL_MS) {
      expired++;
    } else {
      active++;
    }
  }

  return { total, expired, active };
}

module.exports = {
  searchTavily,
  searchOpenAINews,
  searchGoogleNews,
  searchBingNews,
  searchNews,
  searchNewsMultiple,
  clearNewsCache,
  getCacheStats
};
