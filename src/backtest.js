const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const { fetchClosedMarkets } = require('./fetcher');
const { generateEnhancedAnalysis } = require('./llm');
const { calculateKelly } = require('./market_analysis');

// Backtesting configuration
const BACKTEST_DAYS = 30;
const MIN_VOLUME = 10000;
const BACKTEST_RESULTS_FILE = path.join(__dirname, '..', 'backtest_results.txt');

/**
 * Fetch historical price data for a market
 * Uses Polymarket's price history endpoint if available
 */
async function fetchHistoricalPrices(marketId) {
  try {
    const CLOB_API = process.env.CLOB_API_URL || 'https://clob.polymarket.com';
    const url = `${CLOB_API}/history?token_id=${marketId}`;

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Oracle-of-Poly/1.0'
      },
      timeout: 10000
    });

    if (response.data && Array.isArray(response.data)) {
      return response.data.map(point => ({
        timestamp: point.timestamp || point.t,
        price: point.price || point.p,
        volume: point.volume || point.v
      }));
    }

    return [];
  } catch (error) {
    console.warn(`Failed to fetch historical prices for ${marketId}:`, error.message);
    return [];
  }
}

/**
 * Simulate price at a specific point in time
 * Uses historical data or interpolates between known points
 */
function getPriceAtTime(historicalPrices, timestamp) {
  if (!historicalPrices || historicalPrices.length === 0) return null;

  // Find closest point
  const sorted = [...historicalPrices].sort((a, b) => a.timestamp - b.timestamp);
  
  // Binary search for closest timestamp
  let left = 0;
  let right = sorted.length - 1;
  
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (sorted[mid].timestamp === timestamp) {
      return sorted[mid].price;
    } else if (sorted[mid].timestamp < timestamp) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  // Interpolate between nearest points
  const before = sorted[Math.max(0, right)];
  const after = sorted[Math.min(sorted.length - 1, left)];

  if (!before) return after.price;
  if (!after) return before.price;

  const ratio = (timestamp - before.timestamp) / (after.timestamp - before.timestamp);
  return before.price + (after.price - before.price) * ratio;
}

