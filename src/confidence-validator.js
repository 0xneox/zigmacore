/**
 * Confidence Validation and Enhancement Module
 * Ensures LLM confidence is used properly and validated
 */

/**
 * Validate and normalize LLM confidence
 * @param {Object} llmAnalysis - LLM analysis object
 * @param {Object} marketData - Market data for context
 * @returns {Object} - Validated confidence with metadata
 */
function validateLLMConfidence(llmAnalysis, marketData = {}) {
  let confidence = llmAnalysis?.confidence || 50;
  const warnings = [];
  
  // Extract confidence if it's nested
  if (typeof confidence === 'object' && confidence !== null) {
    confidence = confidence.confidence || confidence.value || confidence.score || 50;
  }
  
  // Ensure it's a number
  if (typeof confidence !== 'number' || isNaN(confidence)) {
    warnings.push('Invalid confidence type, using default 50%');
    confidence = 50;
  }
  
  // Clamp to valid range
  const originalConfidence = confidence;
  confidence = Math.max(1, Math.min(100, confidence));
  
  if (confidence !== originalConfidence) {
    warnings.push(`Confidence clamped from ${originalConfidence} to ${confidence}`);
  }
  
  // Check for suspiciously round numbers (possible hardcoding)
  if ([70, 75, 80, 85, 90, 95].includes(confidence)) {
    warnings.push(`Suspiciously round confidence: ${confidence}% - may be hardcoded`);
  }
  
  // Check for overconfidence on uncertain markets
  const reasoning = llmAnalysis?.reasoning || llmAnalysis?.narrative || '';
  const uncertaintyKeywords = ['uncertain', 'unclear', 'conflicting', 'insufficient', 'limited data', 'hard to predict'];
  const hasUncertainty = uncertaintyKeywords.some(kw => reasoning.toLowerCase().includes(kw));
  
  if (hasUncertainty && confidence > 75) {
    warnings.push(`High confidence (${confidence}%) despite uncertainty in reasoning`);
  }
  
  // Check for low confidence with strong reasoning
  const certaintyKeywords = ['clear', 'obvious', 'strong evidence', 'definitive', 'certain', 'confirmed'];
  const hasCertainty = certaintyKeywords.some(kw => reasoning.toLowerCase().includes(kw));
  
  if (hasCertainty && confidence < 60) {
    warnings.push(`Low confidence (${confidence}%) despite strong reasoning`);
  }
  
  return {
    confidence,
    originalConfidence,
    warnings,
    isValid: warnings.length === 0,
    source: 'llm',
    reasoning: reasoning.slice(0, 200)
  };
}

/**
 * Calculate confidence based on evidence quality
 * @param {Object} llmAnalysis - LLM analysis
 * @param {Array} newsSources - News sources used
 * @param {Object} marketData - Market data
 * @returns {number} - Evidence-adjusted confidence
 */
function calculateEvidenceBasedConfidence(llmAnalysis, newsSources = [], marketData = {}) {
  let baseConfidence = llmAnalysis?.confidence || 50;
  
  // News quality adjustment
  const highRelevanceNews = newsSources.filter(n => n.relevance === 'high').length;
  const totalNews = newsSources.length;
  
  if (totalNews === 0) {
    baseConfidence *= 0.85; // Reduce confidence if no news
  } else if (highRelevanceNews / totalNews > 0.6) {
    baseConfidence *= 1.05; // Boost if mostly high-relevance news
  }
  
  // Liquidity adjustment (more liquid = more efficient = harder to find edge)
  const liquidity = marketData.liquidity || 0;
  if (liquidity > 100000) {
    baseConfidence *= 0.95; // Slightly reduce confidence on highly liquid markets
  } else if (liquidity < 10000) {
    baseConfidence *= 0.90; // Reduce confidence on illiquid markets (less reliable pricing)
  }
  
  // Time to resolution adjustment
  const endDate = marketData.endDateIso || marketData.endDate;
  if (endDate) {
    const daysToResolution = (new Date(endDate) - new Date()) / (1000 * 60 * 60 * 24);
    
    if (daysToResolution < 7) {
      baseConfidence *= 1.05; // Boost confidence for near-term (less uncertainty)
    } else if (daysToResolution > 180) {
      baseConfidence *= 0.85; // Reduce confidence for long-term (more uncertainty)
    }
  }
  
  return Math.max(1, Math.min(100, baseConfidence));
}

