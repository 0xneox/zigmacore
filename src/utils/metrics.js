const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const { classifyMarket } = require('./classifier');

const GAMMA = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';
const CACHE_FILE = path.join(__dirname, '..', 'cache', 'last_snapshot.json');
// v1.5.1 – Data-driven priors (from web_search – politics ~42% YES, crypto ~55%, etc)
const CATEGORY_PRIORS = {
  POLITICS: 0.42, // Historical YES rate
  CRYPTO: 0.55,
  ENTERTAINMENT: 0.48,
  TECH: 0.60,
  MACRO: 0.50,
  // Add more from search
};

const VERBOSE_MARKET_LOGS = (process.env.VERBOSE_MARKET_LOGS || '').toLowerCase() === 'true';

const { getVolumeSnapshots, saveVolumeSnapshot } = require('../db');

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
    console.log(`❌ Invalid outcome arrays for ${market.question}, skipping`);
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

/* =========================
   Metrics computation
========================= */
async function computeMetrics(markets, cache) {
  let countInactive = 0,
    countClosed = 0,
    countExpired = 0,
    countLowLiquidity = 0,
    countDeadMarkets = 0,
    countNonBinary = 0;

  const filteredMarkets = markets.filter(m => {
    if (!m.active) {
      countInactive++;
      return false;
    }
    if (m.closed) {
      countClosed++;
      return false;
    }

    // Check for resolved markets (markets with an outcome are resolved)
    if (m.outcome || m.outcomeType) {
      countClosed++;
      return false;
    }

    // Check multiple date fields for expiration
    const endDateFields = ['endDateIso', 'endDate', 'end_date', 'expirationDate', 'expiration_date'];
    let hasExpired = false;
    for (const field of endDateFields) {
      if (m[field]) {
        const end = new Date(m[field]);
        // Add 1 hour buffer to account for timezone differences
        if (end <= new Date(Date.now() - 3600000)) {
          countExpired++;
          hasExpired = true;
          break;
        }
      }
    }
    if (hasExpired) return false;

    // Also check start date - if start date is in the future, market hasn't started yet
    const startDateFields = ['startDateIso', 'startDate', 'start_date'];
    for (const field of startDateFields) {
      if (m[field]) {
        const start = new Date(m[field]);
        if (start > new Date(Date.now() + 86400000)) {
          countDeadMarkets++;
          return false;
        }
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
      if (VERBOSE_MARKET_LOGS && normalizedMarket === filteredMarkets[0]) {
        console.log('🕵️ DEBUG: First market structure:', JSON.stringify(normalizedMarket, null, 2).slice(0, 1000));
      }

      // Debug specific market
      if (VERBOSE_MARKET_LOGS && m.question.includes("Russia")) {
        console.log(`DEBUG DATA for ${m.question}:`, m.outcomePrices);
      }

      // Use normalized data
      const outcomes = normalizedMarket.outcomes || normalizedMarket.options;
      const outcomePrices = normalizedMarket.outcomePrices || normalizedMarket.prices;

      const prices = [];
      for (let i = 0; i < outcomes.length; i++) {
        const p = Number(outcomePrices[i]);
        if (!isNaN(p) && p >= 0 && p <= 1) {
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
        countNonBinary++;
        if (VERBOSE_MARKET_LOGS) {
          console.log(`❌ Non-binary outcomes for ${m.question}, skipping`);
        }
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
      const volumeVelocity = lastVolume > 0 ? (volumeChange / lastVolume) * 100 : 0; // Percentage change

      // Log significant volume spikes
      if (volumeVelocity > 300) {
        console.log(`🚀 VOLUME SPIKE DETECTED: ${m.question.slice(0, 50)}... ${volumeVelocity.toFixed(0)}% volume increase in last 10 minutes!`);
      }

      // Keep only last 60 minutes of history (for Delta Sniper)
      const sixtyMinutesAgo = Date.now() - (60 * 60 * 1000);
      const recentPriceHistory = (last.priceHistory || []).filter(entry => entry.timestamp > sixtyMinutesAgo);
      const recentVolumeHistory = getVolumeSnapshots(m.id, sixtyMinutesAgo);

      // Calculate Volume Velocity
      let avgVvel = 0;
      if (recentVolumeHistory.length > 1) {
        const vvels = [];
        for (let i = 1; i < recentVolumeHistory.length; i++) {
          const deltaVol = recentVolumeHistory[i].volume - recentVolumeHistory[i-1].volume;
          const deltaTime = (recentVolumeHistory[i].timestamp - recentVolumeHistory[i-1].timestamp) / 1000;
          if (deltaTime > 0) vvels.push(deltaVol / deltaTime);
        }
        avgVvel = vvels.length > 0 ? vvels.reduce((a, b) => a + b, 0) / vvels.length : 0;
      }
      const currentVvel = recentVolumeHistory.length > 0 ? (m.volume - recentVolumeHistory[recentVolumeHistory.length - 1].volume) / ((Date.now() - recentVolumeHistory[recentVolumeHistory.length - 1].timestamp) / 1000) : 0;

      const priceVolatility = calculateStdDev(recentPriceHistory.map(p => p.price));

      // Normalize start date for downstream detectors
      const rawStartDateIso =
        normalizedMarket.startDateIso ||
        normalizedMarket.start_date_iso ||
        normalizedMarket.startDate ||
        normalizedMarket.start_date ||
        normalizedMarket.createdAt ||
        normalizedMarket.created_at ||
        normalizedMarket.creationTime ||
        normalizedMarket.creation_time ||
        normalizedMarket.openDate ||
        normalizedMarket.open_date ||
        normalizedMarket.timestamp ||
        normalizedMarket.listedAt ||
        normalizedMarket.listed_at ||
        null;
      const startDateIso = rawStartDateIso || last.startDateIso || null;

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
        volumeVelocity,
        lastPrice,
        marketType,
        tokens: m.tokens || [],
        priceVolatility,
        priceHistory: recentPriceHistory,
        volumeHistory: recentVolumeHistory,
        vVel: currentVvel,
        avgVvel: avgVvel,
        startDateIso,
        basePrior: CATEGORY_PRIORS[marketType] || 0.5
      };
    })
  );

  const validMarkets = enriched.filter(Boolean);
  console.log(
    `💰 ${validMarkets.length} markets with valid prices for analysis (filtered ${countDeadMarkets} dead markets)`
  );
  if (countNonBinary) {
    console.log(
      `❌ Skipped ${countNonBinary} markets with non-binary outcomes${VERBOSE_MARKET_LOGS ? '' : ' (set VERBOSE_MARKET_LOGS=true for details)'}`
    );
  }

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

    // Keep only last 60 minutes of price history
    const sixtyMinutesAgo = currentTime - (60 * 60 * 1000);
    const recentPriceHistory = priceHistory.filter(entry => entry.timestamp > sixtyMinutesAgo);

    const priceVolatility = calculateStdDev(recentPriceHistory.map(p => p.price));

    // Save volume snapshot to database
    saveVolumeSnapshot(marketId, m.volume, currentTime);

    cache[marketId] = {
      price: currentPrice,
      volume: m.volume,
      priceHistory: recentPriceHistory,
      priceVolatility,
      volumeHistory: m.volumeHistory || [],
      avgVvel: m.avgVvel,
      vVel: m.vVel,
      startDateIso: m.startDateIso || null
    };
  });

  saveCache(cache);
  return validMarkets;
}

module.exports = { computeMetrics };
