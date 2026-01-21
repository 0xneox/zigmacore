/**
 * Parse Polymarket URLs to extract market identifiers
 */

const POLYMARKET_PATTERNS = [
  // Event URL: /event/slug-name
  /polymarket\.com\/event\/([a-z0-9-]+)/i,
  // Market URL: /market/0x...
  /polymarket\.com\/market\/(0x[a-f0-9]+)/i,
  // Direct condition ID
  /^(0x[a-f0-9]{64})$/i,
  // UUID format
  /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i
];

function parsePolymarketUrl(input) {
  if (!input || typeof input !== 'string') {
    return { type: 'unknown', value: null, error: 'Invalid input' };
  }
  
  const trimmed = input.trim();
  
  for (const pattern of POLYMARKET_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      const value = match[1];
      
      // Determine type
      let type = 'slug';
      if (value.startsWith('0x')) {
        type = value.length === 66 ? 'conditionId' : 'marketId';
      } else if (value.includes('-') && value.length === 36) {
        type = 'uuid';
      }
      
      return { type, value, original: trimmed };
    }
  }
  
  // Fallback: treat as search query
  return { type: 'query', value: trimmed, original: trimmed };
}

function normalizeSlug(slug) {
  if (!slug) return null;
  return slug.toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = { parsePolymarketUrl, normalizeSlug };
