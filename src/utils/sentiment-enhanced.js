/**
 * Enhanced Sentiment Analysis Module
 * Provides sophisticated sentiment scoring for news and market data
 */

// Sentiment lexicons
const POSITIVE_WORDS = [
  'approval', 'surge', 'record', 'beats', 'wins', 'launch', 'uphold', 'favorable',
  'sec clears', 'momentum', 'support', 'rally', 'bullish', 'growth', 'expansion',
  'breakthrough', 'success', 'profit', 'gain', 'rise', 'increase', 'optimistic',
  'positive', 'strong', 'robust', 'exceed', 'outperform', 'upgrade', 'buy',
  'accumulate', 'hold', 'recommend', 'target', 'opportunity', 'undervalued',
  'oversold', 'rebound', 'recovery', 'stabilize', 'improve', 'innovative',
  'strategic', 'partnership', 'acquisition', 'merger', 'expansion', 'dividend',
  'earnings', 'revenue', 'guidance', 'outlook', 'forecast', 'guidance', 'upgrade'
];

const NEGATIVE_WORDS = [
  'probe', 'lawsuit', 'decline', 'drop', 'sell-off', 'delay', 'ban', 'halt',
  'investigation', 'bearish', 'recession', 'cuts', 'downgrade', 'concern',
  'risk', 'uncertainty', 'volatility', 'crash', 'plunge', 'slump', 'weakness',
  'miss', 'disappoint', 'fail', 'struggle', 'challenge', 'threat', 'warning',
  'negative', 'bearish', 'sell', 'reduce', 'cut', 'layoff', 'bankruptcy',
  'default', 'debt', 'loss', 'decline', 'decrease', 'pessimistic', 'concern',
  'caution', 'avoid', 'overvalued', 'overbought', 'bubble', 'correction', 'downturn',
  'slowdown', 'contraction', 'layoffs', 'downgrade', 'guidance', 'outlook'
];

const MODIFIER_WORDS = {
  'very': 1.5,
  'extremely': 2.0,
  'highly': 1.5,
  'significantly': 1.5,
  'substantially': 1.5,
  'moderately': 0.7,
  'slightly': 0.5,
  'somewhat': 0.5,
  'barely': 0.3,
  'marginally': 0.3
};

const INTENSIFIERS = ['!', '!!', '!!!', 'very', 'really', 'truly', 'absolutely'];

/**
 * Calculate basic sentiment score from text
 * @param {string} text - Text to analyze
 * @returns {number} - Sentiment score (-1 to 1)
 */
function calculateBasicSentiment(text) {
  if (!text || typeof text !== 'string') return 0;
  
  const normalized = text.toLowerCase();
  let score = 0;
  
  // Count positive and negative words
  POSITIVE_WORDS.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    const matches = normalized.match(regex);
    if (matches) {
      score += matches.length;
    }
  });
  
  NEGATIVE_WORDS.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    const matches = normalized.match(regex);
    if (matches) {
      score -= matches.length;
    }
  });
  
  // Normalize to -1 to 1 range
  const maxScore = Math.max(POSITIVE_WORDS.length, NEGATIVE_WORDS.length);
  return maxScore > 0 ? Math.max(-1, Math.min(1, score / maxScore)) : 0;
}

/**
 * Apply modifiers to sentiment score
 * @param {string} text - Text to analyze
 * @param {number} baseScore - Base sentiment score
 * @returns {number} - Modified sentiment score
 */
function applySentimentModifiers(text, baseScore) {
  if (!text || typeof text !== 'string') return baseScore;
  
  const normalized = text.toLowerCase();
  let modifier = 1;
  
  // Check for modifier words
  for (const [word, factor] of Object.entries(MODIFIER_WORDS)) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    if (regex.test(normalized)) {
      modifier = Math.max(0.3, Math.min(3, factor));
      break;
    }
  }
  
  // Check for intensifiers (exclamation marks)
  const exclamationCount = (text.match(/!/g) || []).length;
  if (exclamationCount > 0) {
    modifier *= (1 + (exclamationCount * 0.2));
  }
  
  return baseScore * modifier;
}

/**
 * Calculate sentiment with context awareness
 * @param {string} text - Text to analyze
 * @param {Object} context - Context information
 * @returns {Object} - Sentiment analysis with score and confidence
 */
function calculateContextualSentiment(text, context = {}) {
  try {
    const baseScore = calculateBasicSentiment(text);
    const modifiedScore = applySentimentModifiers(text, baseScore);
    
    // Calculate confidence based on text length and word count
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    const confidence = Math.min(1, wordCount / 10); // More words = higher confidence
    
    // Check for negation patterns
    const negationPatterns = ['not', 'no', "n't", "never", "don't", "doesn't", "won't"];
    const hasNegation = negationPatterns.some(pattern => text.toLowerCase().includes(pattern));
    
    // Adjust for negation
    let finalScore = modifiedScore;
    if (hasNegation) {
      finalScore *= -0.5; // Partial reversal
    }
    
    // Determine sentiment label
    let sentiment = 'NEUTRAL';
    if (finalScore > 0.2) sentiment = 'POSITIVE';
    else if (finalScore < -0.2) sentiment = 'NEGATIVE';
    
    return {
      score: Number(finalScore.toFixed(4)),
      sentiment,
      confidence: Number(confidence.toFixed(4)),
      baseScore: Number(baseScore.toFixed(4)),
      hasNegation,
      wordCount
    };
    
  } catch (error) {
    console.error('Contextual sentiment error:', error.message);
    return {
      score: 0,
      sentiment: 'NEUTRAL',
      confidence: 0,
      baseScore: 0,
      hasNegation: false,
      wordCount: 0
    };
  }
}

