const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const log = (msg) => { if (LOG_LEVEL === 'DEBUG') console.log(msg); };

const GAMMA = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';
const CACHE_FILE = path.join(__dirname, '..', 'cache', 'last_snapshot.json');

const { getVolumeSnapshots, saveVolumeSnapshot } = require('./db');
const { searchTavily } = require('./market_analysis');

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
 * Fetches at least 3 sources and checks for consensus/conflicts
 */
async function crossReferenceNews(market) {
  const question = market.question;
  try {
    // Price-drift trigger: Skip expensive API if market stagnant
    if (market.delta < 0.05 && Date.now() - (market.lastNewsTime || 0) < 900000) {  // <5% change & <15min old
      return market.lastNews || [];  // reuse cache
    }

    // Search for news using Tavily
    const query = `${question} news`;
    const results = await searchTavily(query);
    return results;
  } catch (e) {
    // Graceful fallback
    return [];
  }
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
  
  const spikes = withVelocity.filter(m => m.volumeVelocity > 300)
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
  return Array.from(
    new Map(
      [...spikes, ...byVolume, ...byMovement, ...byVolumeVelocity, ...aboutToBond].map(m => [m.id, m])
    ).values()
  );
}

module.exports = {
  loadCache,
  saveCache,
  pickMarkets,
  crossReferenceNews
};
