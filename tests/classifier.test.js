const { classifyMarket } = require('../src/utils/classifier');

describe('classifyMarket', () => {
  it('should classify crypto markets correctly', () => {
    expect(classifyMarket('Will Bitcoin reach $100k by 2025?')).toBe('CRYPTO');
    expect(classifyMarket('Ethereum price prediction')).toBe('CRYPTO');
    expect(classifyMarket('Solana market cap')).toBe('CRYPTO');
  });

  it('should classify politics markets correctly', () => {
    expect(classifyMarket('Will Trump win the 2024 election?')).toBe('POLITICS');
    expect(classifyMarket('Senate control 2024')).toBe('POLITICS');
    expect(classifyMarket('Biden approval rating')).toBe('POLITICS');
  });

  it('should classify macro markets correctly', () => {
    expect(classifyMarket('Will the US enter a recession in 2024?')).toBe('MACRO');
    expect(classifyMarket('Fed interest rate decision')).toBe('MACRO');
    expect(classifyMarket('Inflation rate projection')).toBe('MACRO');
  });

  it('should classify tech markets correctly', () => {
    expect(classifyMarket('Will GPT-5 be released in 2025?')).toBe('TECH');
    expect(classifyMarket('NVIDIA stock price')).toBe('TECH');
    expect(classifyMarket('OpenAI funding round')).toBe('TECH');
  });

  it('should classify sports markets correctly', () => {
    expect(classifyMarket('Will the Chiefs win the Super Bowl?')).toBe('SPORTS_FUTURES');
    expect(classifyMarket('World Cup winner 2026')).toBe('SPORTS_FUTURES');
    expect(classifyMarket('NBA Finals champion')).toBe('SPORTS_FUTURES');
  });

  it('should classify war outcomes correctly', () => {
    expect(classifyMarket('Will Ukraine war end in 2024?')).toBe('WAR_OUTCOMES');
    expect(classifyMarket('Gaza ceasefire agreement')).toBe('WAR_OUTCOMES');
  });

  it('should default to EVENT for unrecognized categories', () => {
    expect(classifyMarket('Random market question')).toBe('EVENT');
    expect(classifyMarket('Unknown topic')).toBe('EVENT');
  });

  it('should handle empty or null input', () => {
    expect(classifyMarket('')).toBe('EVENT');
    expect(classifyMarket(null)).toBe('EVENT');
    expect(classifyMarket(undefined)).toBe('EVENT');
  });

  it('should be case-insensitive', () => {
    expect(classifyMarket('BITCOIN price')).toBe('CRYPTO');
    expect(classifyMarket('trump election')).toBe('POLITICS');
  });
});