/**
 * Get confidence adjustment based on category historical performance
 * @param {string} category - Market category
 * @param {Object} categoryStats - Historical stats
 * @returns {number} - Confidence multiplier (0.5 to 1.2)
 */
function getCategoryConfidenceAdjustment(category, categoryStats = {}) {
  const winRate = categoryStats.winRate || 0.5;
  const sampleSize = categoryStats.sampleSize || 0;
  
  // Need at least 20 samples for adjustment
  if (sampleSize < 20) {
    return 1.0; // No adjustment
  }
  
  // Adjust based on historical accuracy
  if (winRate > 0.70) {
    return 1.15; // Boost confidence by 15% for strong categories
  } else if (winRate > 0.60) {
    return 1.05; // Slight boost
  } else if (winRate < 0.45) {
    return 0.70; // Reduce confidence by 30% for weak categories
  } else if (winRate < 0.55) {
    return 0.85; // Reduce confidence by 15%
  }
  
  return 1.0; // No adjustment for average performance
}

/**
 * Main confidence processing function
 * @param {Object} llmAnalysis - LLM analysis
 * @param {Object} marketData - Market data
 * @param {string} category - Market category
 * @param {Object} categoryStats - Historical category stats
 * @returns {Object} - Processed confidence with metadata
 */
function processConfidence(llmAnalysis, marketData, category, categoryStats = {}) {
  // Step 1: Validate LLM confidence
  const validated = validateLLMConfidence(llmAnalysis, marketData);
  
  // Step 2: Adjust based on evidence quality
  const evidenceAdjusted = calculateEvidenceBasedConfidence(
    { ...llmAnalysis, confidence: validated.confidence },
    llmAnalysis.newsSources || [],
    marketData
  );
  
  // Step 3: Apply category historical adjustment
  const categoryMultiplier = getCategoryConfidenceAdjustment(category, categoryStats);
  const finalConfidence = evidenceAdjusted * categoryMultiplier;
  
  // Step 4: Final clamping
  const clampedConfidence = Math.max(1, Math.min(100, finalConfidence));
  
  // Build adjustment log
  const adjustments = [];
  if (Math.abs(validated.confidence - evidenceAdjusted) > 1) {
    adjustments.push(`Evidence: ${validated.confidence.toFixed(1)}% → ${evidenceAdjusted.toFixed(1)}%`);
  }
  if (Math.abs(categoryMultiplier - 1.0) > 0.01) {
    adjustments.push(`Category (${category}): ${(categoryMultiplier * 100).toFixed(0)}% multiplier`);
  }
  
  return {
    confidence: clampedConfidence,
    llmConfidence: validated.originalConfidence,
    evidenceAdjusted,
    categoryMultiplier,
    adjustments,
    warnings: validated.warnings,
    metadata: {
      source: 'enhanced',
      newsCount: (llmAnalysis.newsSources || []).length,
      liquidity: marketData.liquidity || 0,
      category,
      categoryWinRate: categoryStats.winRate,
      categorySampleSize: categoryStats.sampleSize
    }
  };
}

/**
 * Log confidence processing for debugging
 */
function logConfidenceProcessing(marketId, result) {
  const warnings = result.warnings.length > 0 ? ` ⚠️ ${result.warnings.join('; ')}` : '';
  const adjustmentLog = result.adjustments.length > 0 ? ` [${result.adjustments.join(', ')}]` : '';
  
  console.log(`[CONFIDENCE] ${marketId}: LLM=${result.llmConfidence}% → Final=${result.confidence.toFixed(1)}%${adjustmentLog}${warnings}`);
}

module.exports = {
  validateLLMConfidence,
  calculateEvidenceBasedConfidence,
  getCategoryConfidenceAdjustment,
  processConfidence,
  logConfidenceProcessing
};
