/**
 * Related Market Arbitrage Module
 * Detects correlated markets with price discrepancies
 * Finds arbitrage opportunities across related prediction markets
 */

/**
 * Types of market relationships
 */
const RELATIONSHIP_TYPES = {
  // Direct inverse (A happening = B not happening)
  INVERSE: 'INVERSE',
  
  // Subset (If A happens, B must happen - A is subset of B)
  SUBSET: 'SUBSET',
  
  // Superset (If B happens, A must happen - A is superset of B)
  SUPERSET: 'SUPERSET',
  
  // Correlated (A and B tend to move together)
  CORRELATED: 'CORRELATED',
  
  // Mutually exclusive (Only one can happen)
  MUTUALLY_EXCLUSIVE: 'MUTUALLY_EXCLUSIVE',
  
  // Sum to 100% (All outcomes must sum to 1)
  EXHAUSTIVE_SET: 'EXHAUSTIVE_SET'
};

/**
 * Pattern matchers for detecting related markets
 */
const RELATIONSHIP_PATTERNS = [
  {
    type: RELATIONSHIP_TYPES.MUTUALLY_EXCLUSIVE,
    pattern: /^Will (.+?) (win|be|become) .+?\?$/i,
    groupKey: (match) => match[1], // Group by subject
    description: 'Same subject, different outcomes'
  },
  {
    type: RELATIONSHIP_TYPES.EXHAUSTIVE_SET,
    pattern: /^Who will (win|be) .+?\?.*$/i,
    groupKey: (match) => match[0].replace(/\?.*$/, '?'),
    description: 'Multiple choice market'
  },
  {
    type: RELATIONSHIP_TYPES.SUBSET,
    pattern: /top (\d+)/i,
    relation: (numA, numB) => parseInt(numA) < parseInt(numB) ? 'SUBSET' : 'SUPERSET',
    description: 'Top N rankings'
  }
];

/**
 * Detect relationship between two markets
 * @param {Object} marketA - First market
 * @param {Object} marketB - Second market
 * @returns {Object|null} - Relationship if detected
 */
function detectRelationship(marketA, marketB) {
  const qA = (marketA.question || marketA.title || '').toLowerCase();
  const qB = (marketB.question || marketB.title || '').toLowerCase();
  
  // Same market
  if (marketA.id === marketB.id || marketA.conditionId === marketB.conditionId) {
    return null;
  }
  
  // Check for direct inverse
  if (isInverseMarket(qA, qB)) {
    return {
      type: RELATIONSHIP_TYPES.INVERSE,
      marketA: marketA.conditionId || marketA.id,
      marketB: marketB.conditionId || marketB.id,
      description: 'Markets are direct inverses',
      expectedRelation: 'P(A) + P(B) ≈ 1'
    };
  }
  
  // Check for subset/superset (e.g., "Top 4" vs "Top 10")
  const subsetRelation = detectSubsetRelation(qA, qB);
  if (subsetRelation) {
    return {
      type: subsetRelation.type,
      marketA: marketA.conditionId || marketA.id,
      marketB: marketB.conditionId || marketB.id,
      description: subsetRelation.description,
      expectedRelation: subsetRelation.expectedRelation
    };
  }
  
  // Check for same-subject markets
  const sameSubject = detectSameSubject(qA, qB);
  if (sameSubject) {
    return {
      type: RELATIONSHIP_TYPES.CORRELATED,
      marketA: marketA.conditionId || marketA.id,
      marketB: marketB.conditionId || marketB.id,
      description: `Both markets about: ${sameSubject}`,
      expectedRelation: 'Prices should move together',
      correlationDirection: 'POSITIVE'
    };
  }
  
  return null;
}

/**
 * Check if two markets are inverse of each other
 */
function isInverseMarket(qA, qB) {
  // Common inverse patterns
  const inversePatterns = [
    [/will (.+?) win/i, /will (.+?) lose/i],
    [/will (.+?) be above/i, /will (.+?) be below/i],
    [/will (.+?) pass/i, /will (.+?) fail/i],
    [/will (.+?) happen/i, /will (.+?) not happen/i]
  ];
  
  for (const [patternA, patternB] of inversePatterns) {
    const matchA = qA.match(patternA);
    const matchB = qB.match(patternB);
    
    if (matchA && matchB && matchA[1] === matchB[1]) {
      return true;
    }
    
    // Check reverse
    const matchA2 = qA.match(patternB);
    const matchB2 = qB.match(patternA);
    
    if (matchA2 && matchB2 && matchA2[1] === matchB2[1]) {
      return true;
    }
  }
  
  return false;
}

