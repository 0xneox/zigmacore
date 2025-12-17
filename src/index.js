const fs = require('fs');
const path = require('path');
require('dotenv').config();

const cron = require('node-cron');
const { fetchMarkets } = require('./fetcher');
const { loadCache, saveCache, computeMetrics, pickMarkets } = require('./processor');
const { generateDecrees, generateEnhancedAnalysis } = require('./llm');
const { postToX } = require('./poster');
const { postDeepDiveOnACP } = require('./acp');
const { getPriceAlertManager } = require('./price_alerts');
const { getMarketAnalyzer } = require('./market_analysis');
const { getClobPrice, startPolling, stopPolling, getOrderBook } = require('./clob_price_cache');
const INSIGHTS_FILE = path.join(__dirname, '..', 'oracle_insights.txt');
const CONSOLE_LOG_FILE = path.join(__dirname, '..', 'console_output.log');
const PERSONAL_TRADES_FILE = path.join(__dirname, '..', 'personal_trades.txt');

// Global health tracking
let systemHealth = {
  posts: 0,
  marketsMonitored: 0,
  lastRun: null,
  alertsActive: 0
};

// Canonical price function - uses CLOB first, Gamma fallback
function getYesNoPrices(market) {
  // Try CLOB first for faster/more accurate pricing
  const clobPrice = getClobPrice(market.id);
  if (clobPrice !== null && clobPrice !== undefined) {
    const yes = clobPrice;
    const no = 1 - clobPrice;
    return { yes, no };
  }

  // Fallback to Gamma canonical source
  if (!market.outcomePrices || typeof market.outcomePrices !== 'object') return null;

  let yes = Number(market.outcomePrices.Yes);
  let no = Number(market.outcomePrices.No);

  if (Number.isNaN(yes) || Number.isNaN(no)) return null;

  if (yes > 1) yes /= 100;
  if (no > 1) no /= 100;

  return { yes, no };
}

// Override console.log to also write to file
const originalConsoleLog = console.log;
console.log = function(...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(CONSOLE_LOG_FILE, message);
  } catch (error) {
    // Ignore file write errors to prevent infinite loops
  }
  originalConsoleLog.apply(console, args);
};

// Settlement risk scoring - classifies markets by settlement reliability
function settlementRisk(question) {
  if (!question) return 'MEDIUM';

  const q = question.toLowerCase();

  // HIGH RISK: Subjective or interpretive questions
  if (/will.*win|who.*win|what.*win|best.*movie|best.*song|most.*popular/i.test(q)) {
    return 'HIGH'; // Subjective winners
  }
  if (/will.*happen|will.*occur|will.*take place|will.*be|will.*get|will.*become/i.test(q) && /by|end of|before|after/i.test(q)) {
    return 'HIGH'; // Binary outcomes with timing
  }
  if (/how many|how much|what.*number|what.*amount|what.*percentage/i.test(q)) {
    return 'HIGH'; // Quantitative but subjective
  }

  // LOW RISK: Objective, data-driven questions
  if (/price.*above|price.*below|price.*over|price.*under/i.test(q) && /\$.*\d+/i.test(q)) {
    return 'LOW'; // Clear price targets
  }
  if (/will.*reach|will.*hit|will.*surpass|will.*exceed/i.test(q) && /\$.*\d+/i.test(q)) {
    return 'LOW'; // Numeric targets
  }
  if (/election.*result|vote.*result|ballot.*result/i.test(q) && /win|lose/i.test(q)) {
    return 'LOW'; // Official election results
  }
  if (/company.*earnings|revenue.*above|profit.*above/i.test(q)) {
    return 'LOW'; // Financial metrics
  }

  // MEDIUM RISK: Default for everything else
  return 'MEDIUM';
}

// Canonical price function - uses CLOB first, Gamma fallback
function getYesNoPrices(market) {
  // Try CLOB first for faster/more accurate pricing
  const clobPrice = getClobPrice(market.id);
  if (clobPrice !== null && clobPrice !== undefined) {
    const yes = clobPrice;
    const no = 1 - clobPrice;
    return { yes, no };
  }

  // Fallback to Gamma canonical source
  if (!market.outcomePrices || typeof market.outcomePrices !== 'object') return null;

  let yes = Number(market.outcomePrices.Yes);
  let no = Number(market.outcomePrices.No);

  if (Number.isNaN(yes) || Number.isNaN(no)) return null;

  if (yes > 1) yes /= 100;
  if (no > 1) no /= 100;

  return { yes, no };
}
const originalConsoleError = console.error;
console.error = function(...args) {
  const timestamp = new Date().toISOString();
  const message = `[ERROR ${timestamp}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(CONSOLE_LOG_FILE, message);
  } catch (error) {
    // Ignore file write errors to prevent infinite loops
  }
  originalConsoleError.apply(console, args);
};

// Log insights to file for easy reading
function logToFile(content) {
  try {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${content}\n`;
    fs.appendFileSync(INSIGHTS_FILE, entry);
  } catch (error) {
    console.error('File logging error:', error);
  }
}

