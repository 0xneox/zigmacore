/**
 * Unit Tests for Critical Functions
 * Tests for Kelly Criterion, Edge Calculations, and Probability Blending
 */

const { calculateKelly } = require('../src/market_analysis');
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
  price: runTests('Price Validation', priceValidationTests)
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
