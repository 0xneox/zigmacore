const axios = require('axios');
const axiosRetry = require('axios-retry').default || require('axios-retry');
require('dotenv').config();

// Create a custom axios instance with retry logic
const http = axios.create({
  timeout: parseInt(process.env.REQUEST_TIMEOUT) || 20000,  // Increased timeout to 20 seconds
  headers: {
    'User-Agent': 'Oracle-of-Poly/1.0',
    'Accept': 'application/json',
    'Cache-Control': 'no-cache'
  }
});

// Configure retry logic with exponential backoff
axiosRetry(http, { 
  retries: parseInt(process.env.MAX_RETRIES) || 3,
  retryDelay: (retryCount) => {
    const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff
    console.log(`Retry attempt ${retryCount}, retrying in ${delay}ms...`);
    return delay;
  },
  retryCondition: (error) => {
    // Retry on network errors, timeouts, and 5xx responses
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || 
           (error.code === 'ECONNABORTED') ||
           (error.response && error.response.status >= 500);
  }
});

const GAMMA = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';

/**
 * Fetch active Polymarket markets from Gamma API
 * - Includes retry logic with exponential backoff
 * - Normalizes response to a clean array
 * - Defensive against API shape changes
 */
async function fetchMarkets(limit = 500, offset = 0) {  // Reduced default limit
  const url = `${GAMMA}/markets?closed=false&limit=${limit}&offset=${offset}`;
  console.log(`🌐 FETCH: ${url} (Timeout: ${http.defaults.timeout}ms)`);

  try {
    const startTime = Date.now();
    const res = await http.get(url);
    const endTime = Date.now();
    
    console.log(`✅ Fetched ${res.data.length || 0} markets in ${endTime - startTime}ms`);

    let markets = [];

    // Gamma API (current): array
    if (Array.isArray(res.data)) {
      markets = res.data;
    }
    // { markets: [...] }
    else if (res.data?.markets && Array.isArray(res.data.markets)) {
      markets = res.data.markets;
    }
    // { data: [...] }
    else if (res.data?.data && Array.isArray(res.data.data)) {
      markets = res.data.data;
    }
    // Object with numeric keys
    else if (
      res.data &&
      typeof res.data === 'object' &&
      Object.keys(res.data).every(k => !isNaN(k))
    ) {
      markets = Object.values(res.data);
    } else {
      console.error(
        '❌ Unknown Gamma response shape:',
        typeof res.data === 'object' ? Object.keys(res.data).slice(0, 10) : typeof res.data
      );
      return [];
    }

    console.log(`✅ Fetched ${markets.length} markets`);

    // Hard sanity filter (cheap + safe)
    markets = markets.filter(m =>
      m &&
      m.question &&
      m.active === true &&
      m.closed === false
    );

    console.log(`📊 After sanity filter: ${markets.length}`);
    return markets;
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      console.error(`❌ Request timed out after ${http.defaults.timeout}ms`);
    } else if (err.response) {
      console.error(`❌ API Error: ${err.response.status} - ${err.response.statusText}`);
      if (err.response.data) {
        console.error('❌ Response data:', JSON.stringify(err.response.data).slice(0, 200));
      }
    } else if (err.request) {
      console.error('❌ Network Error: No response received from server');
    } else {
      console.error('❌ Error fetching markets:', err.message);
    }
    return [];
  }
}

module.exports = { fetchMarkets };