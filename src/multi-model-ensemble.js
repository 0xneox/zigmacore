/**
 * Multi-Model Ensemble System
 * Calls LLM multiple times for high-stakes markets to reduce variance
 * Flags high disagreement as uncertainty
 */

const { generateEnhancedAnalysis } = require('./llm');

// Configuration
const ENSEMBLE_CONFIG = {
  HIGH_STAKES_LIQUIDITY: 50000, // $50k+ liquidity triggers ensemble
  ENSEMBLE_SIZE: 3, // Number of LLM calls
  HIGH_VARIANCE_THRESHOLD: 0.10, // 10% std dev = high disagreement
  CONFIDENCE_PENALTY_FOR_VARIANCE: 0.15 // Reduce confidence by 15% if high variance
};

/**
 * Calculate standard deviation
 */
function calculateStdDev(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
  const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
  const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Calculate median
 */
function calculateMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 
    ? (sorted[mid - 1] + sorted[mid]) / 2 
    : sorted[mid];
}

/**
 * Check if market qualifies for ensemble analysis
 */
function shouldUseEnsemble(market) {
  const liquidity = market.liquidity || 0;
  const isHighStakes = liquidity >= ENSEMBLE_CONFIG.HIGH_STAKES_LIQUIDITY;
  
  if (isHighStakes) {
    console.log(`[ENSEMBLE] High-stakes market detected: ${market.question.slice(0, 60)}... ($${(liquidity / 1000).toFixed(0)}k liquidity)`);
  }
  
  return isHighStakes;
}

/**
 * Call LLM multiple times and aggregate results
 */
async function ensembleAnalysis(market, context = {}) {
  console.log(`[ENSEMBLE] Running ${ENSEMBLE_CONFIG.ENSEMBLE_SIZE}x LLM analysis for: ${market.question.slice(0, 60)}...`);
  
  const startTime = Date.now();
  const results = [];
  
  // Call LLM multiple times
  for (let i = 0; i < ENSEMBLE_CONFIG.ENSEMBLE_SIZE; i++) {
    try {
      console.log(`[ENSEMBLE] Call ${i + 1}/${ENSEMBLE_CONFIG.ENSEMBLE_SIZE}...`);
      const analysis = await generateEnhancedAnalysis(market);
      
      if (analysis && analysis.llmAnalysis) {
        const llm = analysis.llmAnalysis;
        results.push({
          probability: llm.revised_prior || llm.probability || 0.5,
          confidence: llm.confidence || 50,
          reasoning: llm.reasoning || llm.narrative || '',
          sentimentScore: llm.sentimentScore || 0,
          callNumber: i + 1
        });
      } else {
        console.warn(`[ENSEMBLE] Call ${i + 1} returned invalid analysis`);
      }
    } catch (error) {
      console.error(`[ENSEMBLE] Call ${i + 1} failed:`, error.message);
    }
  }
  
  const elapsed = Date.now() - startTime;
  
  if (results.length === 0) {
    console.error('[ENSEMBLE] All LLM calls failed');
    return null;
  }
  
  if (results.length < ENSEMBLE_CONFIG.ENSEMBLE_SIZE) {
    console.warn(`[ENSEMBLE] Only ${results.length}/${ENSEMBLE_CONFIG.ENSEMBLE_SIZE} calls succeeded`);
  }
  
  // Extract values for aggregation
  const probabilities = results.map(r => r.probability);
  const confidences = results.map(r => r.confidence);
  
  // Calculate statistics
  const meanProbability = probabilities.reduce((sum, p) => sum + p, 0) / probabilities.length;
  const medianProbability = calculateMedian(probabilities);
  const stdDevProbability = calculateStdDev(probabilities);
  
  const meanConfidence = confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
  const medianConfidence = calculateMedian(confidences);
  const stdDevConfidence = calculateStdDev(confidences);
  
  // Check for high variance (disagreement)
  const hasHighVariance = stdDevProbability > ENSEMBLE_CONFIG.HIGH_VARIANCE_THRESHOLD;
  
  // Aggregate reasoning (combine all)
  const aggregatedReasoning = results.map((r, i) => 
    `[Model ${i + 1}] ${r.reasoning}`
  ).join(' | ');
  
  // Calculate final confidence
  let finalConfidence = medianConfidence;
  
  if (hasHighVariance) {
    // Penalize confidence if models disagree
    const variancePenalty = ENSEMBLE_CONFIG.CONFIDENCE_PENALTY_FOR_VARIANCE * 100;
    finalConfidence = Math.max(1, finalConfidence - variancePenalty);
    console.log(`[ENSEMBLE] ⚠️ High variance detected (${(stdDevProbability * 100).toFixed(1)}%) - reducing confidence by ${variancePenalty}%`);
  }
  
  // Log results
  console.log(`[ENSEMBLE] Results (${elapsed}ms):`);
  console.log(`  Probability: ${(meanProbability * 100).toFixed(1)}% (mean), ${(medianProbability * 100).toFixed(1)}% (median), σ=${(stdDevProbability * 100).toFixed(1)}%`);
  console.log(`  Confidence: ${meanConfidence.toFixed(1)}% (mean), ${medianConfidence.toFixed(1)}% (median), σ=${stdDevConfidence.toFixed(1)}%`);
  console.log(`  Variance Status: ${hasHighVariance ? '❌ HIGH (models disagree)' : '✅ LOW (models agree)'}`);
  console.log(`  Final Confidence: ${finalConfidence.toFixed(1)}%`);
  
  // Individual results
  results.forEach((r, i) => {
    console.log(`  Model ${i + 1}: P=${(r.probability * 100).toFixed(1)}%, Conf=${r.confidence}%`);
  });
  
  return {
    // Use median for final values (more robust than mean)
    revised_prior: medianProbability,
    confidence: finalConfidence,
    reasoning: aggregatedReasoning,
    sentimentScore: results[0].sentimentScore, // Use first model's sentiment
    
    // Ensemble metadata
    ensembleMetadata: {
      callsSucceeded: results.length,
      callsAttempted: ENSEMBLE_CONFIG.ENSEMBLE_SIZE,
      meanProbability,
      medianProbability,
      stdDevProbability,
      meanConfidence,
      medianConfidence,
      stdDevConfidence,
      hasHighVariance,
      varianceStatus: hasHighVariance ? 'HIGH_DISAGREEMENT' : 'LOW_DISAGREEMENT',
      individualResults: results,
      elapsedMs: elapsed
    }
  };
}