// CRITICAL SAFETY: SAFE_MODE guards all external API calls
const SAFE_MODE = process.env.SAFE_MODE !== 'false';

// Update local health reference
function updateLocalHealth(metrics) {
  systemHealth = { ...systemHealth, ...metrics };
}

// Concurrency lock to prevent overlapping cron jobs
let isRunning = false;

async function main() {
  if (isRunning) {
    console.warn("Previous cycle still running, skipping this tick");
    return;
  }
  isRunning = true;
  try {
    await runCycle();
  } finally {
    isRunning = false;
  }
}

// Main cycle logic (renamed from main to runCycle)
async function runCycle() {
  console.log('Oracle of Poly: Starting cycle at', new Date().toISOString());
  console.log('Price alerts disabled - focusing on core analysis functionality');

  try {
    const analyzer = getMarketAnalyzer();

    // Fetch markets with improved error handling
    const markets = await fetchMarkets(1000); // Increased from 100
    console.log(`Fetched ${markets.length} markets`);

    if (markets.length === 0) {
      console.warn('⚠️ No markets found. This could indicate an API issue or no active markets.');
      console.warn('⚠️ Skipping analysis cycle this time.');
      return;
    }

    // Start CLOB polling for faster price truth
    const marketIds = markets.map(m => m.id || m.slug);
    startPolling(marketIds);

    updateLocalHealth({ marketsMonitored: markets.length });

    // Load cache for price comparisons
    const cache = loadCache();

    // Compute metrics with enhanced analysis
    const enriched = await computeMetrics(markets, cache);
    console.log(`Computed metrics for ${enriched.length} markets`);

    // 🔥 PERSONAL MODE: Extreme probability tail bounce/fade opportunities
    console.log('🔥 PERSONAL MODE ENABLED');
    const personalTrades = [];
    const rejected = { price: 0, liquidity: 0, expiry: 0, insider: 0, total: 0 };
    let debugCount = 0;

    // Normalize YES prices for all markets
    enriched.forEach(market => {
      const prices = getYesNoPrices(market);
      market.yesPrice = prices ? prices.yes : null;
      market.noPrice = prices ? prices.no : null;

      // Attach settlement risk scoring
      market.settlementRisk = settlementRisk(market.question);
    });

    // 🚨 CERTAINTY FADE FIRST PASS: Check ALL markets for extreme mispricing (bypasses all other filters)
    for (const market of [...enriched]) { // Copy array to avoid modification during iteration
      // CERTAINTY DETECTION FIRST (even if one side missing/zero)
      const yes = Number(market.outcomePrices?.[0] || 0);
      const no = Number(market.outcomePrices?.[1] || 0);

      // Check for certainty (one side >= 97%) OR extreme probabilities (YES <= 3% or >= 97%)
      const extremeYes = yes <= 0.03 || yes >= 0.97;
      const extremeNo = no <= 0.03 || no >= 0.97;

      if (extremeYes || extremeNo) {
        const entrySide = yes < no ? "YES" : "NO";
        const entryPrice = Math.min(yes || 0.001, no || 0.001);

        const trade = {
          marketId: market.id,
          question: market.question,
          side: entrySide,
          confidence: Math.max(yes, no),
          strategy: "CERTAINTY_FADE",
          timestamp: new Date().toISOString(),
          action: `BUY ${entrySide}`,
          entry: entryPrice,
          rationale: `Certainty fade (${yes >= 0.97 ? 'YES' : 'NO'} overconfidence)`,
          insider: "NO",
          suggested_stake: 5
        };

        console.log("🔥 CERTAINTY TRADE CREATED", trade);

        // ⚡ Push it to your personal trades array
        personalTrades.push(trade);

        // Remove this market from further processing
        const index = enriched.indexOf(market);
        if (index > -1) {
          enriched.splice(index, 1);
        }
      } else {
        // Only do normal price validation for non-certainty markets
        const prices = getYesNoPrices(market);
        if (!prices) continue;

        // DEBUG: Log what we're checking for normal markets
        console.log(
          "NORMAL MARKET CHECK",
          market.question.slice(0, 40),
          prices
        );
      }
    }

    console.log(`Certainty fade first pass: ${personalTrades.length} trades found`);

    // Continue with normal filtering for remaining markets
    // PRIMARY FILTER: Strict extreme probabilities
    const primaryMarkets = enriched.filter(market => {
      const priceYes = parseFloat(market.yesPrice || 0);
      const liquidity = parseFloat(market.liquidity || 0);
      const endDate = market.endDateIso ? new Date(market.endDateIso) : null;
      const daysToResolution = endDate ? Math.max(0, Math.floor((endDate - new Date()) / (1000 * 60 * 60 * 24))) : null;

      // HARD GUARD: Skip markets without normalized price
      if (market.yesPrice == null) {
        rejected.price++;
        rejected.total++;
        return false;
      }

      // Check each condition and count rejections
      if (!((priceYes <= 0.08 || priceYes >= 0.92))) {
        rejected.price++;
        rejected.total++;
        return false;
      }
      if (!(liquidity >= 40000)) {
        rejected.liquidity++;
        rejected.total++;
        return false;
      }
      if (!(daysToResolution >= (priceYes <= 0.08 ? 120 : 60))) {
        rejected.expiry++;
        rejected.total++;
        return false;
      }
      if (!(market.tokens?.length === 2)) {
        rejected.total++; // Binary market requirement
        return false;
      }

      return true;
    });

    console.log(`Primary scan: ${primaryMarkets.length} candidates`);

    // SECONDARY FILTER: Soft band fallback if primary finds 0
    let targetMarkets = primaryMarkets;
    let bandType = 'STRONG';

    if (primaryMarkets.length === 0) {
      console.log('Secondary scan engaged (SOFT band)');
      targetMarkets = enriched.filter(market => {
        const priceYes = parseFloat(market.yesPrice || 0);
        const liquidity = parseFloat(market.liquidity || 0);
        const endDate = market.endDateIso ? new Date(market.endDateIso) : null;
        const daysToResolution = endDate ? Math.max(0, Math.floor((endDate - new Date()) / (1000 * 60 * 60 * 24))) : null;

        // HARD GUARD: Skip markets without normalized price
        if (market.yesPrice == null) {
          rejected.price++;
          rejected.total++;
          return false;
        }

        // Check each condition and count rejections
        if (!(((priceYes <= 0.10 && priceYes > 0.08) || (priceYes >= 0.90 && priceYes < 0.92)))) {
          rejected.price++;
          rejected.total++;
          return false;
        }
        if (!(liquidity >= 40000)) {
          rejected.liquidity++;
          rejected.total++;
          return false;
        }
        if (!(daysToResolution >= (priceYes <= 0.10 ? 120 : 60))) {
          rejected.expiry++;
          rejected.total++;
          return false;
        }
        if (!(market.tokens?.length === 2)) {
          rejected.total++; // Binary market requirement
          return false;
        }

        return true;
      });
      bandType = 'SOFT';
      console.log(`Secondary scan: ${targetMarkets.length} candidates`);
    }

    // EXPIRY-IMMINENT EXCEPTION: Calendar compression opportunities
    if (primaryMarkets.length === 0 && targetMarkets.length === 0) {
      console.log('Expiry exception scan engaged');
      targetMarkets = enriched.filter(market => {
        const priceYes = parseFloat(market.yesPrice || 0);
        const liquidity = parseFloat(market.liquidity || 0);
        const endDate = market.endDateIso ? new Date(market.endDateIso) : null;
        const daysToResolution = endDate ? Math.max(0, Math.floor((endDate - new Date()) / (1000 * 60 * 60 * 24))) : null;

        // HARD GUARD: Skip markets without normalized price
        if (market.yesPrice == null) {
          rejected.price++;
          rejected.total++;
          return false;
        }

        // Check each condition and count rejections
        if (!(daysToResolution >= 14 && daysToResolution <= 45)) {
          rejected.expiry++;
          rejected.total++;
          return false;
        }
        if (!(priceYes >= 0.95)) {
          rejected.price++;
          rejected.total++;
          return false;
        }
        if (!(liquidity >= 60000)) {
          rejected.liquidity++;
          rejected.total++;
          return false;
        }
        if (!(market.tokens?.length === 2)) {
          rejected.total++; // Binary market requirement
          return false;
        }

        return true;
      });
      bandType = 'EXPIRY';
      console.log(`Expiry exception scan: ${targetMarkets.length} candidates`);
    }

    // EXTREME YES OPPORTUNITIES: Detect very low probability markets for BUY YES long shots
    let extremeYesMarkets = [];
    if (primaryMarkets.length === 0 && targetMarkets.length === 0) {
      console.log('Extreme YES opportunities scan engaged');
      extremeYesMarkets = enriched.filter(market => {
        const prices = getYesNoPrices(market);
        if (!prices) {
          rejected.price++;
          rejected.total++;
          return false;
        }

        const { yes } = prices;
        const liquidity = parseFloat(market.liquidity || 0);
        const endDate = market.endDateIso ? new Date(market.endDateIso) : null;
        const daysToResolution = endDate ? Math.max(0, Math.floor((endDate - new Date()) / (1000 * 60 * 60 * 24))) : null;

        // Look for extremely low YES probability markets (1-5% range)
        const isExtremeYesOpportunity = yes >= 0.005 && yes <= 0.05; // 0.5% to 5%

        if (!isExtremeYesOpportunity) {
          rejected.price++;
          rejected.total++;
          return false;
        }

        // Require decent liquidity for tradability
        if (!(liquidity >= 25000)) {
          rejected.liquidity++;
          rejected.total++;
          return false;
        }

        // Require reasonable time to expiry
        if (!(daysToResolution >= 30)) {
          rejected.expiry++;
          rejected.total++;
          return false;
        }

        if (!(market.tokens?.length === 2)) {
          rejected.total++; // Binary market requirement
          return false;
        }

        return true;
      });

      if (extremeYesMarkets.length > 0) {
        targetMarkets = extremeYesMarkets;
        bandType = 'EXTREME_YES';
        console.log(`Extreme YES opportunities scan: ${targetMarkets.length} candidates`);
      }
    }

    // OVERPRICED CERTAINTY FADE: Final fallback for extreme mispricing
    if (primaryMarkets.length === 0 && targetMarkets.length === 0) {
      console.log('Overpriced certainty fade scan engaged');
      targetMarkets = enriched.filter(market => {
        const prices = getYesNoPrices(market);
        if (!prices) {
          rejected.price++;
          rejected.total++;
          return false;
        }

        const { yes, no } = prices;
        const liquidity = parseFloat(market.liquidity || 0);
        const endDate = market.endDateIso ? new Date(market.endDateIso) : null;
        const daysToResolution = endDate ? Math.max(0, Math.floor((endDate - new Date()) / (1000 * 60 * 60 * 24))) : null;

        const extremeYes = yes <= 0.10;
        const extremeNo  = no  <= 0.10;

        if (!extremeYes && !extremeNo) {
          rejected.price++;
          rejected.total++;
          return false;
        }

        if (!(liquidity >= 50000)) {
          rejected.liquidity++;
          rejected.total++;
          return false;
        }
        if (!(daysToResolution >= 14)) {
          rejected.expiry++;
          rejected.total++;
          return false;
        }
        if (!(market.tokens?.length === 2)) {
          rejected.total++; // Binary market requirement
          return false;
        }

        return true;
      });
      bandType = 'CERTAINTY_FADE';
      console.log(`Certainty fade scan: ${targetMarkets.length} candidates`);
    }

    // Print rejection summary
    console.log('Rejection summary:');
    console.log(`- price: ${rejected.price}`);
    console.log(`- liquidity: ${rejected.liquidity}`);
    console.log(`- expiry: ${rejected.expiry}`);
    console.log(`- insider: ${rejected.insider}`);
    console.log(`- total rejected: ${rejected.total}`);

    // Process each candidate into personal trade
    for (const market of targetMarkets.slice(0, 5)) { // Cap at 5 trades
      const priceYes = parseFloat(market.yesPrice || 0);
      let side, edgeType;

      if (bandType === 'EXPIRY') {
        side = 'NO'; // Expiry exception only fades overconfidence
        edgeType = 'EXPIRY_OVERCONFIDENCE_FADE';
      } else if (bandType === 'EXTREME_YES') {
        side = 'YES'; // Extreme YES opportunities are long shot BUY YES
        edgeType = 'EXTREME_YES_OPPORTUNITY';
      } else {
        // Regular logic for STRONG/SOFT bands
        side = priceYes <= (bandType === 'STRONG' ? 0.08 : 0.10) ? 'YES' : 'NO';
        const isStrong = bandType === 'STRONG';
        edgeType = side === 'YES' ?
          (isStrong ? 'TAIL_BOUNCE_STRONG' : 'TAIL_BOUNCE_SOFT') :
          (isStrong ? 'OVERCONFIDENCE_FADE_STRONG' : 'OVERCONFIDENCE_FADE_SOFT');
      }

      // Enhanced insider detection using order book and wallet pattern data
      let insiderSignal = 'NO';
      try {
        // Check if we have order book data from cache or recent analysis
        const marketCache = cache[market.id];
        if (marketCache && marketCache.orderBook) {
          const orderBook = marketCache.orderBook;
          const midPrice = (parseFloat(orderBook.bestBid || 0) + parseFloat(orderBook.bestAsk || 0)) / 2;

          // Look for large orders (>= $1000) that moved price significantly
          const largeOrders = [...(orderBook.bids || []), ...(orderBook.asks || [])]
            .filter(order => {
              const orderPrice = parseFloat(order.price || 0);
              const priceDiff = Math.abs(orderPrice - midPrice) / midPrice;
              return order.size >= 1000 && priceDiff > 0.01; // Ignore orders within ±1% of mid-price
            });

          if (largeOrders.length > 0) {
            // Check for STRONG signal: >=2 large orders + at least one moved price by >=0.6%
            const priceMovingOrders = largeOrders.filter(order => {
              const orderPrice = parseFloat(order.price || 0);
              const priceDiff = Math.abs(orderPrice - midPrice) / midPrice;
              return priceDiff >= 0.006; // >=0.6% price movement (lowered threshold)
            });

            if (largeOrders.length >= 2 && priceMovingOrders.length >= 1) {
              insiderSignal = 'STRONG'; // Multiple large orders with price impact
            } else if (largeOrders.length >= 1) {
              insiderSignal = 'WEAK'; // At least one significant large order
            }
          }
        }

        // WALLET PATTERN INSIDER DETECTION: Fresh wallets with single large trades
        const walletAnalysis = marketCache?.walletAnalysis;
        if (walletAnalysis && walletAnalysis.insiderWallets && walletAnalysis.insiderWallets.length > 0) {
          const freshSingleLargeTrades = walletAnalysis.insiderWallets.filter(w => w.pattern === 'FRESH_SINGLE_LARGE_TRADE');
          const singleLargeTrades = walletAnalysis.insiderWallets.filter(w => w.pattern === 'SINGLE_LARGE_TRADE');

          if (freshSingleLargeTrades.length > 0) {
            insiderSignal = 'VERY_STRONG'; // Fresh wallet + single large trade = strong insider signal
            console.log(`🚨 WALLET INSIDER ALERT: ${freshSingleLargeTrades.length} fresh wallets with single large trades detected`);
            freshSingleLargeTrades.forEach(wallet => {
              console.log(`   Fresh wallet ${wallet.wallet.substring(0, 8)}...: $${wallet.largestTrade.toLocaleString()} ${wallet.side} trade`);
            });
          } else if (singleLargeTrades.length > 0 && insiderSignal !== 'STRONG') {
            insiderSignal = 'STRONG'; // Single large trade from established wallet
            console.log(`⚠️ WALLET ALERT: ${singleLargeTrades.length} wallets with single large trades detected`);
          }
        }

        // INSIDER HEURISTIC: Check for price movement and volume spikes
        const insiderCheck = marketCache && marketCache.price && marketCache.volume;
        if (insiderCheck && liquidity >= 100000) {
          const priceChange = Math.abs((priceYes - marketCache.price) / marketCache.price) * 100;
          const volumeSpike = (market.volume || 0) / (marketCache.volume || 1);

          // INSIDER = YES if price moved >=8% AND volume spiked >=3x in recent period
          if (priceChange >= 8 && volumeSpike >= 3) {
            insiderSignal = insiderSignal === 'VERY_STRONG' ? 'VERY_STRONG' : insiderSignal === 'STRONG' ? 'STRONG' : 'YES';
          }
        }
      } catch (error) {
        // Silently fail insider detection if data unavailable
        insiderSignal = 'NO';
      }

      // CERTAINTY FADE BYPASS: Allow extreme mispricing to bypass insider requirement
      if (bandType === 'CERTAINTY_FADE' && (priceYes >= 0.985 || priceYes <= 0.015) && liquidity >= 40000 && daysToResolution >= 45) {
        insiderSignal = 'UNKNOWN'; // Bypass insider check for structural mispricing
      }

      // LIQUIDITY BUCKET SKEW: Soft guard for concentrated liquidity (avoids traps)
      let confidence = 1.0; // Base confidence
      try {
        const orderBook = getOrderBook(market.id);
        if (orderBook && orderBook.mid) {
          const skew = liquiditySkew(orderBook, orderBook.mid);
          market.liquiditySkew = skew; // Attach to market object
          if (skew > 3) {
            confidence *= 0.7; // Downgrade confidence for concentrated liquidity
            console.log(`⚠️ LIQUIDITY SKEW ALERT: ${market.question?.substring(0, 30)}... skew=${skew.toFixed(2)} (confidence downgraded)`);
          }
        }
      } catch (error) {
        // Silently fail liquidity skew analysis
      }

      // MOMENTUM/ACCELERATION: Soft guard for decelerating markets
      try {
        const marketCache = cache[market.id];
        if (marketCache && marketCache.priceHistory) {
          const momentum = calculateMomentum(marketCache.priceHistory);
          market.momentum = momentum; // Attach to market object
          if (!momentum.accelerating) {
            confidence *= 0.8; // Downgrade confidence for decelerating momentum
            console.log(`📉 MOMENTUM ALERT: ${market.question?.substring(0, 30)}... decelerating (confidence downgraded)`);
          }
        }
      } catch (error) {
        // Silently fail momentum analysis
      }

      const personalTrade = {
        timestamp: new Date().toISOString(),
        market: market.question,
        action: side === 'YES' ? 'BUY YES' : 'BUY NO',
        entry: priceYes,
        rationale: `${edgeType} - High liquidity ($${liquidity.toLocaleString()}) - ${daysToResolution} days to expiry`,
        insider: insiderSignal,
        suggested_stake: Math.round(suggestedStake * confidence), // Apply confidence downgrade
        confidence: confidence
      };

      // SETTLEMENT RISK SCORING: Stake dampener for HIGH risk markets
      if (market.settlementRisk === 'HIGH') {
        personalTrade.suggested_stake = Math.min(personalTrade.suggested_stake, 2);
        personalTrade.notes = personalTrade.notes || [];
        personalTrade.notes.push(`High settlement risk (${market.settlementRisk})`);
        console.log(`⚠️ SETTLEMENT RISK: ${market.question?.substring(0, 30)}... risk=${market.settlementRisk} (stake capped at $${personalTrade.suggested_stake})`);
      }

      // PRICE PASS DEBUG: Log successful price parsing
      const prices = getYesNoPrices(market);
      if (prices) {
        console.log(
          "PRICE PASS",
          market.question.substring(0, 50) + "...",
          "YES:", prices.yes.toFixed(4),
          "NO:", prices.no.toFixed(4)
        );
      }

      // SLIPPAGE FILTER: Final gate for $100 stake slippage check
      try {
        const orderBook = getOrderBook(market.id);
        if (orderBook && orderBook.mid) {
          const slippage = estimateSlippage(orderBook, 100);
          if (slippage > 1.0) {
            personalTrade.suggested_stake = Math.min(personalTrade.suggested_stake, 2);
            personalTrade.notes = personalTrade.notes || [];
            personalTrade.notes.push(`High slippage (${slippage.toFixed(2)}%)`);
            console.log(`💸 SLIPPAGE ALERT: ${market.question?.substring(0, 30)}... slippage=${slippage.toFixed(2)}% (stake reduced to $${personalTrade.suggested_stake})`);
          }
        }
      } catch (error) {
        // Silently fail slippage analysis
      }

      personalTrades.push(personalTrade);
    }

    // Log personal trades in simplified format
    if (personalTrades.length > 0) {
      console.log(`\n📊 PERSONAL TRADES FOUND:`);
      personalTrades.forEach((trade, i) => {
        console.log(`${i+1}) ${trade.question.substring(0, 50)}...`);
        console.log(`   Action: ${trade.action}`);
        console.log(`   Entry: ${(trade.entry * 100).toFixed(1)}%`);
        console.log(`   Stake: $${trade.suggested_stake}`);
        console.log(`   Insider: ${trade.insider}`);
        console.log('');

        // Log to personal_trades.txt in simplified format
        try {
          const tradeEntry = `[${new Date(trade.timestamp).toISOString().slice(0, 19).replace('T', ' ')}]

Market: ${trade.market}
Action: ${trade.action}
Entry: ${(trade.entry * 100).toFixed(1)}%
Rationale: ${trade.rationale}
Insider: ${trade.insider}
Suggested Stake: $${trade.suggested_stake}

---\n`;

          fs.appendFileSync(PERSONAL_TRADES_FILE, tradeEntry);
        } catch (error) {
          console.error('Error logging personal trade:', error);
        }
      });
    } else {
      console.log('No personal trades found this cycle');
    }

    // Pick top markets
    const topMarkets = pickMarkets(enriched);
    console.log(`Selected ${topMarkets.length} markets of interest`);
    
    // Log insights to file
    logToFile(`=== ORACLE INSIGHTS CYCLE ===`);
    logToFile(`Selected ${topMarkets.length} markets of interest`);
    topMarkets.forEach((market, i) => {
      logToFile(`Market ${i+1}: ${market.question} (YES: ${(market.yesPrice * 100).toFixed(1)}%, Volume: $${market.volume.toLocaleString()})`);
    });

    // Generate basic decrees for X posting
    const { xDecree, deepDive: basicDeepDive } = await generateDecrees(topMarkets);

    // Generate premium analysis for top market
    let premiumAnalysis = null;
    if (topMarkets.length > 0) {
      try {
        const topMarket = topMarkets[0]; // Market with highest price change
        premiumAnalysis = await generateEnhancedAnalysis(topMarket, cache);
        console.log(`Generated premium analysis for ${topMarket.question?.substring(0, 50)}...`);
      } catch (error) {
        console.error('Error generating premium analysis:', error);
      }
    }

    // Post to X (free content)
    if (SAFE_MODE) {
      console.log('[SAFE_MODE] Would post to X:', xDecree.substring(0, 100) + '...');
    } else {
      await postToX(xDecree);
    }
    updateLocalHealth({ posts: systemHealth.posts + 1 });

    // Post basic deep dives to ACP (5 VIRTUAL each)
    for (const report of basicDeepDive) {
      if (SAFE_MODE) {
        console.log('[SAFE_MODE] Would post basic deep dive to ACP:', report.marketId);
      } else {
        await postDeepDiveOnACP(report);
      }
    }
    updateLocalHealth({ posts: systemHealth.posts + basicDeepDive.length });

    // Post premium analysis to ACP (15 VIRTUAL)
    if (premiumAnalysis) {
      if (SAFE_MODE) {
        console.log('[SAFE_MODE] Would post premium analysis to ACP:', premiumAnalysis.marketId);
        console.log('Premium features:', premiumAnalysis.llmAnalysis?.executiveSummary?.substring(0, 100) + '...');
        console.log('Trading Recommendation:', premiumAnalysis.llmAnalysis?.recommendation);
        
        // Log premium insights to file
        logToFile(`PREMIUM ANALYSIS: ${premiumAnalysis.question}`);
        logToFile(`Executive Summary: ${premiumAnalysis.llmAnalysis?.executiveSummary?.substring(0, 200)}...`);
        logToFile(`Recommendation: ${premiumAnalysis.llmAnalysis?.recommendation?.action} (${premiumAnalysis.llmAnalysis?.recommendation?.confidence}% confidence)`);
        logToFile(`Reasoning: ${premiumAnalysis.llmAnalysis?.recommendation?.reasoning?.substring(0, 150)}...`);
        
        // Trading alerts for high-confidence signals
        const edgeMetrics = premiumAnalysis.algorithmicAnalysis?.analysis?.edgeMetrics;
        if (edgeMetrics) {
          if (edgeMetrics.signals?.extremeProbability && edgeMetrics.momentumScore > 60) {
            console.log(' HIGH-CONFIDENCE ALERT:', `${premiumAnalysis.question} - Extreme probability with strong momentum. Potential ${edgeMetrics.momentumScore > 70 ? 'HIGH' : 'MEDIUM'} conviction trade.`);
            logToFile(`HIGH-CONFIDENCE ALERT: ${premiumAnalysis.question} - Extreme probability with strong momentum`);
          }
          if (edgeMetrics.signals?.insiderActivity) {
            console.log(' INSIDER ALERT:', `${premiumAnalysis.question} - Large position accumulation detected. Monitor closely.`);
            logToFile(`INSIDER ALERT: ${premiumAnalysis.question} - Large position accumulation detected`);
          }
          if (edgeMetrics.edgeScore > 80) {
            console.log(' EDGE OPPORTUNITY:', `${premiumAnalysis.question} - High edge score (${edgeMetrics.edgeScore}). Excellent risk-adjusted opportunity.`);
            logToFile(`EDGE OPPORTUNITY: ${premiumAnalysis.question} - High edge score (${edgeMetrics.edgeScore})`);
          }
        }
        
        // Log position stats if available
        const positions = premiumAnalysis.algorithmicAnalysis?.metrics?.positions;
        if (positions) {
          logToFile(`Position Stats - YES: ${positions.yesPositions?.toLocaleString()}, NO: ${positions.noPositions?.toLocaleString()}`);
          if (positions.insiderActivity) {
            logToFile(`Insider Alert: ${positions.insiderActivity.count} large orders ($${positions.insiderActivity.totalSize?.toLocaleString()})`);
          }
        }
      } else {
        await postDeepDiveOnACP(premiumAnalysis);
      }
      updateLocalHealth({ posts: systemHealth.posts + 1 });
    }

    // Update cache with current prices
    const newCache = {};
    enriched.forEach(m => {
      newCache[m.id] = { price: m.yesPrice, volume: m.volume, timestamp: Date.now() };
    });
    saveCache(newCache);

    // LOG PERSONAL TRADES: Signals worth clicking manually
    if (premiumAnalysis && premiumAnalysis.llmAnalysis?.recommendation) {
      const rec = premiumAnalysis.llmAnalysis.recommendation;
      if (rec.action !== 'AVOID' && rec.confidence >= 40) {
        try {
          const tradeSignal = {
            timestamp: new Date().toISOString(),
            market: premiumAnalysis.question,
            marketId: premiumAnalysis.marketId,
            action: rec.action,
            confidence: rec.confidence,
            reasoning: rec.reasoning?.substring(0, 200) || 'High-confidence signal detected',
            price: premiumAnalysis.algorithmicAnalysis?.metrics?.currentPrice?.mid || 0,
            marketType: premiumAnalysis.algorithmicAnalysis?.marketType || 'UNKNOWN',
            isPersonalEdge: premiumAnalysis.algorithmicAnalysis?.isPersonalEdge || false
          };

          fs.appendFileSync(PERSONAL_TRADES_FILE, JSON.stringify(tradeSignal, null, 2) + '\n---\n');
          console.log(`📊 PERSONAL TRADE SIGNAL: ${rec.action} ${rec.confidence}% confidence - ${premiumAnalysis.question?.substring(0, 50)}...`);
        } catch (error) {
          console.error('Error logging personal trade signal:', error);
        }
      }
    }

    // Log system status
    // const alertStatus = alertManager.getConnectionStatus();
    const alertStatus = {
      connected: false,
      websocketDisabled: true,
      totalAlerts: 0,
      marketsSubscribed: 0,
      note: 'Price alerts disabled for initial testing'
    };
    console.log(`System Status: WebSocket DISABLED, ${alertStatus.totalAlerts} alerts, ${alertStatus.marketsSubscribed} markets monitored`);

    // Update final health metrics
    updateLocalHealth({
      lastRun: Date.now(),
      alertsActive: alertStatus.totalAlerts
    });

    console.log('Cycle completed successfully');
  } catch (error) {
    console.error('Error in main cycle:', error);
    // TODO: Implement retry logic and error reporting
  }
}

