/**
 * Basket Selection Algorithm
 * Selects 7 high-edge, short-horizon bets for the trading basket
 */

const { getMarketUniverse } = require('./fetcher');
const { generateEnhancedAnalysis } = require('./llm');
const { getClobPrice } = require('./clob_price_cache');

/**
 * Generate basket recommendations
 * @param {Object} criteria - Selection criteria
 * @returns {Array} - 7 recommended positions
 */
async function generateBasketRecommendations(criteria = {}) {
  const {
    count = 7,
    minEdge = 5,
    maxDaysToResolution = 7,
    minLiquidity = 5000,
    targetAllocation = 280
  } = criteria;
  
  console.log('[BASKET SELECTOR] Starting selection with criteria:', criteria);
  
  try {
    // Get all available markets
    const markets = await getMarketUniverse();
    console.log(`[BASKET SELECTOR] Fetched ${markets.length} markets`);
    
    // Filter markets by basic criteria
    const now = new Date();
    const candidateMarkets = markets.filter(market => {
      // Must have resolution date
      if (!market.endDate && !market.resolutionDate) return false;
      
      // Calculate days to resolution
      const resolutionDate = new Date(market.endDate || market.resolutionDate);
      const daysToResolution = (resolutionDate - now) / (1000 * 60 * 60 * 24);
      
      // Must resolve within maxDaysToResolution
      if (daysToResolution > maxDaysToResolution || daysToResolution < 0.5) return false;
      
      // Must have minimum liquidity
      const liquidity = parseFloat(market.liquidity) || 0;
      if (liquidity < minLiquidity) return false;
      
      // Must have valid price
      const yesPrice = market.yesPrice;
      if (typeof yesPrice !== 'number' || yesPrice <= 0.01 || yesPrice >= 0.99) return false;
      
      // Must not be closed
      if (market.closed || market.active === false) return false;
      
      return true;
    });
    
    console.log(`[BASKET SELECTOR] Filtered to ${candidateMarkets.length} candidates`);
    
    if (candidateMarkets.length === 0) {
      throw new Error('No markets match criteria');
    }
    
    // Analyze top candidates
    const analyzed = [];
    const maxToAnalyze = Math.min(candidateMarkets.length, 30); // Analyze top 30
    
    console.log(`[BASKET SELECTOR] Analyzing top ${maxToAnalyze} candidates...`);
    
    for (let i = 0; i < maxToAnalyze; i++) {
      const market = candidateMarkets[i];
      
      try {
        // Generate analysis
        const analysis = await generateEnhancedAnalysis(market);
        
        if (!analysis) continue;
        
        // Calculate edge
        const marketPrice = market.yesPrice;
        const zigmaProb = analysis.probability || 0.5;
        const rawEdge = Math.abs(zigmaProb - marketPrice);
        const effectiveEdge = analysis.effectiveEdge || rawEdge * 100;
        
        // Must meet minimum edge
        if (effectiveEdge < minEdge) continue;
        
        // Get CLOB data for better pricing
        const clobPrice = getClobPrice(market.id);
        const currentPrice = clobPrice?.mid || marketPrice;
        
        // Determine side
        const side = zigmaProb > marketPrice ? 'BUY_YES' : 'BUY_NO';
        
        // Calculate days to resolution
        const resolutionDate = new Date(market.endDate || market.resolutionDate);
        const daysToResolution = (resolutionDate - now) / (1000 * 60 * 60 * 24);
        
        analyzed.push({
          marketId: market.id,
          question: market.question,
          side,
          currentPrice,
          zigmaProb,
          edge: effectiveEdge,
          confidence: analysis.confidence || 50,
          liquidity: parseFloat(market.liquidity) || 0,
          volume24hr: parseFloat(market.volume24hr) || 0,
          daysToResolution: Number(daysToResolution.toFixed(1)),
          resolutionDate: resolutionDate.toISOString(),
          url: market.url || `https://polymarket.com/event/${market.slug}`,
          analysis: {
            action: analysis.action,
            reasoning: analysis.reasoning,
            catalysts: analysis.catalysts
          }
        });
        
        console.log(`[BASKET SELECTOR] Analyzed ${i + 1}/${maxToAnalyze}: ${market.question?.slice(0, 50)}... (Edge: ${effectiveEdge.toFixed(2)}%)`);
        
      } catch (error) {
        console.error(`[BASKET SELECTOR] Error analyzing market ${market.id}:`, error.message);
      }
    }
    
    console.log(`[BASKET SELECTOR] Successfully analyzed ${analyzed.length} markets`);
    
    if (analyzed.length === 0) {
      throw new Error('No markets passed analysis');
    }
    
    // Sort by edge (highest first)
    analyzed.sort((a, b) => b.edge - a.edge);
    
    // Select top N with diversification
    const selected = [];
    const usedCategories = new Set();
    
    for (const candidate of analyzed) {
      if (selected.length >= count) break;
      
      // Simple diversification: avoid too many similar questions
      const questionWords = candidate.question.toLowerCase().split(' ');
      const isDuplicate = selected.some(s => {
        const existingWords = s.question.toLowerCase().split(' ');
        const commonWords = questionWords.filter(w => existingWords.includes(w) && w.length > 4);
        return commonWords.length > 3; // More than 3 common words = too similar
      });
      
      if (isDuplicate) {
        console.log(`[BASKET SELECTOR] Skipping duplicate: ${candidate.question.slice(0, 50)}...`);
        continue;
      }
      
      selected.push(candidate);
    }
    
    // If we don't have enough, fill with next best
    while (selected.length < count && analyzed.length > selected.length) {
      const next = analyzed.find(a => !selected.includes(a));
      if (next) selected.push(next);
      else break;
    }
    
    // Calculate position sizes (equal weight)
    const perPositionSize = targetAllocation / selected.length;
    
    const recommendations = selected.map(s => ({
      ...s,
      size: Number(perPositionSize.toFixed(2)),
      entryPrice: s.currentPrice
    }));
    
    console.log(`[BASKET SELECTOR] Selected ${recommendations.length} positions:`);
    recommendations.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.side} ${r.question.slice(0, 60)}... | Edge: ${r.edge.toFixed(2)}% | Size: $${r.size}`);
    });
    
    return recommendations;
    
  } catch (error) {
    console.error('[BASKET SELECTOR] Error:', error);
    throw error;
  }
}

/**
 * Validate basket before execution
 */
function validateBasket(positions, fundSize = 500) {
  const totalSize = positions.reduce((sum, p) => sum + (p.size || 0), 0);
  
  if (totalSize > fundSize * 0.6) {
    throw new Error(`Total size $${totalSize} exceeds 60% of fund ($${fundSize * 0.6})`);
  }
  
  if (positions.length < 5) {
    throw new Error('Basket must have at least 5 positions for diversification');
  }
  
  if (positions.length > 10) {
    throw new Error('Basket cannot exceed 10 positions');
  }
  
  positions.forEach((p, i) => {
    if (!p.marketId) throw new Error(`Position ${i} missing marketId`);
    if (!p.side) throw new Error(`Position ${i} missing side`);
    if (!p.size || p.size <= 0) throw new Error(`Position ${i} has invalid size`);
    if (!p.entryPrice || p.entryPrice <= 0 || p.entryPrice >= 1) {
      throw new Error(`Position ${i} has invalid entryPrice`);
    }
  });
  
  return true;
}

module.exports = {
  generateBasketRecommendations,
  validateBasket
};
