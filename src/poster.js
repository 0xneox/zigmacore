const { TwitterApi } = require('twitter-api-v2');
require('dotenv').config();

const SAFE_MODE = process.env.SAFE_MODE !== 'false';

async function postToX(text) {
  try {
    if (SAFE_MODE) {
      console.log('SAFE_MODE: Would post to X:', text.substring(0, 100) + '...');
      return { mock: true, text: text.substring(0, 100) };
    }

    // Initialize client only when actually posting
    const client = new TwitterApi({
      appKey: process.env.X_API_KEY,
      appSecret: process.env.X_API_SECRET,
      accessToken: process.env.X_ACCESS_TOKEN,
      accessSecret: process.env.X_ACCESS_SECRET,
    });

    const tweet = await client.v2.tweet(text);
    console.log('Posted to X:', tweet.data.id);
    return { success: true, id: tweet.data.id };
  } catch (error) {
    console.error('Error posting to X:', error);
    return { error: error.message };
  }
}

module.exports = { postToX };