/**
 * Detect subset/superset relationships (e.g., Top 4 vs Top 10)
 */
function detectSubsetRelation(qA, qB) {
  const topNPattern = /top (\d+)/i;
  const matchA = qA.match(topNPattern);
  const matchB = qB.match(topNPattern);
  
  if (matchA && matchB) {
    // Check if same subject
    const subjectA = qA.replace(topNPattern, '').trim();
    const subjectB = qB.replace(topNPattern, '').trim();
    
    // Simple similarity check (could be improved)
    const similarity = calculateStringSimilarity(subjectA, subjectB);
    
    if (similarity > 0.7) {
      const numA = parseInt(matchA[1]);
      const numB = parseInt(matchB[1]);
      
      if (numA < numB) {
        return {
          type: RELATIONSHIP_TYPES.SUBSET,
          description: `Top ${numA} is subset of Top ${numB}`,
          expectedRelation: `P(Top ${numA}) ≤ P(Top ${numB})`
        };
      } else if (numA > numB) {
        return {
          type: RELATIONSHIP_TYPES.SUPERSET,
          description: `Top ${numA} is superset of Top ${numB}`,
          expectedRelation: `P(Top ${numA}) ≥ P(Top ${numB})`
        };
      }
    }
  }
  
  return null;
}

/**
 * Detect if two markets are about the same subject
 */
function detectSameSubject(qA, qB) {
  // Extract key entities (simplified - could use NER)
  const entitiesA = extractEntities(qA);
  const entitiesB = extractEntities(qB);
  
  const common = entitiesA.filter(e => entitiesB.includes(e));
  
  if (common.length > 0) {
    return common.join(', ');
  }
  
  return null;
}

/**
 * Extract key entities from a question
 */
function extractEntities(question) {
  const entities = [];
  
  // Known entities (expand this list)
  const knownEntities = [
    'trump', 'biden', 'harris', 'obama', 'putin', 'zelenskyy',
    'bitcoin', 'ethereum', 'solana',
    'fed', 'federal reserve', 'ecb',
    'openai', 'anthropic', 'google', 'meta', 'microsoft', 'apple', 'nvidia',
    'super bowl', 'world cup', 'olympics',
    'ukraine', 'russia', 'china', 'israel', 'gaza'
  ];
  
  const q = question.toLowerCase();
  for (const entity of knownEntities) {
    if (q.includes(entity)) {
      entities.push(entity);
    }
  }
  
  return entities;
}

/**
 * Simple string similarity (Jaccard on words)
 */
function calculateStringSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);
  
  return intersection.size / union.size;
}

/**
 * Calculate arbitrage opportunity from price discrepancy
 * @param {Object} relationship - Relationship between markets
 * @param {number} priceA - Current YES price for market A
 * @param {number} priceB - Current YES price for market B
 * @returns {Object|null} - Arbitrage opportunity if exists
 */
function calculateArbitrageOpportunity(relationship, priceA, priceB) {
  const { type } = relationship;
  
  switch (type) {
    case RELATIONSHIP_TYPES.INVERSE:
      return checkInverseArbitrage(priceA, priceB, relationship);
    
    case RELATIONSHIP_TYPES.SUBSET:
      return checkSubsetArbitrage(priceA, priceB, relationship);
    
    case RELATIONSHIP_TYPES.SUPERSET:
      return checkSupersetArbitrage(priceA, priceB, relationship);
    
    case RELATIONSHIP_TYPES.MUTUALLY_EXCLUSIVE:
      return checkMutuallyExclusiveArbitrage(priceA, priceB, relationship);
    
    default:
      return null;
  }
}

/**
 * Check arbitrage for inverse markets (should sum to ~1)
 */
