/**
 * Enhanced Natural Language Processing for Market Identification
 * Improves market matching for natural language queries
 */

/**
 * Keyword expansion map for common terms and their synonyms
 */
const KEYWORD_EXPANSIONS = {
  crypto: ['bitcoin', 'ethereum', 'btc', 'eth', 'solana', 'crypto', 'cryptocurrency', 'blockchain', 'defi', 'web3', 'token', 'altcoin'],
  president: ['election', 'president', 'trump', 'biden', 'harris', 'vote', 'campaign', 'ballot', 'primary'],
  war: ['war', 'conflict', 'invasion', 'military', 'strike', 'ceasefire', 'troops', 'israel', 'gaza', 'ukraine', 'russia', 'iran'],
  sports: ['sports', 'football', 'soccer', 'basketball', 'nfl', 'nba', 'mlb', 'premier league', 'champions league', 'world cup', 'olympics'],
  tech: ['tech', 'technology', 'ai', 'artificial intelligence', 'gpt', 'claude', 'nvidia', 'tesla', 'spacex', 'elon musk', 'openai', 'google', 'microsoft'],
  economy: ['economy', 'economic', 'inflation', 'fed', 'federal reserve', 'recession', 'gdp', 'interest rate', 'jobs', 'unemployment'],
  entertainment: ['movie', 'film', 'oscar', 'academy award', 'emmy', 'grammy', 'hollywood', 'netflix', 'disney', 'music', 'album', 'concert'],
  politics: ['politics', 'senate', 'congress', 'parliament', 'democrat', 'republican', 'government', 'policy', 'election'],
  bitcoin: ['bitcoin', 'btc', 'crypto'],
  ethereum: ['ethereum', 'eth', 'crypto'],
  trump: ['trump', 'donald trump', 'president', 'election', 'republican'],
  biden: ['biden', 'joe biden', 'president', 'democrat'],
  ai: ['ai', 'artificial intelligence', 'gpt', 'claude', 'llm', 'machine learning', 'openai', 'anthropic']
};

/**
 * Extract keywords from a natural language query
 */
function extractKeywords(query) {
  const q = query.toLowerCase();
  const keywords = [];
  
  // Remove common stop words
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now']);
  
  // Extract words
  const words = q.split(/\s+/).filter(word => word.length > 2 && !stopWords.has(word));
  
  // Add expanded keywords
  words.forEach(word => {
    keywords.push(word);
    if (KEYWORD_EXPANSIONS[word]) {
      keywords.push(...KEYWORD_EXPANSIONS[word]);
    }
  });
  
  return [...new Set(keywords)]; // Remove duplicates
}

/**
 * Calculate enhanced similarity between query and market text
 */
function calculateEnhancedSimilarity(query, marketQuestion, marketDescription = '') {
  const queryKeywords = extractKeywords(query);
  const marketText = (marketQuestion + ' ' + marketDescription).toLowerCase();
  
  if (queryKeywords.length === 0) return 0;
  
  // Count matching keywords
  let matchCount = 0;
  queryKeywords.forEach(keyword => {
    if (marketText.includes(keyword)) {
      matchCount++;
    }
  });
  
  // Calculate base similarity
  const baseSimilarity = matchCount / queryKeywords.length;
  
  // Bonus for exact phrase matches
  const queryLower = query.toLowerCase();
  const questionLower = marketQuestion.toLowerCase();
  if (questionLower.includes(queryLower) || queryLower.includes(questionLower)) {
    return 1.0; // Perfect match
  }
  
  // Bonus for partial word matches (e.g., "trump" matches "donald trump")
  let partialMatchBonus = 0;
  queryKeywords.forEach(keyword => {
    if (keyword.length > 3) {
      const words = marketText.split(/\s+/);
      words.forEach(word => {
        if (word.includes(keyword) || keyword.includes(word)) {
          partialMatchBonus += 0.1;
        }
      });
    }
  });
  
  // Calculate final similarity with bonus
  let finalSimilarity = baseSimilarity + (partialMatchBonus / queryKeywords.length);
  
  // Cap at 1.0
  return Math.min(1.0, finalSimilarity);
}

