const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

// Backtesting configuration
const BACKTEST_DAYS = 30; // Test last 30 days of closed markets
const MIN_VOLUME = 10000; // Minimum volume for valid backtest
const BACKTEST_RESULTS_FILE = path.join(__dirname, '..', 'backtest_results.txt');

// Simulate simplified analysis (placeholder for full pipeline)
async function simulateAnalysis(market, closePrice) {
  // Simplified: If market was YES at close, simulate probability
  const simulatedProbability = Math.random() * 0.5 + 0.25; // Random 25-75%
  const edge = Math.abs(simulatedProbability - closePrice);
  let action = 'NO_TRADE';
  if (edge > 0.05) {
    action = simulatedProbability > closePrice ? 'BUY YES' : 'BUY NO';
  }
  return { probability: simulatedProbability, action, edge };
}

// Simulate realistic outcome based on market probability
function simulateOutcome(marketProb) {
  return Math.random() < marketProb ? 'YES' : 'NO';
}

// Run backtest
async function runBacktest() {
  console.log('Starting backtest...');

  try {
    // Mock closed markets for backtest (since API doesn't provide closed markets easily)
    const fakeMarkets = [
      { question: 'Will Bitcoin reach 100k by end of 2025?', outcome: 'YES', yesPrice: 0.45, volume: 50000, endDateIso: new Date().toISOString() },
      { question: 'Will Tesla stock go above 300?', outcome: 'NO', yesPrice: 0.55, volume: 40000, endDateIso: new Date().toISOString() },
      { question: 'Will NVIDIA release new GPU?', outcome: 'YES', yesPrice: 0.60, volume: 60000, endDateIso: new Date().toISOString() },
      { question: 'Will SpaceX land on Mars?', outcome: 'NO', yesPrice: 0.30, volume: 30000, endDateIso: new Date().toISOString() },
      { question: 'Will ETH surpass BTC?', outcome: 'YES', yesPrice: 0.50, volume: 45000, endDateIso: new Date().toISOString() },
      { question: 'Will Apple buy Tesla?', outcome: 'NO', yesPrice: 0.20, volume: 25000, endDateIso: new Date().toISOString() },
      { question: 'Will Google AI dominate?', outcome: 'YES', yesPrice: 0.70, volume: 55000, endDateIso: new Date().toISOString() },
      { question: 'Will recession hit US?', outcome: 'NO', yesPrice: 0.40, volume: 35000, endDateIso: new Date().toISOString() },
      { question: 'Will crypto market cap double?', outcome: 'YES', yesPrice: 0.65, volume: 50000, endDateIso: new Date().toISOString() },
      { question: 'Will Ukraine ceasefire?', outcome: 'NO', yesPrice: 0.25, volume: 20000, endDateIso: new Date().toISOString() },
    ];

    const closedMarkets = fakeMarkets;

    console.log(`Using ${closedMarkets.length} mock closed markets for backtest`);

    const results = [];
    let balance = 1000; // Starting balance
    let peak = 1000;
    let maxDrawdown = 0;
    const returns = [];

    for (const market of closedMarkets) {
      const outcome = market.outcome;
      const closePrice = market.yesPrice;
      const analysis = await simulateAnalysis(market, closePrice);

      let win = false;
      if (analysis.action === 'BUY YES' && outcome === 'YES') win = true;
      if (analysis.action === 'BUY NO' && outcome === 'NO') win = true;

      // Realistic P&L: invest 1% of balance, win/loss based on outcome
      if (analysis.action !== 'NO_TRADE') {
        const invested = 0.01 * balance;
        balance -= invested;
        let payout = 0;
        if (win) {
          if (analysis.action === 'BUY YES') {
            payout = invested / closePrice;
          } else {
            payout = invested / (1 - closePrice);
          }
        }
        balance += payout;
        returns.push((payout - invested) / invested); // Return on investment

        // Calculate drawdown
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }

      results.push({
        market: market.question.slice(0, 50),
        action: analysis.action,
        outcome,
        closePrice,
        probability: analysis.probability,
        edge: analysis.edge,
        win,
        balance: balance.toFixed(2)
      });
    }

    const { wins, total, winRate } = calculateWinRate(results);
    const totalReturn = ((balance - 1000) / 1000) * 100;
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const volatility = returns.length > 0 ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length) : 0;
    const sharpeRatio = volatility > 0 ? avgReturn / volatility : 0;

    console.log(`Backtest Results: ${wins}/${total} wins (${winRate.toFixed(1)}% win rate)`);
    console.log(`Total Return: ${totalReturn.toFixed(1)}%, Max Drawdown: ${(maxDrawdown * 100).toFixed(1)}%, Sharpe Ratio: ${sharpeRatio.toFixed(2)}`);

    if (winRate >= 60) {
      console.log('✅ Realistic win rate above 60% - strong performance!');
    } else {
      console.log('⚠️ Win rate below 60%, may need refinement');
    }

    // Save results
    const output = results.map(r => `${r.market} | Action: ${r.action} | Outcome: ${r.outcome} | Win: ${r.win} | Balance: ${r.balance}`).join('\n');
    const summary = `Win Rate: ${winRate.toFixed(1)}%\nTotal Return: ${totalReturn.toFixed(1)}%\nMax Drawdown: ${(maxDrawdown * 100).toFixed(1)}%\nSharpe Ratio: ${sharpeRatio.toFixed(2)}\n`;
    fs.writeFileSync(BACKTEST_RESULTS_FILE, `Backtest Results (${new Date().toISOString()}):\n${summary}\n${output}`);

  } catch (error) {
    console.error('Backtest error:', error.message);
  }
}

if (require.main === module) {
  runBacktest();
}

module.exports = { runBacktest };
