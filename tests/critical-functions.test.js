/**
 * Unit Tests for Critical Functions
 * Tests for Kelly Criterion, Edge Calculations, Probability Blending, Risk Calculations, P&L, and Health Scoring
 */

const { calculateKelly } = require('../src/market_analysis');
const { analyzeRiskAndConcentration, calculatePortfolioHealth, analyzeTradingPatterns } = require('../src/user_analysis');
const { calculateSharpeRatio, calculateSortinoRatio, calculateMaxDrawdown, calculateVaR } = require('../src/utils/risk-metrics');
const config = require('../src/config');

// Test runner
function runTests(testName, tests) {
  console.log(`\n=== ${testName} ===`);
  let passed = 0;
  let failed = 0;

  tests.forEach((test, index) => {
    try {
      test();
      console.log(`✓ Test ${index + 1}: ${test.name || 'Unnamed'}`);
      passed++;
    } catch (error) {
      console.log(`✗ Test ${index + 1}: ${test.name || 'Unnamed'}`);
      console.log(`  Error: ${error.message}`);
      failed++;
    }
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

// Kelly Criterion Tests
const kellyTests = [
  {
    name: 'Should return 0 for no edge',
    test: () => {
      const result = calculateKelly(0.50, 0.50, 0.01, 10000);
      if (result !== 0) throw new Error(`Expected 0, got ${result}`);
    }
  },
  {
    name: 'Should return 0 for invalid price',
    test: () => {
      const result = calculateKelly(0.60, 0, 0.01, 10000);
      if (result !== 0) throw new Error(`Expected 0, got ${result}`);
    }
  },
  {
    name: 'Should return 0 for price >= 1',
    test: () => {
      const result = calculateKelly(0.60, 1, 0.01, 10000);
      if (result !== 0) throw new Error(`Expected 0, got ${result}`);
    }
  },
  {
    name: 'Should return positive value for positive edge',
    test: () => {
      const result = calculateKelly(0.60, 0.50, 0.01, 10000);
      if (result <= 0) throw new Error(`Expected positive value, got ${result}`);
    }
  },
  {
    name: 'Should cap at MAX_POSITION_SIZE',
    test: () => {
      const result = calculateKelly(0.80, 0.20, 0.01, 1000000);
      if (result > config.KELLY.MAX_POSITION_SIZE) {
        throw new Error(`Expected <= ${config.KELLY.MAX_POSITION_SIZE}, got ${result}`);
      }
    }
  },
  {
    name: 'Should return 0 for liquidity < 1000',
    test: () => {
      const result = calculateKelly(0.60, 0.50, 0.01, 500);
      if (result !== 0) throw new Error(`Expected 0 for low liquidity, got ${result}`);
    }
  },
  {
    name: 'Should scale with liquidity',
    test: () => {
      const resultLow = calculateKelly(0.60, 0.50, 0.01, 5000);
      const resultHigh = calculateKelly(0.60, 0.50, 0.01, 50000);
      if (resultHigh <= resultLow) {
        throw new Error(`Expected higher result for higher liquidity`);
      }
    }
  }
];

// Edge Calculation Tests
const edgeTests = [
  {
    name: 'Should calculate positive edge correctly',
    test: () => {
      const probZigma = 0.60;
      const probMarket = 0.50;
      const edge = probZigma - probMarket;
      if (Math.abs(edge - 0.10) > 0.001) {
        throw new Error(`Expected 0.10, got ${edge}`);
      }
    }
  },
  {
    name: 'Should calculate negative edge correctly',
    test: () => {
      const probZigma = 0.40;
      const probMarket = 0.50;
      const edge = probZigma - probMarket;
      if (Math.abs(edge - (-0.10)) > 0.001) {
        throw new Error(`Expected -0.10, got ${edge}`);
      }
    }
  },
  {
    name: 'Should return 0 for equal probabilities',
    test: () => {
      const probZigma = 0.50;
      const probMarket = 0.50;
      const edge = probZigma - probMarket;
      if (Math.abs(edge) > 0.001) {
        throw new Error(`Expected 0, got ${edge}`);
      }
    }
  }
];

// Horizon Discount Tests
const horizonDiscountTests = [
  {
    name: 'Should return 1.0 for days <= 0',
    test: () => {
      const discount = computeHorizonDiscount(0);
      if (discount !== 1.0) throw new Error(`Expected 1.0, got ${discount}`);
    }
  },
  {
    name: 'Should return 1.0 for days < 7',
    test: () => {
      const discount = computeHorizonDiscount(5);
      if (discount !== 1.0) throw new Error(`Expected 1.0, got ${discount}`);
    }
  },
  {
    name: 'Should return 0.95 for days < 30',
    test: () => {
      const discount = computeHorizonDiscount(15);
      if (discount !== 0.95) throw new Error(`Expected 0.95, got ${discount}`);
    }
  },
  {
    name: 'Should return 0.90 for days < 90',
    test: () => {
      const discount = computeHorizonDiscount(60);
      if (discount !== 0.90) throw new Error(`Expected 0.90, got ${discount}`);
    }
  },
  {
    name: 'Should return 0.85 for days < 180',
    test: () => {
      const discount = computeHorizonDiscount(120);
      if (discount !== 0.85) throw new Error(`Expected 0.85, got ${discount}`);
    }
  },
  {
    name: 'Should return 0.80 for days >= 180',
    test: () => {
      const discount = computeHorizonDiscount(200);
      if (discount !== 0.80) throw new Error(`Expected 0.80, got ${discount}`);
    }
  }
];

// Price Validation Tests
const priceValidationTests = [
  {
    name: 'Should accept valid price in range',
    test: () => {
      const price = 0.50;
      const isValid = price >= config.PRICE_THRESHOLDS.MIN_YES && price <= config.PRICE_THRESHOLDS.MAX_YES;
      if (!isValid) throw new Error(`Expected valid price, got ${price}`);
    }
  },
  {
    name: 'Should reject price below minimum',
    test: () => {
      const price = 0.001;
      const isValid = price >= config.PRICE_THRESHOLDS.MIN_YES && price <= config.PRICE_THRESHOLDS.MAX_YES;
      if (isValid) throw new Error(`Expected invalid price, got ${price}`);
    }
  },
  {
    name: 'Should reject price above maximum',
    test: () => {
      const price = 0.999;
      const isValid = price >= config.PRICE_THRESHOLDS.MIN_YES && price <= config.PRICE_THRESHOLDS.MAX_YES;
      if (isValid) throw new Error(`Expected invalid price, got ${price}`);
    }
  },
  {
    name: 'Should identify dead market (extreme high price)',
    test: () => {
      const price = 0.995;
      const isDead = price >= config.PRICE_THRESHOLDS.DEAD_MARKET_MAX;
      if (!isDead) throw new Error(`Expected dead market, got price ${price}`);
    }
  },
  {
    name: 'Should identify dead market (extreme low price)',
    test: () => {
      const price = 0.005;
      const isDead = price <= config.PRICE_THRESHOLDS.DEAD_MARKET_MIN;
      if (!isDead) throw new Error(`Expected dead market, got price ${price}`);
    }
  }
];

// Risk Calculation Tests
const riskCalculationTests = [
  {
    name: 'Should calculate correct top position exposure',
    test: () => {
      const positions = [
        { title: 'Market 1', currentValue: 80000, size: 1000, curPrice: 80, cashPnl: 5000 },
        { title: 'Market 2', currentValue: 15000, size: 200, curPrice: 75, cashPnl: -2000 },
        { title: 'Market 3', currentValue: 5000, size: 100, curPrice: 50, cashPnl: 1000 }
      ];
      const metrics = { unrealizedPnl: 4000 };
      
      const result = analyzeRiskAndConcentration(positions, metrics);
      
      if (Math.abs(result.topPositionExposure - 80) > 1) {
        throw new Error(`Expected ~80%, got ${result.topPositionExposure}%`);
      }
      if (result.topPositionExposure <= 0) {
        throw new Error(`Expected positive exposure, got ${result.topPositionExposure}%`);
      }
    }
  },
  {
    name: 'Should calculate correct diversification score',
    test: () => {
      const positions = [
        { title: 'Market 1', currentValue: 33333, size: 400, curPrice: 83.33, cashPnl: 1000 },
        { title: 'Market 2', currentValue: 33333, size: 400, curPrice: 83.33, cashPnl: 1000 },
        { title: 'Market 3', currentValue: 33334, size: 400, curPrice: 83.34, cashPnl: 1000 }
      ];
      const metrics = { unrealizedPnl: 3000 };
      
      const result = analyzeRiskAndConcentration(positions, metrics);
      
      if (result.diversificationScore < 60) {
        throw new Error(`Expected >60% for well-diversified portfolio, got ${result.diversificationScore}%`);
      }
      if (result.concentrationScore > 40) {
        throw new Error(`Expected <40% concentration, got ${result.concentrationScore}%`);
      }
    }
  },
  {
    name: 'Should calculate correct drawdown risk',
    test: () => {
      const positions = [
        { title: 'Market 1', currentValue: 50000, size: 1000, curPrice: 50, cashPnl: -20000 },
        { title: 'Market 2', currentValue: 30000, size: 500, curPrice: 60, cashPnl: -5000 },
        { title: 'Market 3', currentValue: 20000, size: 400, curPrice: 50, cashPnl: 5000 }
      ];
      const metrics = { unrealizedPnl: -20000 };
      
      const result = analyzeRiskAndConcentration(positions, metrics);
      
      if (result.maxDrawdownRisk <= 0) {
        throw new Error(`Expected positive drawdown risk, got ${result.maxDrawdownRisk}%`);
      }
      if (Math.abs(result.maxDrawdownRisk - 25) > 1) {
        throw new Error(`Expected ~25%, got ${result.maxDrawdownRisk}%`);
      }
    }
  },
  {
    name: 'Should handle empty positions',
    test: () => {
      const result = analyzeRiskAndConcentration([], {});
      
      if (result.topPositionExposure !== 0) {
        throw new Error(`Expected 0, got ${result.topPositionExposure}`);
      }
      if (result.diversificationScore !== 0) {
        throw new Error(`Expected 0, got ${result.diversificationScore}`);
      }
      if (result.maxDrawdownRisk !== 0) {
        throw new Error(`Expected 0, got ${result.maxDrawdownRisk}`);
      }
    }
  }
];

// Portfolio Health Tests
const portfolioHealthTests = [
  {
    name: 'Should give low grade for high losses',
    test: () => {
      const metrics = {
        winRate: 45,
        realizedPnl: -50000,
        unrealizedPnl: -120000,
        totalVolume: 200000
      };
      const patterns = { avgPositionSize: 500, winRate: 45 };
      const risk = {
        diversificationScore: 30,
        concentrationScore: 70,
        maxDrawdownRisk: 85
      };
      const categoryPerf = [];
      
      const result = calculatePortfolioHealth(metrics, patterns, risk, categoryPerf);
      
      if (result.grade !== 'F') {
        throw new Error(`Expected F grade for high losses, got ${result.grade}`);
      }
      if (result.score >= 50) {
        throw new Error(`Expected <50 score, got ${result.score}`);
      }
    }
  },
  {
    name: 'Should give high grade for good performance',
    test: () => {
      const metrics = {
        winRate: 75,
        realizedPnl: 50000,
        unrealizedPnl: 30000,
        totalVolume: 200000
      };
      const patterns = { avgPositionSize: 300, winRate: 75 };
      const risk = {
        diversificationScore: 80,
        concentrationScore: 20,
        maxDrawdownRisk: 5
      };
      const categoryPerf = [];
      
      const result = calculatePortfolioHealth(metrics, patterns, risk, categoryPerf);
      
      if (!result.grade.match(/^[AB]/)) {
        throw new Error(`Expected A or B grade, got ${result.grade}`);
      }
      if (result.score <= 80) {
        throw new Error(`Expected >80 score, got ${result.score}`);
      }
    }
  },
  {
    name: 'Should account for both realized and unrealized P&L',
    test: () => {
      const metrics = {
        winRate: 60,
        realizedPnl: 100000,
        unrealizedPnl: -50000,
        totalVolume: 300000
      };
      const patterns = { avgPositionSize: 400, winRate: 60 };
      const risk = {
        diversificationScore: 60,
        concentrationScore: 40,
        maxDrawdownRisk: 20
      };
      const categoryPerf = [];
      
      const result = calculatePortfolioHealth(metrics, patterns, risk, categoryPerf);
      
      if (result.score <= 50) {
        throw new Error(`Expected >50 score, got ${result.score}`);
      }
      if (result.score >= 90) {
        throw new Error(`Expected <90 score, got ${result.score}`);
      }
    }
  }
];

// Trading Patterns Tests
const tradingPatternsTests = [
  {
    name: 'Should calculate average position size from BUY trades only',
    test: () => {
      const trades = [
        { side: 'BUY', size: 100, price: 50, timestamp: 1000 },
        { side: 'BUY', size: 200, price: 60, timestamp: 2000 },
        { side: 'SELL', size: 100, price: 55, timestamp: 3000 },
        { side: 'BUY', size: 150, price: 70, timestamp: 4000 }
      ];
      
      const result = analyzeTradingPatterns(trades, []);
      
      const expectedAvg = (5000 + 12000 + 10500) / 3;
      if (Math.abs(result.avgPositionSize - expectedAvg) > 1) {
        throw new Error(`Expected ~${expectedAvg}, got ${result.avgPositionSize}`);
      }
    }
  },
  {
    name: 'Should calculate correct buy/sell ratio',
    test: () => {
      const trades = [
        { side: 'BUY', size: 100, price: 50, timestamp: 1000 },
        { side: 'BUY', size: 200, price: 60, timestamp: 2000 },
        { side: 'SELL', size: 100, price: 55, timestamp: 3000 },
        { side: 'SELL', size: 150, price: 65, timestamp: 4000 }
      ];
      
      const result = analyzeTradingPatterns(trades, []);
      
      if (result.buySellRatio !== 1) {
        throw new Error(`Expected 1, got ${result.buySellRatio}`);
      }
    }
  },
  {
    name: 'Should handle empty trades',
    test: () => {
      const result = analyzeTradingPatterns([], []);
      
      if (result.avgPositionSize !== 0) {
        throw new Error(`Expected 0, got ${result.avgPositionSize}`);
      }
      if (result.buySellRatio !== 0) {
        throw new Error(`Expected 0, got ${result.buySellRatio}`);
      }
      if (result.tradeFrequency !== 0) {
        throw new Error(`Expected 0, got ${result.tradeFrequency}`);
      }
    }
  }
];

// Risk Metrics Tests
const riskMetricsTests = [
  {
    name: 'Should calculate correct Sharpe ratio for positive returns',
    test: () => {
      const returns = [0.01, 0.02, 0.015, 0.025, 0.01];
      
      const sharpe = calculateSharpeRatio(returns, 0.02, 252);
      
      if (sharpe <= 0) {
        throw new Error(`Expected positive Sharpe ratio, got ${sharpe}`);
      }
      if (sharpe >= 10) {
        throw new Error(`Expected reasonable Sharpe ratio, got ${sharpe}`);
      }
    }
  },
  {
    name: 'Should return 0 for insufficient data in Sharpe calculation',
    test: () => {
      const sharpe = calculateSharpeRatio([0.01], 0.02, 252);
      
      if (sharpe !== 0) {
        throw new Error(`Expected 0, got ${sharpe}`);
      }
    }
  },
  {
    name: 'Should calculate correct Sortino ratio',
    test: () => {
      const returns = [0.02, 0.03, -0.01, 0.04, 0.02];
      
      const sortino = calculateSortinoRatio(returns, 0.02, 252);
      
      if (sortino <= 0) {
        throw new Error(`Expected positive Sortino ratio, got ${sortino}`);
      }
    }
  },
  {
    name: 'Should calculate correct maximum drawdown',
    test: () => {
      const values = [100, 110, 105, 95, 90, 100, 105];
      
      const result = calculateMaxDrawdown(values);
      
      if (Math.abs(result.maxDrawdown - 18.18) > 0.5) {
        throw new Error(`Expected ~18.18%, got ${result.maxDrawdown}%`);
      }
      if (result.peakIndex !== 1) {
        throw new Error(`Expected peak at index 1, got ${result.peakIndex}`);
      }
      if (result.troughIndex !== 4) {
        throw new Error(`Expected trough at index 4, got ${result.troughIndex}`);
      }
    }
  },
  {
    name: 'Should handle increasing values in drawdown',
    test: () => {
      const values = [100, 110, 120, 130, 140];
      
      const result = calculateMaxDrawdown(values);
      
      if (result.maxDrawdown !== 0) {
        throw new Error(`Expected 0, got ${result.maxDrawdown}`);
      }
    }
  },
  {
    name: 'Should calculate Value at Risk',
    test: () => {
      const returns = [-0.05, -0.03, -0.02, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07];
      
      const result = calculateVaR(returns, 0.95, 100000);
      
      if (result.varAmount <= 0) {
        throw new Error(`Expected positive VaR amount, got ${result.varAmount}`);
      }
      if (result.varPercentage <= 0) {
        throw new Error(`Expected positive VaR percentage, got ${result.varPercentage}`);
      }
      if (result.confidenceLevel !== 0.95) {
        throw new Error(`Expected 0.95 confidence, got ${result.confidenceLevel}`);
      }
    }
  }
];

// Edge Cases Tests
const edgeCasesTests = [
  {
    name: 'Should handle negative portfolio values gracefully',
    test: () => {
      const positions = [
        { title: 'Market 1', currentValue: -50000, size: 1000, curPrice: -50, cashPnl: -10000 }
      ];
      const metrics = { unrealizedPnl: -10000 };
      
      const result = analyzeRiskAndConcentration(positions, metrics);
      
      if (result.topPositionExposure !== 0) {
        throw new Error(`Expected 0 for negative values, got ${result.topPositionExposure}`);
      }
    }
  },
  {
    name: 'Should handle zero total volume in health calculation',
    test: () => {
      const metrics = {
        winRate: 50,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalVolume: 0
      };
      const patterns = { avgPositionSize: 0, winRate: 50 };
      const risk = {
        diversificationScore: 50,
        concentrationScore: 50,
        maxDrawdownRisk: 0
      };
      const categoryPerf = [];
      
      const result = calculatePortfolioHealth(metrics, patterns, risk, categoryPerf);
      
      if (result.score < 0 || result.score > 100) {
        throw new Error(`Expected score between 0-100, got ${result.score}`);
      }
    }
  },
  {
    name: 'Should handle extreme values in risk calculations',
    test: () => {
      const returns = [10, -5, 20, -15, 30, -25, 40, -35];
      
      const sharpe = calculateSharpeRatio(returns, 0.02, 252);
      const maxDrawdown = calculateMaxDrawdown([100, 200, 50, 300, 25]);
      
      if (!isFinite(sharpe)) {
        throw new Error(`Expected finite Sharpe ratio, got ${sharpe}`);
      }
      if (maxDrawdown.maxDrawdown > 100) {
        throw new Error(`Expected drawdown <= 100%, got ${maxDrawdown.maxDrawdown}%`);
      }
    }
  }
];

// Helper function for horizon discount
function computeHorizonDiscount(daysToResolution) {
  if (daysToResolution <= 0) return 1.0;
  if (daysToResolution < 7) return 1.0;
  if (daysToResolution < 30) return 0.95;
  if (daysToResolution < 90) return 0.90;
  if (daysToResolution < 180) return 0.85;
  return 0.80;
}

// Run all tests
console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║           CRITICAL FUNCTIONS UNIT TESTS                  ║');
console.log('╚══════════════════════════════════════════════════════════╝');

const results = {
  kelly: runTests('Kelly Criterion', kellyTests),
  edge: runTests('Edge Calculations', edgeTests),
  horizon: runTests('Horizon Discount', horizonDiscountTests),
  price: runTests('Price Validation', priceValidationTests),
  riskCalculation: runTests('Risk Calculations', riskCalculationTests),
  portfolioHealth: runTests('Portfolio Health', portfolioHealthTests),
  tradingPatterns: runTests('Trading Patterns', tradingPatternsTests),
  riskMetrics: runTests('Risk Metrics', riskMetricsTests),
  edgeCases: runTests('Edge Cases', edgeCasesTests)
};

// Summary
const totalPassed = Object.values(results).reduce((sum, r) => sum + r.passed, 0);
const totalFailed = Object.values(results).reduce((sum, r) => sum + r.failed, 0);

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║                    TEST SUMMARY                          ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`Total Passed: ${totalPassed}`);
console.log(`Total Failed: ${totalFailed}`);
console.log(`Success Rate: ${((totalPassed / (totalPassed + totalFailed)) * 100).toFixed(2)}%`);

if (totalFailed === 0) {
  console.log('\n✓ All tests passed!');
  process.exit(0);
} else {
  console.log('\n✗ Some tests failed!');
  process.exit(1);
}
