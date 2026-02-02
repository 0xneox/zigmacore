/**
 * Crypto Price Integration Module
 * Fetches real-time crypto prices from CoinGecko API (free tier)
 * Provides correlation analysis for crypto prediction markets
 */

const fetch = require('node-fetch');

// CoinGecko API endpoint (free, no API key required)
const COINGECKO_API = 'https://api.coingecko.com/api/v3';

// Cache for crypto prices (refresh every 5 minutes)
let priceCache = null;
let lastFetch = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch current crypto prices from CoinGecko
 * @returns {Object} Price data for BTC, ETH, SOL
 */
async function fetchCryptoPrices() {
  try {
    const now = Date.now();
    
    // Return cached data if still fresh
    if (priceCache && (now - lastFetch) < CACHE_DURATION) {
      return priceCache;
    }

    // Fetch fresh data
    const response = await fetch(
      `${COINGECKO_API}/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`
    );

    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Transform to our format
    priceCache = {
      bitcoin: {
        price: data.bitcoin.usd,
        change24h: data.bitcoin.usd_24h_change,
        volume24h: data.bitcoin.usd_24h_vol,
        symbol: 'BTC'
      },
      ethereum: {
        price: data.ethereum.usd,
        change24h: data.ethereum.usd_24h_change,
        volume24h: data.ethereum.usd_24h_vol,
        symbol: 'ETH'
      },
      solana: {
        price: data.solana.usd,
        change24h: data.solana.usd_24h_change,
        volume24h: data.solana.usd_24h_vol,
        symbol: 'SOL'
      },
      timestamp: now
    };

    lastFetch = now;
    console.log('[CRYPTO] Fetched prices:', {
      BTC: priceCache.bitcoin.price,
      ETH: priceCache.ethereum.price,
      SOL: priceCache.solana.price
    });

    return priceCache;
  } catch (error) {
    console.error('[CRYPTO] Failed to fetch prices:', error.message);
    
    // Return cached data if available, even if stale
    if (priceCache) {
      console.log('[CRYPTO] Using stale cache due to fetch error');
      return priceCache;
    }
    
    // Return null if no cache available
    return null;
  }
}

/**
 * Calculate implied price from prediction market
 * For "Will Bitcoin hit $150k by June?" at 65% YES
 * Implied price = current_price + (target - current) * probability
 * 
 * @param {Object} market - Market data
 * @param {number} currentPrice - Current spot price
 * @returns {number} Implied price
 */
function calculateImpliedPrice(market, currentPrice) {
  try {
    const question = market.question || market.marketQuestion || '';
    
    // Extract target price from question
    // Matches: "$150k", "$150,000", "150k", "150000"
    const priceMatch = question.match(/\$?([\d,]+)k?/i);
    if (!priceMatch) return null;
    
    let targetPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
    
    // Handle 'k' suffix (150k = 150000)
    if (question.toLowerCase().includes('k') && targetPrice < 1000) {
      targetPrice *= 1000;
    }
    
    // Get market probability
    const probability = market.probZigma ? market.probZigma / 100 : market.predictedProbability || 0.5;
    
    // Calculate implied price
    // If market says 65% chance of hitting $150k, implied = current + (150k - current) * 0.65
    const impliedPrice = currentPrice + (targetPrice - currentPrice) * probability;
    
    return {
      targetPrice,
      currentPrice,
      probability,
      impliedPrice,
      upside: targetPrice - currentPrice,
      impliedUpside: impliedPrice - currentPrice,
      impliedReturn: ((impliedPrice - currentPrice) / currentPrice) * 100
    };
  } catch (error) {
    console.error('[CRYPTO] Failed to calculate implied price:', error.message);
    return null;
  }
}

/**
 * Enhance crypto signals with spot price correlation
 * @param {Object} signal - Trading signal
 * @param {Object} cryptoPrices - Current crypto prices
 * @returns {Object} Enhanced signal
 */
function enhanceCryptoSignal(signal, cryptoPrices) {
  if (!cryptoPrices || signal.category !== 'CRYPTO') {
    return signal;
  }

  try {
    const question = (signal.question || signal.marketQuestion || '').toLowerCase();
    
    // Identify which crypto this market is about
    let crypto = null;
    let spotPrice = null;
    
    if (question.includes('bitcoin') || question.includes('btc')) {
      crypto = 'bitcoin';
      spotPrice = cryptoPrices.bitcoin.price;
    } else if (question.includes('ethereum') || question.includes('eth')) {
      crypto = 'ethereum';
      spotPrice = cryptoPrices.ethereum.price;
    } else if (question.includes('solana') || question.includes('sol')) {
      crypto = 'solana';
      spotPrice = cryptoPrices.solana.price;
    }
    
    if (!crypto || !spotPrice) {
      return signal;
    }
    
    // Calculate implied price
    const impliedData = calculateImpliedPrice(signal, spotPrice);
    
    // Add crypto-specific data to signal
    const enhanced = {
      ...signal,
      crypto: {
        asset: cryptoPrices[crypto].symbol,
        spotPrice,
        change24h: cryptoPrices[crypto].change24h,
        volume24h: cryptoPrices[crypto].volume24h,
        ...impliedData
      }
    };
    
    // Add volatility alert if 24h change is significant
    if (Math.abs(cryptoPrices[crypto].change24h) > 5) {
      enhanced.crypto.volatilityAlert = {
        level: Math.abs(cryptoPrices[crypto].change24h) > 10 ? 'HIGH' : 'MEDIUM',
        message: `${cryptoPrices[crypto].symbol} moved ${cryptoPrices[crypto].change24h.toFixed(2)}% in 24h`
      };
    }
    
    console.log(`[CRYPTO] Enhanced ${crypto} signal:`, {
      market: signal.question?.slice(0, 50),
      spotPrice,
      impliedPrice: impliedData?.impliedPrice,
      edge: signal.effectiveEdge
    });
    
    return enhanced;
  } catch (error) {
    console.error('[CRYPTO] Failed to enhance signal:', error.message);
    return signal;
  }
}

/**
 * Get crypto market summary for dashboard
 * @returns {Object} Crypto market summary
 */
async function getCryptoSummary() {
  const prices = await fetchCryptoPrices();
  if (!prices) return null;
  
  return {
    bitcoin: {
      price: prices.bitcoin.price,
      change24h: prices.bitcoin.change24h,
      trend: prices.bitcoin.change24h > 0 ? 'UP' : 'DOWN',
      volatility: Math.abs(prices.bitcoin.change24h) > 5 ? 'HIGH' : 'NORMAL'
    },
    ethereum: {
      price: prices.ethereum.price,
      change24h: prices.ethereum.change24h,
      trend: prices.ethereum.change24h > 0 ? 'UP' : 'DOWN',
      volatility: Math.abs(prices.ethereum.change24h) > 5 ? 'HIGH' : 'NORMAL'
    },
    solana: {
      price: prices.solana.price,
      change24h: prices.solana.change24h,
      trend: prices.solana.change24h > 0 ? 'UP' : 'DOWN',
      volatility: Math.abs(prices.solana.change24h) > 5 ? 'HIGH' : 'NORMAL'
    },
    timestamp: prices.timestamp
  };
}

module.exports = {
  fetchCryptoPrices,
  calculateImpliedPrice,
  enhanceCryptoSignal,
  getCryptoSummary
};
