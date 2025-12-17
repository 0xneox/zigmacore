
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const GAMMA = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';
const CACHE_FILE = path.join(__dirname, '..', 'cache', 'last_snapshot.json');

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
    console.log(`❌ Invalid outcome arrays for ${market.question} (outcomes: ${typeof outcomes}, prices: ${typeof outcomePrices})`);
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

  // If any outcome has probability >99.5% or <0.5%, it's essentially dead
  return outcomePrices.some(p => p >= 0.995 || p <= 0.005);
}

function classifyMarket(question) {
  const q = question.toLowerCase();

  if (/bitcoin|ethereum|btc|eth|crypto|solana|bnb|ada|doge/i.test(q)) {
    return "CRYPTO";
  }
  if (/recession|inflation|fed|fed rate|gdp|unemployment|economy/i.test(q)) {
    return "MACRO";
  }
  if (/election|president|trump|biden|senate|congress|political|government/i.test(q)) {
    return "POLITICAL";
  }
  if (/gold|silver|oil|commodity|stock|company|market cap|nvidia|apple|microsoft|tesla/i.test(q)) {
    return "FINANCIAL";
  }

  return "EVENT";
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

/* =========================
   Metrics computation
========================= */
async function computeMetrics(markets, cache) {
  let countInactive = 0,
    countClosed = 0,
    countExpired = 0,
    countLowLiquidity = 0,
    countDeadMarkets = 0;

  const filteredMarkets = markets.filter(m => {
    if (!m.active) {
      countInactive++;
      return false;
    }
    if (m.closed) {
      countClosed++;
      return false;
    }

    if (m.endDateIso) {
      const end = new Date(m.endDateIso);
      if (end <= new Date()) {
        countExpired++;
        return false;
      }
    }

    const liquidity = Number(m.liquidity || 0);
    if (liquidity < 1000) {
      countLowLiquidity++;
      return false;
    }

    return true;
  });

  console.log(
    `Filter counts: !active=${countInactive}, closed=${countClosed}, expired=${countExpired}, lowLiquidity=${countLowLiquidity}`
  );
  console.log(`📊 Filtered ${markets.length} → ${filteredMarkets.length}`);

  const enriched = await Promise.all(
    filteredMarkets.map(async m => {
      // Normalize market data first (parse JSON strings to arrays)
      const normalizedMarket = normalizeMarketData(m);
      if (!normalizedMarket) {
        return null;
      }

      // Filter out dead markets (extreme probabilities)
      if (isDeadMarket(normalizedMarket)) {
        countDeadMarkets++;
        return null;
      }

      const id = normalizedMarket.slug || normalizedMarket.id || normalizedMarket.question;
      const last = cache[id] || {};

      /* ---- price extraction (Gamma) ---- */
      // Debug: Log the first few markets to see structure
      if (normalizedMarket === filteredMarkets[0]) {
        console.log('🕵️ DEBUG: First market structure:', JSON.stringify(normalizedMarket, null, 2).slice(0, 1000));
      }

      // Use normalized data
      const outcomes = normalizedMarket.outcomes || normalizedMarket.options;
      const outcomePrices = normalizedMarket.outcomePrices || normalizedMarket.prices;

      const prices = [];
      for (let i = 0; i < outcomes.length; i++) {
        const p = Number(outcomePrices[i]);
        if (!isNaN(p) && p > 0 && p < 1) {
          prices.push({ outcome: outcomes[i], price: p });
        }
      }

      if (prices.length < 2) {
        console.log(`❌ Invalid prices for ${m.question}, skipping`);
        return null;
      }

      const yes = prices.find(p => p.outcome.toLowerCase() === 'yes');
      const no = prices.find(p => p.outcome.toLowerCase() === 'no');

      if (!yes || !no) {
        console.log(`❌ Non-binary outcomes for ${m.question}, skipping`);
        return null;
      }

      const yesPrice = yes.price;
      const noPrice = no.price;

      const lastPrice =
        typeof last.price === 'number' && last.price > 0 && last.price < 1
          ? last.price
          : yesPrice;

      const priceChange =
        lastPrice > 0 && lastPrice < 1
          ? (yesPrice - lastPrice) / lastPrice
          : 0;

      const volume =
        Number(m.volume24hr ?? m.volume_24h ?? m.volume ?? 0) || 0;
      const liquidity = Number(m.liquidity) || 0;
      const lastVolume = Number(last.volume || 0);
      const volumeChange = volume - lastVolume;

      // Add market classification
      const marketType = classifyMarket(m.question);

      return {
        id,
        question: m.question,
        yesPrice,
        noPrice,
        volume,
        liquidity,
        priceChange,
        volumeChange,
        lastPrice,
        marketType
      };
    })
  );

  const validMarkets = enriched.filter(Boolean);
  console.log(
    `💰 ${validMarkets.length} markets with valid prices for analysis (filtered ${countDeadMarkets} dead markets)`
  );

  /* ---- update cache ---- */
  validMarkets.forEach(m => {
    const marketId = m.id;
    const currentPrice = m.yesPrice;
    const currentTime = Date.now();

    // Get existing cache entry
    const existing = cache[marketId] || {};

    // Update price history for momentum tracking
    const priceHistory = existing.priceHistory || [];
    priceHistory.push({
      price: currentPrice,
      timestamp: currentTime
    });

    // Keep only last 10 minutes of history (for 1m and 5m calculations)
    const tenMinutesAgo = currentTime - (10 * 60 * 1000);
    const recentHistory = priceHistory.filter(entry => entry.timestamp > tenMinutesAgo);

    cache[marketId] = {
      price: currentPrice,
      volume: m.volume,
      priceHistory: recentHistory
    };
  });

  saveCache(cache);
  return validMarkets;
}

/* =========================
   Market selection
========================= */
function pickMarkets(enriched) {
  const byVolume = [...enriched]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5);

  const byMovement = [...enriched]
    .sort((a, b) => Math.abs(b.priceChange) - Math.abs(a.priceChange))
    .slice(0, 5);

  const extremeProbs = [...enriched]
    .sort(
      (a, b) =>
        Math.abs(0.5 - b.yesPrice) - Math.abs(0.5 - a.yesPrice)
    )
    .slice(0, 3);

  console.log('⚡ Extreme probability markets:');
  extremeProbs.forEach(m => {
    const dir = m.yesPrice >= 0.5 ? 'YES' : 'NO';
    const prob = m.yesPrice >= 0.5 ? m.yesPrice : 1 - m.yesPrice;
    console.log(
      `- ${m.question.slice(0, 60)}: ${dir} ${(prob * 100).toFixed(
        1
      )}% | Vol $${m.volume.toLocaleString()}`
    );
  });

  const aboutToBond = enriched
    .filter(m => m.yesPrice > 0.7 || m.yesPrice < 0.3)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 3);

  console.log(
    `Market selection: ${byVolume.length} by volume, ${byMovement.length} by movement, ${aboutToBond.length} high-probability`
  );

  return Array.from(
    new Map(
      [...byVolume, ...byMovement, ...aboutToBond].map(m => [m.id, m])
    ).values()
  );
}

module.exports = {
  loadCache,
  saveCache,
  computeMetrics,
  pickMarkets
};