function checkInverseArbitrage(priceA, priceB, relationship) {
  const sum = priceA + priceB;
  const deviation = Math.abs(sum - 1);
  
  // Need >5% deviation for meaningful arbitrage
  if (deviation < 0.05) {
    return null;
  }
  
  let opportunity;
  
  if (sum > 1.05) {
    // Both overpriced - sell both
    opportunity = {
      type: 'SELL_BOTH',
      description: 'Both markets overpriced (sum > 100%)',
      expectedProfit: (sum - 1) * 100,
      trades: [
        { market: relationship.marketA, action: 'SELL_YES', price: priceA },
        { market: relationship.marketB, action: 'SELL_YES', price: priceB }
      ]
    };
  } else if (sum < 0.95) {
    // Both underpriced - buy both
    opportunity = {
      type: 'BUY_BOTH',
      description: 'Both markets underpriced (sum < 100%)',
      expectedProfit: (1 - sum) * 100,
      trades: [
        { market: relationship.marketA, action: 'BUY_YES', price: priceA },
        { market: relationship.marketB, action: 'BUY_YES', price: priceB }
      ]
    };
  }
  
  if (opportunity) {
    return {
      ...opportunity,
      relationship,
      priceA,
      priceB,
      sum,
      deviation: deviation * 100,
      confidence: Math.min(95, 50 + deviation * 200) // Higher deviation = higher confidence
    };
  }
  
  return null;
}

/**
 * Check arbitrage for subset markets (A ⊂ B means P(A) ≤ P(B))
 */
function checkSubsetArbitrage(priceA, priceB, relationship) {
  // A is subset of B, so P(A) should be ≤ P(B)
  if (priceA > priceB + 0.05) {
    return {
      type: 'SUBSET_MISPRICING',
      description: `Subset (${(priceA * 100).toFixed(0)}%) priced higher than superset (${(priceB * 100).toFixed(0)}%)`,
      expectedProfit: (priceA - priceB) * 100,
      trades: [
        { market: relationship.marketA, action: 'SELL_YES', price: priceA, reason: 'Overpriced subset' },
        { market: relationship.marketB, action: 'BUY_YES', price: priceB, reason: 'Underpriced superset' }
      ],
      relationship,
      priceA,
      priceB,
      deviation: (priceA - priceB) * 100,
      confidence: Math.min(90, 50 + (priceA - priceB) * 200)
    };
  }
  
  return null;
}

/**
 * Check arbitrage for superset markets
 */
function checkSupersetArbitrage(priceA, priceB, relationship) {
  // A is superset of B, so P(A) should be ≥ P(B)
  if (priceA < priceB - 0.05) {
    return {
      type: 'SUPERSET_MISPRICING',
      description: `Superset (${(priceA * 100).toFixed(0)}%) priced lower than subset (${(priceB * 100).toFixed(0)}%)`,
      expectedProfit: (priceB - priceA) * 100,
      trades: [
        { market: relationship.marketA, action: 'BUY_YES', price: priceA, reason: 'Underpriced superset' },
        { market: relationship.marketB, action: 'SELL_YES', price: priceB, reason: 'Overpriced subset' }
      ],
      relationship,
      priceA,
      priceB,
      deviation: (priceB - priceA) * 100,
      confidence: Math.min(90, 50 + (priceB - priceA) * 200)
    };
  }
  
  return null;
}

/**
 * Check arbitrage for mutually exclusive markets
 */
function checkMutuallyExclusiveArbitrage(priceA, priceB, relationship) {
  // For mutually exclusive events, P(A) + P(B) ≤ 1
  const sum = priceA + priceB;
  
  if (sum > 1.05) {
    return {
      type: 'MUTUALLY_EXCLUSIVE_OVERPRICED',
      description: `Mutually exclusive markets sum to ${(sum * 100).toFixed(0)}% (should be ≤100%)`,
      expectedProfit: (sum - 1) * 100,
      trades: [
        { market: relationship.marketA, action: 'SELL_YES', price: priceA },
        { market: relationship.marketB, action: 'SELL_YES', price: priceB }
      ],
      relationship,
      priceA,
      priceB,
      sum,
      deviation: (sum - 1) * 100,
      confidence: Math.min(95, 50 + (sum - 1) * 200)
    };
  }
  
  return null;
}

/**
 * Scan a list of markets for arbitrage opportunities
 * @param {Array} markets - Array of markets with prices
 * @returns {Array} - Array of arbitrage opportunities
 */