/**
 * Calculate sentiment for news article
 * @param {Object} article - News article with title and content
 * @returns {Object} - Enhanced sentiment analysis
 */
function analyzeNewsSentiment(article) {
  try {
    const title = article.title || article.name || '';
    const content = article.snippet || article.content || article.description || '';
    const fullText = `${title} ${content}`;
    
    const titleSentiment = calculateContextualSentiment(title);
    const contentSentiment = calculateContextualSentiment(content);
    const fullSentiment = calculateContextualSentiment(fullText);
    
    // Weight title higher (0.6) than content (0.4)
    const weightedScore = (titleSentiment.score * 0.6) + (contentSentiment.score * 0.4);
    const weightedConfidence = (titleSentiment.confidence * 0.6) + (contentSentiment.confidence * 0.4);
    
    // Determine overall sentiment
    let overallSentiment = 'NEUTRAL';
    if (weightedScore > 0.2) overallSentiment = 'POSITIVE';
    else if (weightedScore < -0.2) overallSentiment = 'NEGATIVE';
    
    // Calculate sentiment strength
    const strength = Math.abs(weightedScore);
    let strengthLabel = 'WEAK';
    if (strength > 0.6) strengthLabel = 'STRONG';
    else if (strength > 0.3) strengthLabel = 'MODERATE';
    
    return {
      score: Number(weightedScore.toFixed(4)),
      sentiment: overallSentiment,
      confidence: Number(weightedConfidence.toFixed(4)),
      strength: strengthLabel,
      titleSentiment: titleSentiment,
      contentSentiment: contentSentiment,
      fullSentiment: fullSentiment,
      message: `${strengthLabel} ${overallSentiment} sentiment (${(weightedScore * 100).toFixed(1)}%)`
    };
    
  } catch (error) {
    console.error('News sentiment error:', error.message);
    return {
      score: 0,
      sentiment: 'NEUTRAL',
      confidence: 0,
      strength: 'WEAK',
      message: 'Sentiment analysis failed'
    };
  }
}

/**
 * Calculate aggregate sentiment from multiple news articles
 * @param {Array<Object>} articles - Array of news articles
 * @returns {Object} - Aggregate sentiment analysis
 */
function calculateAggregateSentiment(articles) {
  if (!Array.isArray(articles) || articles.length === 0) {
    return {
      score: 0,
      sentiment: 'NEUTRAL',
      confidence: 0,
      count: 0,
      message: 'No articles to analyze'
    };
  }
  
  const sentiments = articles.map(article => analyzeNewsSentiment(article));
  
  // Calculate weighted average (weight by confidence)
  let weightedSum = 0;
  let totalWeight = 0;
  
  for (const sentiment of sentiments) {
    weightedSum += sentiment.score * sentiment.confidence;
    totalWeight += sentiment.confidence;
  }
  
  const avgScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const avgConfidence = sentiments.reduce((sum, s) => sum + s.confidence, 0) / sentiments.length;
  
  // Determine consensus
  const positiveCount = sentiments.filter(s => s.sentiment === 'POSITIVE').length;
  const negativeCount = sentiments.filter(s => s.sentiment === 'NEGATIVE').length;
  
  let consensus = 'NEUTRAL';
  if (positiveCount > negativeCount * 1.5) consensus = 'POSITIVE';
  else if (negativeCount > positiveCount * 1.5) consensus = 'NEGATIVE';
  
  // Calculate sentiment dispersion (agreement level)
  const variance = sentiments.reduce((sum, s) => sum + Math.pow(s.score - avgScore, 2), 0) / sentiments.length;
  const dispersion = Math.sqrt(variance);
  const agreement = Math.max(0, 1 - dispersion); // Higher = more agreement
  
  return {
    score: Number(avgScore.toFixed(4)),
    sentiment: consensus,
    confidence: Number(avgConfidence.toFixed(4)),
    count: articles.length,
    agreement: Number(agreement.toFixed(4)),
    positiveCount,
    negativeCount,
    message: `${articles.length} articles, ${consensus} consensus (${(avgScore * 100).toFixed(1)}%), agreement: ${(agreement * 100).toFixed(0)}%`
  };
}

/**
 * Calculate sentiment trend over time
 * @param {Array<Object>} articles - Array of articles with timestamps
 * @returns {Object} - Sentiment trend analysis
 */
function calculateSentimentTrend(articles) {
  if (!Array.isArray(articles) || articles.length < 2) {
    return {
      trend: 'NEUTRAL',
      change: 0,
      slope: 0,
      message: 'Insufficient data for trend analysis'
    };
  }
  
  // Sort by timestamp
  const sorted = [...articles].sort((a, b) => {
    const timeA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const timeB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return timeA - timeB;
  });
  
  // Calculate sentiment for each article
  const sentiments = sorted.map(article => analyzeNewsSentiment(article));
  
  // Calculate linear regression slope
  const n = sentiments.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += sentiments[i].score;
    sumXY += i * sentiments[i].score;
    sumX2 += i * i;
  }
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const change = sentiments[n-1].score - sentiments[0].score;
  
  // Determine trend
  let trend = 'NEUTRAL';
  if (slope > 0.05) trend = 'IMPROVING';
  else if (slope < -0.05) trend = 'DECLINING';
  
  return {
    trend,
    change: Number(change.toFixed(4)),
    slope: Number(slope.toFixed(4)),
    startScore: Number(sentiments[0].score.toFixed(4)),
    endScore: Number(sentiments[n-1].score.toFixed(4)),
    message: `Sentiment ${trend.toLowerCase()} (${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%)`
  };
}

module.exports = {
  calculateBasicSentiment,
  applySentimentModifiers,
  calculateContextualSentiment,
  analyzeNewsSentiment,
  calculateAggregateSentiment,
  calculateSentimentTrend
};