/**
 * Filter markets by query intent
 */
function filterMarketsByIntent(markets, query) {
  const q = query.toLowerCase();
  
  // Detect intent from query
  const intents = {
    crypto: /\b(crypto|bitcoin|ethereum|btc|eth|blockchain|defi|web3|token|altcoin)\b/i.test(q),
    politics: /\b(president|election|trump|biden|harris|vote|campaign|senate|congress|parliament|government|politics)\b/i.test(q),
    war: /\b(war|conflict|invasion|military|strike|ceasefire|troops|israel|gaza|ukraine|russia|iran)\b/i.test(q),
    sports: /\b(sports|football|soccer|basketball|nfl|nba|mlb|premier|league|champions|world|cup|olympics)\b/i.test(q),
    tech: /\b(tech|technology|ai|gpt|claude|nvidia|tesla|spacex|elon|musk|openai|google|microsoft)\b/i.test(q),
    economy: /\b(economy|economic|inflation|fed|federal|reserve|recession|gdp|interest|rate|jobs|unemployment)\b/i.test(q),
    entertainment: /\b(movie|film|oscar|academy|award|emmy|grammy|hollywood|netflix|disney|music|album|concert)\b/i.test(q)
  };
  
  // If no specific intent detected, return all markets
  const hasIntent = Object.values(intents).some(detected => detected);
  if (!hasIntent) return markets;
  
  // Filter markets based on detected intents
  return markets.filter(market => {
    const question = (market.question || '').toLowerCase();
    const description = (market.description || '').toLowerCase();
    const text = question + ' ' + description;
    
    // Match if any detected intent matches the market
    return Object.entries(intents).some(([intent, detected]) => {
      if (!detected) return false;
      
      // Check if market matches the intent
      switch (intent) {
        case 'crypto':
          return /\b(bitcoin|ethereum|btc|eth|solana|crypto|cryptocurrency|blockchain|defi|web3|token|altcoin)\b/i.test(text);
        case 'politics':
          return /\b(president|election|trump|biden|harris|vote|campaign|senate|congress|parliament|government|politics)\b/i.test(text);
        case 'war':
          return /\b(war|conflict|invasion|military|strike|ceasefire|troops|israel|gaza|ukraine|russia|iran)\b/i.test(text);
        case 'sports':
          return /\b(sports|football|soccer|basketball|nfl|nba|mlb|premier|league|champions|world|cup|olympics)\b/i.test(text);
        case 'tech':
          return /\b(tech|technology|ai|gpt|claude|nvidia|tesla|spacex|elon|musk|openai|google|microsoft)\b/i.test(text);
        case 'economy':
          return /\b(economy|economic|inflation|fed|federal|reserve|recession|gdp|interest|rate|jobs|unemployment)\b/i.test(text);
        case 'entertainment':
          return /\b(movie|film|oscar|academy|award|emmy|grammy|hollywood|netflix|disney|music|album|concert)\b/i.test(text);
        default:
          return true;
      }
    });
  });
}

/**
 * Find best matching market for a natural language query
 */
function findBestMatchingMarket(markets, query, options = {}) {
  const { minSimilarity = 0.15, maxResults = 5 } = options;
  
  // Filter markets by intent first
  const filteredMarkets = filterMarketsByIntent(markets, query);
  
  // Calculate similarity for each market
  const scoredMarkets = filteredMarkets.map(market => {
    const similarity = calculateEnhancedSimilarity(
      query,
      market.question || '',
      market.description || ''
    );
    return {
      market,
      similarity,
      source: 'nlp_similarity'
    };
  });
  
  // Sort by similarity (highest first)
  scoredMarkets.sort((a, b) => b.similarity - a.similarity);
  
  // Filter by minimum similarity
  const validMatches = scoredMarkets.filter(m => m.similarity >= minSimilarity);
  
  // Return top results
  return validMatches.slice(0, maxResults);
}

module.exports = {
  extractKeywords,
  calculateEnhancedSimilarity,
  filterMarketsByIntent,
  findBestMatchingMarket,
  KEYWORD_EXPANSIONS
};