// Price Alert Management Functions
async function createPriceAlert(userId, marketId, condition, price, alertType = 'above', duration = 'daily') {
  try {
    const alertManager = getPriceAlertManager();
    const result = await alertManager.subscribePriceAlert(userId, marketId, condition, price, alertType, duration);

    console.log(`Price alert created for user ${userId}: ${result.message}`);
    return result;
  } catch (error) {
    console.error('Error creating price alert:', error);
    return { success: false, error: error.message };
  }
}

async function getUserAlerts(userId) {
  try {
    const alertManager = getPriceAlertManager();
    const alerts = alertManager.getUserAlerts(userId);
    return { success: true, alerts };
  } catch (error) {
    console.error('Error getting user alerts:', error);
    return { success: false, error: error.message };
  }
}

async function cancelPriceAlert(userId, alertId) {
  try {
    const alertManager = getPriceAlertManager();
    alertManager.removeAlert(userId, alertId);
    return { success: true, message: 'Alert cancelled successfully' };
  } catch (error) {
    console.error('Error cancelling alert:', error);
    return { success: false, error: error.message };
  }
}

// Premium Analysis Request Handler
async function requestPremiumAnalysis(userId, marketId, analysisType = 'full') {
  try {
    // SAFE_MODE: Prevent real ACP charges
    if (SAFE_MODE) {
      console.log(`[SAFE_MODE] Would process premium analysis request for user ${userId}, market ${marketId}`);
      return {
        success: true,
        analysis: { marketId, safeMode: true, message: 'Analysis simulation - no charges made' },
        payment: { txId: 'mock-premium-analysis-' + Date.now(), safeMode: true },
        message: 'Premium analysis simulated - no charges made (SAFE_MODE=true)'
      };
    }

    const { processPremiumAnalysisRequest } = require('./acp');

    // Process payment via ACP
    const paymentResult = await processPremiumAnalysisRequest(userId, marketId, analysisType);

    // Generate analysis
    const analyzer = getMarketAnalyzer();
    const marketData = await analyzer.getMarketDetails(marketId);
    const cache = loadCache();

    const analysis = await generateEnhancedAnalysis(marketData, cache);

    return {
      success: true,
      analysis,
      payment: paymentResult,
      message: 'Premium analysis generated and delivered'
    };
  } catch (error) {
    console.error('Error processing premium analysis request:', error);
    return { success: false, error: error.message };
  }
}

