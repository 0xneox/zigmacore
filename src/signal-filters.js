// Signal filtering and validation utilities
// Prevents contradictory and low-quality signals from being generated

/**
 * Detect conflicting signals (opposite sides of same market)
 */
function detectConflicts(signals) {
  const conflicts = [];
  const marketMap = new Map();
  
  signals.forEach(signal => {
    const key = signal.marketQuestion.toLowerCase().trim();
    
    // Check for exact matches or very similar questions
    if (marketMap.has(key)) {
      const existing = marketMap.get(key);
      
      // Check if opposite directions
      const existingDirection = existing.action.includes('YES') ? 'YES' : 'NO';
      const signalDirection = signal.action.includes('YES') ? 'YES' : 'NO';
      
      if (existingDirection !== signalDirection) {
        conflicts.push({
          market1: existing,
          market2: signal,
          reason: 'OPPOSITE_DIRECTIONS',
          severity: 'HIGH'
        });
      }
    } else {
      marketMap.set(key, signal);
    }
  });
  
  return conflicts;
}

/**
 * Validate crypto price predictions for consistency
 */
function validateCryptoPredictions(signals) {
  const cryptoSignals = signals.filter(s => {
    const q = s.marketQuestion.toLowerCase();
    return q.includes('bitcoin') || q.includes('solana') || 
           q.includes('btc') || q.includes('sol') ||
           q.includes('ethereum') || q.includes('eth');
  });
  
  const issues = [];
  
  // Group by asset
  const btcSignals = cryptoSignals.filter(s => {
    const q = s.marketQuestion.toLowerCase();
    return q.includes('bitcoin') || q.includes('btc');
  });
  
  const solSignals = cryptoSignals.filter(s => {
    const q = s.marketQuestion.toLowerCase();
    return q.includes('solana') || q.includes('sol');
  });
  
  // Check BTC consistency
  if (btcSignals.length > 1) {
    btcSignals.forEach((s1, i) => {
      btcSignals.slice(i + 1).forEach(s2 => {
        // Extract price targets
        const prices1 = extractPriceTargets(s1.marketQuestion);
        const prices2 = extractPriceTargets(s2.marketQuestion);
        
        // Check for logical contradictions
        if (prices1.length > 0 && prices2.length > 0) {
          const contradiction = checkPriceContradiction(s1, s2, prices1, prices2);
          if (contradiction) {
            issues.push({
              signal1: s1,
              signal2: s2,
              reason: 'BTC_CONTRADICTION',
              details: contradiction
            });
          }
        }
      });
    });
  }
  
  // Check SOL consistency
  if (solSignals.length > 1) {
    solSignals.forEach((s1, i) => {
      solSignals.slice(i + 1).forEach(s2 => {
        const prices1 = extractPriceTargets(s1.marketQuestion);
        const prices2 = extractPriceTargets(s2.marketQuestion);
        
        if (prices1.length > 0 && prices2.length > 0) {
          const contradiction = checkPriceContradiction(s1, s2, prices1, prices2);
          if (contradiction) {
            issues.push({
              signal1: s1,
              signal2: s2,
              reason: 'SOL_CONTRADICTION',
              details: contradiction
            });
          }
        }
      });
    });
  }
  
  return issues;
}

/**
 * Extract price targets from market question
 */
function extractPriceTargets(question) {
  const matches = question.match(/\$(\d+,?\d*)/g);
  if (!matches) return [];
  
  return matches.map(m => parseInt(m.replace(/[$,]/g, '')));
}

/**
 * Check if two price predictions contradict each other
 */
function checkPriceContradiction(signal1, signal2, prices1, prices2) {
  // Example: "BTC > $80k" BUY YES vs "BTC < $80k" BUY YES = contradiction
  const q1 = signal1.marketQuestion.toLowerCase();
  const q2 = signal2.marketQuestion.toLowerCase();
  
  const s1Direction = signal1.action.includes('YES') ? 'YES' : 'NO';
  const s2Direction = signal2.action.includes('YES') ? 'YES' : 'NO';
  
  // Check for above/below contradictions
  const s1Above = q1.includes('above') || q1.includes('over') || q1.includes('>');
  const s1Below = q1.includes('below') || q1.includes('under') || q1.includes('<');
  const s2Above = q2.includes('above') || q2.includes('over') || q2.includes('>');
  const s2Below = q2.includes('below') || q2.includes('under') || q2.includes('<');
  
  // If both betting YES on opposite directions at similar price points
  if (s1Direction === 'YES' && s2Direction === 'YES') {
    if (s1Above && s2Below && Math.abs(prices1[0] - prices2[0]) < 5000) {
      return `Both betting YES on opposite price directions near $${prices1[0]}`;
    }
  }
  
  // If betting opposite on same range
  if (s1Direction !== s2Direction) {
    const sameRange = prices1.some(p1 => prices2.some(p2 => Math.abs(p1 - p2) < 2000));
    if (sameRange) {
      return `Opposite bets on similar price range`;
    }
  }
  
  return null;
}

