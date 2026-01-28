/**
 * Token Balance Verification Utility
 * Checks ZIGMA token balance for wallet addresses
 */

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const ZIGMA_MINT = 'xT4tzTkuyXyDqCWeZyahrhnknPd8KBuuNjPngvqcyai';

/**
 * Get ZIGMA token balance for a wallet address
 * @param {string} walletAddress - Solana wallet address
 * @returns {Promise<number>} Token balance (in ZIGMA tokens)
 */
async function getZigmaBalance(walletAddress) {
  if (!walletAddress || typeof walletAddress !== 'string') {
    return 0;
  }

  // Validate Solana address format
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    return 0;
  }

  try {
    const response = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [
            walletAddress,
            { mint: ZIGMA_MINT },
            { encoding: 'jsonParsed' }
          ]
        })
      }
    );

    const data = await response.json();

    if (data.error) {
      console.error('Helius API error:', data.error);
      return 0;
    }

    const tokenAccount = data.result?.value?.[0];
    
    if (!tokenAccount || !tokenAccount.account?.data?.parsed?.info) {
      return 0;
    }

    // Parse amount (Solana tokens use 9 decimals)
    const amount = tokenAccount.account.data.parsed.info.tokenAmount.amount;
    const decimals = tokenAccount.account.data.parsed.info.tokenAmount.decimals || 9;
    
    return parseInt(amount) / Math.pow(10, decimals);
  } catch (error) {
    console.error('Failed to get ZIGMA balance:', error.message);
    return 0;
  }
}

/**
 * Get access tier based on ZIGMA balance
 * @param {number} balance - ZIGMA token balance
 * @returns {string} Access tier (FREE, BASIC, PRO, WHALE)
 */
function getAccessTier(balance) {
  if (balance >= 10000) return 'WHALE';
  if (balance >= 1000) return 'PRO';
  if (balance >= 100) return 'BASIC';
  return 'FREE';
}

/**
 * Get features for a given access tier
 * @param {string} tier - Access tier
 * @returns {Object} Features object
 */
function getTierFeatures(tier) {
  const features = {
    FREE: {
      signalsPerDay: 3,
      alerts: false,
      arbitrage: false,
      tracking: 1,
      walletAnalysis: 1,
      apiAccess: false
    },
    BASIC: {
      signalsPerDay: 15,
      alerts: 'hourly',
      arbitrage: false,
      tracking: 5,
      walletAnalysis: 5,
      apiAccess: false
    },
    PRO: {
      signalsPerDay: -1, // Unlimited
      alerts: '15min',
      arbitrage: true,
      tracking: 25,
      walletAnalysis: -1, // Unlimited
      apiAccess: false
    },
    WHALE: {
      signalsPerDay: -1, // Unlimited
      alerts: 'realtime',
      arbitrage: true,
      tracking: -1, // Unlimited
      walletAnalysis: -1, // Unlimited
      apiAccess: true
    }
  };

  return features[tier] || features.FREE;
}

/**
 * Verify ZIGMA access for a wallet
 * @param {string} walletAddress - Solana wallet address
 * @returns {Promise<Object>} Access information
 */
async function verifyZigmaAccess(walletAddress) {
  const balance = await getZigmaBalance(walletAddress);
  const tier = getAccessTier(balance);
  const features = getTierFeatures(tier);

  return {
    tier,
    balance,
    features
  };
}

module.exports = {
  getZigmaBalance,
  getAccessTier,
  getTierFeatures,
  verifyZigmaAccess
};
