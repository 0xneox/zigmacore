const { computeMetrics, pickMarkets } = require('../src/processor');

describe('computeMetrics', () => {
  it('should compute price change and enrich markets', () => {
    const markets = [
      { slug: 'test1', question: 'Q1', yesPrice: 0.6, noPrice: 0.4, volume: 1000, liquidity: 500 }
    ];
    const cache = { test1: { price: 0.55 } };

    const result = computeMetrics(markets, cache);
    expect(result[0].priceChange).toBeCloseTo(0.0909, 4); // (0.6 - 0.55)/0.55
    expect(result[0].id).toBe('test1');
  });
});

describe('pickMarkets', () => {
  it('should pick top 5 by volume and top 5 by movement, union', () => {
    const enriched = [
      { id: '1', volume: 1000, priceChange: 0.1 },
      { id: '2', volume: 900, priceChange: 0.2 },
      { id: '3', volume: 800, priceChange: 0.15 },
      { id: '4', volume: 700, priceChange: 0.05 },
      { id: '5', volume: 600, priceChange: 0.25 },
      { id: '6', volume: 500, priceChange: 0.12 },
    ];

    const result = pickMarkets(enriched);
    expect(result.length).toBeGreaterThanOrEqual(5);
  });
});