/**
 * Filter out bond markets (>90% or <10%)
 */
function filterBondMarkets(signals) {
  return signals.filter(signal => {
    const price = signal.price || signal.yesPrice || 0.5;
    
    if (price > 0.90 || price < 0.10) {
      console.log(`[BOND_FILTER] Removing bond market: ${signal.marketQuestion.slice(0, 50)}... (${(price * 100).toFixed(1)}%)`);
      return false;
    }
    
    return true;
  });
}

/**
 * Filter out low ROI markets (<10¢ unless massive edge)
 */
function filterLowROI(signals) {
  return signals.filter(signal => {
    const price = signal.price || signal.yesPrice || 0.5;
    const minPrice = Math.min(price, 1 - price);
    
    if (minPrice < 0.10) {
      const edge = Math.abs(signal.effectiveEdge || signal.edgeScore || 0);
      const requiredEdge = 20; // 20% minimum edge
      
      if (edge < requiredEdge) {
        console.log(`[ROI_FILTER] Removing low ROI market: ${signal.marketQuestion.slice(0, 50)}... (${(minPrice * 100).toFixed(1)}¢, ${edge.toFixed(1)}% edge)`);
        return false;
      }
    }
    
    return true;
  });
}

/**
 * Resolve conflicts by keeping higher confidence signal
 */
function resolveConflicts(signals, conflicts) {
  const toRemove = new Set();
  
  conflicts.forEach(conflict => {
    const conf1 = conflict.market1.confidence || 0;
    const conf2 = conflict.market2.confidence || 0;
    
    const remove = conf1 > conf2 ? conflict.market2 : conflict.market1;
    const keep = remove === conflict.market2 ? conflict.market1 : conflict.market2;
    
    console.log(`[CONFLICT] Keeping: ${keep.marketQuestion.slice(0, 40)}... (${keep.confidence}% conf)`);
    console.log(`[CONFLICT] Removing: ${remove.marketQuestion.slice(0, 40)}... (${remove.confidence}% conf)`);
    
    toRemove.add(remove.marketId);
  });
  
  return signals.filter(s => !toRemove.has(s.marketId));
}

/**
 * Main filter pipeline - applies all filters in sequence
 */
function applySignalFilters(signals) {
  console.log(`[FILTERS] Starting with ${signals.length} signals`);
  
  // Step 1: Remove bond markets
  let filtered = filterBondMarkets(signals);
  console.log(`[FILTERS] After bond filter: ${filtered.length} signals`);
  
  // Step 2: Remove low ROI markets
  filtered = filterLowROI(filtered);
  console.log(`[FILTERS] After ROI filter: ${filtered.length} signals`);
  
  // Step 3: Detect conflicts
  const conflicts = detectConflicts(filtered);
  if (conflicts.length > 0) {
    console.log(`[FILTERS] Found ${conflicts.length} conflicts`);
    filtered = resolveConflicts(filtered, conflicts);
    console.log(`[FILTERS] After conflict resolution: ${filtered.length} signals`);
  }
  
  // Step 4: Validate crypto predictions
  const cryptoIssues = validateCryptoPredictions(filtered);
  if (cryptoIssues.length > 0) {
    console.log(`[FILTERS] ⚠️ Found ${cryptoIssues.length} crypto contradictions (logged but not removed)`);
    cryptoIssues.forEach(issue => {
      console.log(`[CRYPTO] ${issue.details || issue.reason}`);
    });
  }
  
  console.log(`[FILTERS] Final count: ${filtered.length} signals`);
  return filtered;
}

module.exports = {
  detectConflicts,
  validateCryptoPredictions,
  filterBondMarkets,
  filterLowROI,
  resolveConflicts,
  applySignalFilters
};
