/**
 * Token Gating Utilities for $ZIGMA
 * Handles Solana token balance checking and tier determination
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

// $ZIGMA token address on Solana (update with actual deployed token address)
const ZIGMA_TOKEN_ADDRESS = process.env.ZIGMA_TOKEN_ADDRESS || 'YOUR_ZIGMA_TOKEN_MINT_ADDRESS';

// Tier thresholds
const TIER_THRESHOLDS = {
  WHALE: 10000,
  PRO: 1000,
  BASIC: 100,
  FREE: 0
};

// Tier features
const TIER_FEATURES = {
  WHALE: {
    signalsPerDay: -1, // Unlimited
    alerts: 'realtime',
    arbitrage: true,
    tracking: -1, // Unlimited
    apiAccess: true,
    walletAnalysisPerDay: -1,
    priority: 'instant'
  },
  PRO: {
    signalsPerDay: -1, // Unlimited
    alerts: '15min',
    arbitrage: true,
    tracking: 25,
    apiAccess: false,
    walletAnalysisPerDay: -1,
    priority: 'high'
  },
  BASIC: {
    signalsPerDay: 15,
    alerts: 'hourly',
    arbitrage: false,
    tracking: 5,
    apiAccess: false,
    walletAnalysisPerDay: 5,
    priority: 'medium'
  },
  FREE: {
    signalsPerDay: 3,
    alerts: undefined,
    arbitrage: false,
    tracking: 1,
    apiAccess: false,
    walletAnalysisPerDay: 1,
    priority: 'low'
  }
};

/**
 * Get $ZIGMA token balance for a Solana wallet
 * @param {string} walletAddress - Solana wallet address
 * @returns {Promise<number>} Token balance
 */
async function getZigmaBalance(walletAddress) {
  try {
    const connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );

    const walletPubkey = new PublicKey(walletAddress);
    const tokenMint = new PublicKey(ZIGMA_TOKEN_ADDRESS);

    // Get token accounts owned by wallet for ZIGMA token
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletPubkey,
      { mint: tokenMint }
    );

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    // Sum up all token account balances (in case of multiple accounts)
    const totalBalance = tokenAccounts.value.reduce((sum, account) => {
      const balance = account.account.data.parsed.info.tokenAmount.uiAmount;
      return sum + (balance || 0);
    }, 0);

    return totalBalance;
  } catch (error) {
    console.error('[TOKEN GATING] Error fetching ZIGMA balance:', error.message);
    // Return 0 on error to default to FREE tier
    return 0;
  }
}

/**
 * Determine user tier based on token balance
 * @param {number} balance - Token balance
 * @returns {string} Tier name (WHALE, PRO, BASIC, FREE)
 */
function determineTier(balance) {
  if (balance >= TIER_THRESHOLDS.WHALE) return 'WHALE';
  if (balance >= TIER_THRESHOLDS.PRO) return 'PRO';
  if (balance >= TIER_THRESHOLDS.BASIC) return 'BASIC';
  return 'FREE';
}

/**
 * Get tier features for a given tier
 * @param {string} tier - Tier name
 * @returns {object} Tier features
 */
function getTierFeatures(tier) {
  return TIER_FEATURES[tier] || TIER_FEATURES.FREE;
}

/**
 * Get complete access information for a wallet
 * @param {string} walletAddress - Solana wallet address
 * @returns {Promise<object>} Access info with tier, balance, and features
 */
async function getAccessInfo(walletAddress) {
  const balance = await getZigmaBalance(walletAddress);
  const tier = determineTier(balance);
  const features = getTierFeatures(tier);

  return {
    tier,
    balance,
    features,
    thresholds: TIER_THRESHOLDS
  };
}

/**
 * Check if wallet has access to a specific feature
 * @param {string} walletAddress - Solana wallet address
 * @param {string} feature - Feature name (e.g., 'arbitrage', 'apiAccess')
 * @returns {Promise<boolean>} Whether wallet has access
 */
async function hasFeatureAccess(walletAddress, feature) {
  const { features } = await getAccessInfo(walletAddress);
  return features[feature] === true || features[feature] === -1;
}

/**
 * Validate Solana wallet address format
 * @param {string} address - Wallet address to validate
 * @returns {boolean} Whether address is valid
 */
function isValidSolanaAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getZigmaBalance,
  determineTier,
  getTierFeatures,
  getAccessInfo,
  hasFeatureAccess,
  isValidSolanaAddress,
  TIER_THRESHOLDS,
  TIER_FEATURES
};