// Run backtest
async function runBacktest() {
  console.log('🔬 Starting Backtest: Fetching resolved markets...');

  try {
    const closedMarkets = await fetchClosedMarkets(50); // Sample 50 for speed

    if (closedMarkets.length === 0) {
      console.log('❌ No closed markets found for backtesting');
      return;
    }

    console.log(`📊 Backtesting on ${closedMarkets.length} resolved markets`);

    const results = [];
    let balance = 1000; // Starting balance
    let peak = 1000;
    let maxDrawdown = 0;
    const returns = [];
    let brierSum = 0;
    let totalPredictions = 0;

    for (const market of closedMarkets) {
      try {
        // Skip if no valid outcome
        if (!market.outcome || typeof market.outcome !== 'string') continue;

        // Fetch historical price data
        const historicalPrices = await fetchHistoricalPrices(market.conditionId || market.id);
        
        // Normalize market for analysis
        const normalizedMarket = {
          ...market,
          yesPrice: historicalPrices.length > 0 
            ? getPriceAtTime(historicalPrices, Date.parse(market.endDateIso || market.endDate) - 86400000) 
            : (market.outcome === 'Yes' ? 1 : 0),
          noPrice: historicalPrices.length > 0 
            ? 1 - getPriceAtTime(historicalPrices, Date.parse(market.endDateIso || market.endDate) - 86400000) 
            : (market.outcome === 'Yes' ? 0 : 1),
          liquidity: market.liquidity || 10000,
          volume: market.volume || 0,
          priceHistory: historicalPrices,
          volumeHistory: market.volumeHistory || [],
          endDateIso: market.endDateIso || market.endDate,
          startDateIso: market.startDateIso || market.startDate,
          category: market.category || 'OTHER',
          settlementRisk: 'MEDIUM',
          historicalPrices: historicalPrices
        };

        // Run real analysis
        const analysis = await generateEnhancedAnalysis(normalizedMarket, [], []);

        if (!analysis || typeof analysis.probability !== 'number') continue;

        const prob = analysis.probability;
        const outcome = market.outcome === 'Yes' ? 1 : 0;
        
        // Use historical price at analysis time for bet price
        const analysisTime = Date.now() - (BACKTEST_DAYS * 86400000); // Simulate analysis 30 days ago
        const betPrice = getPriceAtTime(historicalPrices, analysisTime) || normalizedMarket.yesPrice;

        // Brier score
        const brier = Math.pow(prob - outcome, 2);
        brierSum += brier;
        totalPredictions++;

        // Determine action and edge
        const rawEdge = prob > 0.5 ? prob - betPrice : (1 - prob) - (1 - betPrice);
        let action = 'NO_TRADE';
        if (Math.abs(rawEdge) > 0.05) {
          action = prob > betPrice ? 'BUY YES' : 'BUY NO';
        }

        let win = false;
        if (action === 'BUY YES' && outcome === 1) win = true;
        if (action === 'BUY NO' && outcome === 0) win = true;

        // Realistic P&L with Kelly sizing
        if (action !== 'NO_TRADE') {
          const winProb = action === 'BUY YES' ? prob : 1 - prob;
          const payoutOdds = action === 'BUY YES' ? 1 / betPrice : 1 / (1 - betPrice);
          const kellyFraction = calculateKelly(winProb, betPrice, 0.01, normalizedMarket.liquidity);
          const invested = Math.min(0.05 * balance, kellyFraction * balance);

          balance -= invested;
          let payout = 0;
          if (win) {
            payout = invested * payoutOdds;
          }
          balance += payout;
          const roi = (payout - invested) / invested;
          returns.push(roi);

          // Drawdown
          if (balance > peak) peak = balance;
          const dd = (peak - balance) / peak;
          if (dd > maxDrawdown) maxDrawdown = dd;
        }

        results.push({
          market: market.question.slice(0, 50),
          action,
          outcome: market.outcome,
          closePrice: betPrice,
          probability: prob,
          edge: rawEdge,
          brier,
          win,
          balance: balance.toFixed(2),
          historicalDataPoints: historicalPrices.length
        });

        console.log(`📈 ${market.question.slice(0, 40)}... Pred: ${(prob*100).toFixed(1)}% | Actual: ${market.outcome} | Brier: ${brier.toFixed(3)} | ${win ? 'WIN' : 'LOSS'} | Historical: ${historicalPrices.length} pts`);
      } catch (e) {
        console.error(`❌ Analysis failed for ${market.id}:`, e.message);
      }
    }

    const avgBrier = totalPredictions > 0 ? brierSum / totalPredictions : 0;
    const { wins, total, winRate } = calculateWinRate(results);
    const totalReturn = ((balance - 1000) / 1000) * 100;
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const volatility = returns.length > 0 ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length) : 0;
    const sharpeRatio = volatility > 0 ? avgReturn / volatility : 0;

    console.log(`\n🔬 Backtest Results:`);
    console.log(`   Average Brier Score: ${avgBrier.toFixed(4)} (Lower is better; <0.2 excellent)`);
    console.log(`   Win Rate: ${wins}/${total} (${winRate.toFixed(1)}%)`);
    console.log(`   Total Return: ${totalReturn.toFixed(1)}%, Max Drawdown: ${(maxDrawdown * 100).toFixed(1)}%`);
    console.log(`   Sharpe Ratio: ${sharpeRatio.toFixed(2)}`);

    if (avgBrier < 0.25 && winRate > 55) {
      console.log('✅ Strong backtest performance!');
    } else {
      console.log('⚠️ Backtest shows room for improvement');
    }

    // Save results
    const output = results.map(r => `${r.market} | Action: ${r.action} | Outcome: ${r.outcome} | Win: ${r.win} | Balance: ${r.balance} | Brier: ${r.brier.toFixed(3)}`).join('\n');
    const summary = `Backtest Results (${new Date().toISOString()}):\nMarkets Analyzed: ${totalPredictions}\nAvg Brier Score: ${avgBrier.toFixed(4)}\nWin Rate: ${winRate.toFixed(1)}%\nTotal Return: ${totalReturn.toFixed(1)}%\nMax Drawdown: ${(maxDrawdown * 100).toFixed(1)}%\nSharpe Ratio: ${sharpeRatio.toFixed(2)}\n\n`;
    fs.writeFileSync(BACKTEST_RESULTS_FILE, summary + output);

  } catch (error) {
    console.error('Backtest error:', error.message);
  }
}

if (require.main === module) {
  runBacktest();
}

module.exports = { runBacktest };