function scanForArbitrage(markets) {
  const opportunities = [];
  const checkedPairs = new Set();
  
  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      const marketA = markets[i];
      const marketB = markets[j];
      
      // Create unique pair key
      const pairKey = [marketA.conditionId || marketA.id, marketB.conditionId || marketB.id].sort().join('|');
      if (checkedPairs.has(pairKey)) continue;
      checkedPairs.add(pairKey);
      
      // Detect relationship
      const relationship = detectRelationship(marketA, marketB);
      if (!relationship) continue;
      
      // Get prices
      const priceA = marketA.outcomePrices?.[0] || marketA.yesPrice || marketA.price;
      const priceB = marketB.outcomePrices?.[0] || marketB.yesPrice || marketB.price;
      
      if (!priceA || !priceB) continue;
      
      // Calculate arbitrage
      const opportunity = calculateArbitrageOpportunity(relationship, priceA, priceB);
      
      if (opportunity) {
        opportunities.push({
          ...opportunity,
          marketATitle: marketA.question || marketA.title,
          marketBTitle: marketB.question || marketB.title
        });
      }
    }
  }
  
  // Sort by expected profit
  opportunities.sort((a, b) => b.expectedProfit - a.expectedProfit);
  
  return opportunities;
}

/**
 * Group markets that should be treated together
 * @param {Array} markets - Array of markets
 * @returns {Array} - Array of market groups
 */
function groupRelatedMarkets(markets) {
  const groups = [];
  const assigned = new Set();
  
  for (const market of markets) {
    if (assigned.has(market.conditionId || market.id)) continue;
    
    const group = {
      anchor: market,
      related: [],
      relationships: []
    };
    
    for (const other of markets) {
      if (other === market) continue;
      if (assigned.has(other.conditionId || other.id)) continue;
      
      const relationship = detectRelationship(market, other);
      if (relationship) {
        group.related.push(other);
        group.relationships.push(relationship);
        assigned.add(other.conditionId || other.id);
      }
    }
    
    if (group.related.length > 0) {
      assigned.add(market.conditionId || market.id);
      groups.push(group);
    }
  }
  
  return groups;
}

/**
 * Calculate correlation-adjusted position for related markets
 * @param {Object} primaryMarket - Market to trade
 * @param {Array} relatedMarkets - Related markets with positions
 * @param {number} baseSize - Base position size
 * @returns {Object} - Adjusted position size
 */
function calculateCorrelationAdjustedSize(primaryMarket, relatedMarkets, baseSize) {
  if (!relatedMarkets || relatedMarkets.length === 0) {
    return {
      adjustedSize: baseSize,
      correlationFactor: 1.0,
      relatedExposure: 0
    };
  }
  
  // Calculate total exposure to related markets
  let relatedExposure = 0;
  for (const related of relatedMarkets) {
    const relationship = detectRelationship(primaryMarket, related.market);
    if (relationship) {
      // Weight by relationship strength
      const weight = relationship.type === RELATIONSHIP_TYPES.INVERSE ? 1.0 :
                     relationship.type === RELATIONSHIP_TYPES.SUBSET ? 0.8 :
                     relationship.type === RELATIONSHIP_TYPES.CORRELATED ? 0.5 : 0.3;
      relatedExposure += (related.size || 0) * weight;
    }
  }
  
  // Reduce position if already exposed to related markets
  const maxTotalExposure = baseSize * 2; // Max 2x effective exposure
  const availableExposure = Math.max(0, maxTotalExposure - relatedExposure);
  const correlationFactor = Math.min(1, availableExposure / baseSize);
  
  return {
    adjustedSize: Number((baseSize * correlationFactor).toFixed(2)),
    correlationFactor: Number(correlationFactor.toFixed(2)),
    relatedExposure: Number(relatedExposure.toFixed(2)),
    maxTotalExposure,
    reason: correlationFactor < 1 
      ? `Reduced due to ${relatedExposure.toFixed(0)} exposure in related markets`
      : 'No correlation adjustment needed'
  };
}

module.exports = {
  RELATIONSHIP_TYPES,
  detectRelationship,
  isInverseMarket,
  detectSubsetRelation,
  detectSameSubject,
  calculateArbitrageOpportunity,
  checkInverseArbitrage,
  checkSubsetArbitrage,
  checkSupersetArbitrage,
  checkMutuallyExclusiveArbitrage,
  scanForArbitrage,
  groupRelatedMarkets,
  calculateCorrelationAdjustedSize
};
