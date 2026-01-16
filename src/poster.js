const { TwitterApi } = require('twitter-api-v2');
require('dotenv').config();

const SAFE_MODE = process.env.SAFE_MODE !== 'false';

// Constants for tweet validation
const MAX_TWEET_LENGTH = 280; // Twitter/X character limit
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_TWEETS = 300; // Twitter rate limit for tweets

// Rate limiting state
let tweetCount = 0;
let rateLimitWindowStart = Date.now();

// Simple rate limiter
function checkRateLimit() {
  const now = Date.now();
  if (now - rateLimitWindowStart > RATE_LIMIT_WINDOW_MS) {
    // Reset window
    tweetCount = 0;
    rateLimitWindowStart = now;
  }
  
  if (tweetCount >= RATE_LIMIT_MAX_TWEETS) {
    throw new Error(`Rate limit exceeded: ${tweetCount} tweets in ${RATE_LIMIT_WINDOW_MS / 60000} minutes`);
  }
  
  tweetCount++;
}

// Validate tweet before posting
function validateTweet(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Tweet text must be a non-empty string');
  }
  
  if (text.length > MAX_TWEET_LENGTH) {
    throw new Error(`Tweet too long: ${text.length} characters (max ${MAX_TWEET_LENGTH})`);
  }
  
  // Check for potentially problematic content
  const suspiciousPatterns = [
    /<script/i,
    /javascript:/i,
    /onerror=/i,
    /onclick=/i
  ];
  
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(text)) {
      console.warn('[POSTER] Suspicious pattern detected in tweet:', pattern);
    }
  }
  
  return true;
}

// Retry wrapper with exponential backoff
async function retryWithBackoff(fn, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[POSTER] Retry ${attempt}/${retries} after ${delay}ms delay: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function postToX(text) {
  try {
    if (SAFE_MODE) {
      console.log('SAFE_MODE: Would post to X:', text.substring(0, 100) + '...');
      return { mock: true, text: text.substring(0, 100) };
    }

    // Validate tweet before attempting to post
    validateTweet(text);
    
    // Check rate limit
    checkRateLimit();

    // Initialize client only when actually posting (credentials not kept in memory)
    const client = new TwitterApi({
      appKey: process.env.X_API_KEY,
      appSecret: process.env.X_API_SECRET,
      accessToken: process.env.X_ACCESS_TOKEN,
      accessSecret: process.env.X_ACCESS_SECRET,
    });

    // Post with retry logic
    const tweet = await retryWithBackoff(async () => {
      return await client.v2.tweet(text);
    });
    
    console.log('Posted to X:', tweet.data.id);
    return { success: true, id: tweet.data.id };
    
  } catch (error) {
    console.error('Error posting to X:', error.message);
    return { error: error.message };
  }
}

module.exports = { postToX };