/**
 * Wrapper function: use ensemble for high-stakes, single call otherwise
 */
async function analyzeWithEnsemble(market, context = {}) {
  if (shouldUseEnsemble(market)) {
    const ensembleResult = await ensembleAnalysis(market, context);
    
    if (!ensembleResult) {
      // Ensemble failed, fall back to single call
      console.log('[ENSEMBLE] Ensemble failed, falling back to single LLM call');
      return await generateEnhancedAnalysis(market);
    }
    
    // Wrap ensemble result in expected format
    return {
      llmAnalysis: {
        revised_prior: ensembleResult.revised_prior,
        confidence: ensembleResult.confidence,
        reasoning: ensembleResult.reasoning,
        sentimentScore: ensembleResult.sentimentScore,
        ensembleMetadata: ensembleResult.ensembleMetadata
      },
      probability: ensembleResult.revised_prior
    };
  } else {
    // Standard single LLM call
    return await generateEnhancedAnalysis(market);
  }
}

/**
 * Get ensemble statistics from recent signals
 */
function getEnsembleStats(signals) {
  const ensembleSignals = signals.filter(s => s.ensembleMetadata);
  
  if (ensembleSignals.length === 0) {
    return {
      totalEnsembleSignals: 0,
      message: 'No ensemble signals found'
    };
  }
  
  const highVarianceCount = ensembleSignals.filter(s => 
    s.ensembleMetadata.hasHighVariance
  ).length;
  
  const avgStdDev = ensembleSignals.reduce((sum, s) => 
    sum + s.ensembleMetadata.stdDevProbability, 0
  ) / ensembleSignals.length;
  
  return {
    totalEnsembleSignals: ensembleSignals.length,
    highVarianceCount,
    highVarianceRate: Number((highVarianceCount / ensembleSignals.length * 100).toFixed(1)),
    avgStdDev: Number((avgStdDev * 100).toFixed(2)),
    message: `${ensembleSignals.length} ensemble signals, ${highVarianceCount} with high variance (${(highVarianceCount / ensembleSignals.length * 100).toFixed(1)}%)`
  };
}

module.exports = {
  shouldUseEnsemble,
  ensembleAnalysis,
  analyzeWithEnsemble,
  getEnsembleStats,
  ENSEMBLE_CONFIG
};