// Enhanced market data endpoint for API access
async function getEnhancedMarketData(marketId) {
  try {
    const analyzer = getMarketAnalyzer();
    const cache = loadCache();

    const marketData = await analyzer.getMarketDetails(marketId);
    const analysis = await analyzer.analyzeMarket(marketData, cache);

    return {
      success: true,
      market: marketData,
      analysis,
      timestamp: Date.now()
    };
  } catch (error) {
    console.error('Error getting enhanced market data:', error);
    return { success: false, error: error.message };
  }
}

// System health check
function getSystemStatus() {
  return {
    status: 'operational',
    version: '1.2',
    features: {
      marketAnalysis: true,
      priceAlerts: false, // Disabled for initial testing
      premiumReports: true,
      xPosting: true,
      acpMonetization: true
    },
    metrics: {
      alertsActive: 0,
      marketsMonitored: systemHealth.marketsMonitored || 0,
      postsToday: systemHealth.posts || 0,
      lastRun: systemHealth.lastRun || null
    },
    health: systemHealth,
    alertsNote: 'Price alerts disabled until WebSocket endpoint verified'
  };
}

// Schedule every 5 minutes
cron.schedule('*/5 * * * *', main);

// For dev, run once immediately if in dev mode
if (process.env.NODE_ENV === 'development') {
  runCycle(); // Skip concurrency lock for dev testing
}

console.log('Oracle of Poly started with enhanced features:');
console.log('- Premium market analysis (15 VIRTUAL/report)');
console.log('- Professional algorithmic analysis');
console.log('- Automated X posting (SAFE_MODE protected)');
console.log('- ACP monetization (SAFE_MODE protected)');
console.log('- SQLite persistent storage');
console.log('- Scheduled every 5 minutes');
console.log('- Price alerts disabled (WebSocket endpoint TBD)');
console.log('- Health monitoring server started');
console.log('- Console output logged to: console_output.log');
console.log('- Trading insights logged to: oracle_insights.txt');
console.log('- Personal trade signals logged to: personal_trades.txt');

// Start health monitoring server
const { startServer } = require('../server');
startServer();

// Export functions for API access
module.exports = {
  main,
  runCycle,
  createPriceAlert,
  getUserAlerts,
  cancelPriceAlert,
  requestPremiumAnalysis,
  getEnhancedMarketData,
  getSystemStatus
};
