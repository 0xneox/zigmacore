/**
 * Market Classification Module
 * Centralized market category classification to avoid duplication and errors
 */

/**
 * Classify a market question into a category
 * @param {string} question - The market question/title
 * @returns {string} - The category (CRYPTO, POLITICS, MACRO, TECH, TECH_ADOPTION, ETF_APPROVAL, ENTERTAINMENT, CELEBRITY, SPORTS_FUTURES, WAR_OUTCOMES, EVENT)
 */
function classifyMarket(question) {
  // Handle missing or invalid input
  if (!question || typeof question !== 'string') {
    return 'EVENT';
  }

  const q = question.toLowerCase().trim();
  
  // Handle empty string
  if (q.length === 0) {
    return 'EVENT';
  }

  // CRYPTO - Check first to avoid false positives
  if (/^(bitcoin|ethereum|btc|eth|solana|bnb|ada|doge|avax|matic|link|uni|aave|comp|crv|snx)\b/i.test(q)) return 'CRYPTO';
  if (/\b(crypto|cryptocurrency|defi|dex|cex|nft|web3|blockchain|token|altcoin|stablecoin|yield farming|liquidity mining)\b/i.test(q)) return 'CRYPTO';
  // Exclude "Colorado Avalanche" from crypto pattern
  if (/\b(bitcoin|ethereum|solana|cardano|polkadot|polygon|chainlink|uniswap|aave|compound|curve)\b/i.test(q) && !/\bcolorado avalanche\b/i.test(q)) return 'CRYPTO';

  // POLITICS - Check before MACRO for election-related macro
  if (/\b(election|president|trump|biden|harris|senate|congress|parliament|vote|primary|ballot|campaign|democrat|republican)\b/i.test(q)) return 'POLITICS';
  if (/\b(president|prime minister|chancellor|pm|mp|senator|governor|mayor)\b/i.test(q)) return 'POLITICS';
  if (/\b(rob jetten|dick schoof|péter magyar|geert wilders|marine le pen|olaf scholz|emmanuel macron)\b/i.test(q)) return 'POLITICS';

  // MACRO - Economic indicators
  if (/\b(recession|inflation|fed|federal reserve|interest rate|cpi|ppi|gdp|unemployment|jobs report|nfp|payroll)\b/i.test(q)) return 'MACRO';
  if (/\b(economy|economic growth|monetary policy|fiscal policy|stimulus|quantitative easing|rate hike|rate cut)\b/i.test(q)) return 'MACRO';

  // TECH - AI, semiconductors, big tech
  if (/\b(ai model|gpt|claude|gemini|llm|artificial intelligence|machine learning|neural network)\b/i.test(q)) return 'TECH';
  if (/\b(semiconductor|chip|nvidia|amd|intel|tsmc|qualcomm|broadcom|arm)\b/i.test(q)) return 'TECH';
  if (/\b(openai|anthropic|xai|google deepmind|meta ai|microsoft ai|amazon ai)\b/i.test(q)) return 'TECH';
  if (/\b(tesla|spacex|space x|elon musk|tim cook|satya nadella|jensen huang)\b/i.test(q)) return 'TECH';

  // TECH_ADOPTION - User metrics, adoption rates
  if (/\b(tech adoption|app downloads|user growth|install base|upgrade cycle|daus|maus|active users)\b/i.test(q)) return 'TECH_ADOPTION';

  // ETF_APPROVAL - ETF-related markets
  if (/\b(etf|exchange-traded fund|spot etf|futures etf|sec approval|etf approval)\b/i.test(q)) return 'ETF_APPROVAL';

  // ENTERTAINMENT - Movies, music, TV
  if (/\b(movie|film|oscar|academy award|emmy|grammy|hollywood|box office|album|tour|concert|netflix|disney|hbo|hulu|prime video)\b/i.test(q)) return 'ENTERTAINMENT';

  // CELEBRITY - Famous people
  if (/\b(celebrity|royal family|kardashian|kylie|kim|khloe|kourtney|taylor swift|swiftie|beyoncé|kanye|drake)\b/i.test(q)) return 'CELEBRITY';
  if (/\b(singer|rapper|actor|actress|influencer|streamer|youtuber|tiktok|instagram)\b/i.test(q)) return 'CELEBRITY';

  // SPORTS_FUTURES - Sports outcomes
  if (/\b(super bowl|world series|nba finals|nfl|mlb|nhl|premier league|champions league|la liga|bundesliga|serie a)\b/i.test(q)) return 'SPORTS_FUTURES';
  if (/\b(world cup|fifa|olympics|wimbledon|us open|french open|australian open|tour de france)\b/i.test(q)) return 'SPORTS_FUTURES';
  if (/\b(championship|title|winner|mvp|cy young|heisman|gold medal)\b/i.test(q)) return 'SPORTS_FUTURES';
  if (/\b(lions|steelers|chiefs|eagles|cowboys|patriots|packers|49ers|bears|broncos)\b/i.test(q)) return 'SPORTS_FUTURES';

  // WAR_OUTCOMES - Military conflicts
  if (/\b(war|ceasefire|conflict|invasion|occupation|military strike|missile|troops|deployment)\b/i.test(q)) return 'WAR_OUTCOMES';
  if (/\b(ukraine|gaza|israel|palestine|russia|putin|zelenskyy|hamas|hezbollah|iran)\b/i.test(q)) return 'WAR_OUTCOMES';

  // Default for unknown or general markets
  return 'EVENT';
}

module.exports = {
  classifyMarket
};
