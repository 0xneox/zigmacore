const express = require('express');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getAccount, getAssociatedTokenAddress } = require('@solana/spl-token');
const { verifyMagicToken } = require('./magic-auth');
const router = express.Router();

// Solana configuration
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const ZIGMA_TOKEN_MINT = 'xT4tzTkuyXyDqCWeZyahrhnknPd8KBuuNjPngvqcyai';

// Chat payment configuration
// 10,000 ZIGMA tokens (~$1.41) = 3 chats
const CHAT_CONFIG = {
  ZIGMA_PER_PACKAGE: 10000,
  CHATS_PER_PACKAGE: 3,
  ZIGMA_TOKEN_MINT,
  DECIMALS: 9,
};

// Create Solana connection
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// In-memory chat usage tracking (replace with database in production)
const chatUsage = new Map();

/**
 * Get ZIGMA token balance for a wallet
 */
async function getZigmaBalance(walletAddress) {
  try {
    const walletPublicKey = new PublicKey(walletAddress);
    const mintPublicKey = new PublicKey(ZIGMA_TOKEN_MINT);

    const tokenAccountAddress = await getAssociatedTokenAddress(
      mintPublicKey,
      walletPublicKey
    );

    const tokenAccount = await getAccount(connection, tokenAccountAddress);
    const balance = Number(tokenAccount.amount) / Math.pow(10, CHAT_CONFIG.DECIMALS);
    
    return balance;
  } catch (error) {
    console.error('[ZIGMA CHAT] Error fetching balance:', error);
    return 0;
  }
}

/**
 * Calculate available chats based on ZIGMA balance
 */
function calculateAvailableChats(zigmaBalance) {
  const packages = Math.floor(zigmaBalance / CHAT_CONFIG.ZIGMA_PER_PACKAGE);
  return packages * CHAT_CONFIG.CHATS_PER_PACKAGE;
}

/**
 * Get user's chat usage
 */
function getUserChatUsage(walletAddress) {
  if (!chatUsage.has(walletAddress)) {
    chatUsage.set(walletAddress, {
      chatsUsed: 0,
      lastReset: Date.now(),
      zigmaBalanceSnapshot: 0,
    });
  }
  return chatUsage.get(walletAddress);
}

/**
 * Middleware to check ZIGMA token balance before allowing chat
 */
async function requireZigmaTokens(req, res, next) {
  try {
    const walletAddress = req.user?.publicAddress;
    
    if (!walletAddress) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Wallet address not found in session'
      });
    }

    // Get ZIGMA balance
    const balance = await getZigmaBalance(walletAddress);
    const availableChats = calculateAvailableChats(balance);
    
    // Get usage tracking
    const usage = getUserChatUsage(walletAddress);
    
    // Check if user needs to refresh their package
    if (balance !== usage.zigmaBalanceSnapshot) {
      // Balance changed, reset usage
      usage.chatsUsed = 0;
      usage.zigmaBalanceSnapshot = balance;
      usage.lastReset = Date.now();
    }
    
    // Check if user has chats available
    if (availableChats === 0) {
      return res.status(403).json({
        error: 'Insufficient ZIGMA tokens',
        message: `You need ${CHAT_CONFIG.ZIGMA_PER_PACKAGE} ZIGMA tokens for ${CHAT_CONFIG.CHATS_PER_PACKAGE} chats`,
        balance,
        availableChats: 0,
        requiredZigma: CHAT_CONFIG.ZIGMA_PER_PACKAGE,
        paymentRequired: true
      });
    }
    
    // Check if user has used all their chats
    if (usage.chatsUsed >= availableChats) {
      return res.status(403).json({
        error: 'Chat limit reached',
        message: `You've used all ${availableChats} chats. Get more ZIGMA tokens to continue.`,
        balance,
        availableChats,
        chatsUsed: usage.chatsUsed,
        requiredZigma: CHAT_CONFIG.ZIGMA_PER_PACKAGE,
        paymentRequired: true
      });
    }
    
    // Attach chat info to request
    req.chatInfo = {
      balance,
      availableChats,
      chatsUsed: usage.chatsUsed,
      chatsRemaining: availableChats - usage.chatsUsed,
    };
    
    next();
  } catch (error) {
    console.error('[ZIGMA CHAT] Error checking token balance:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to verify token balance'
    });
  }
}

/**
 * Record chat usage
 */
function recordChatUsage(walletAddress) {
  const usage = getUserChatUsage(walletAddress);
  usage.chatsUsed += 1;
  console.log(`[ZIGMA CHAT] Chat used by ${walletAddress}. Total: ${usage.chatsUsed}`);
}

/**
 * GET /api/chat/balance
 * Get user's ZIGMA balance and available chats
 */
router.get('/balance', verifyMagicToken, async (req, res) => {
  try {
    const walletAddress = req.user.publicAddress;
    const balance = await getZigmaBalance(walletAddress);
    const availableChats = calculateAvailableChats(balance);
    const usage = getUserChatUsage(walletAddress);
    
    res.json({
      success: true,
      balance,
      availableChats,
      chatsUsed: usage.chatsUsed,
      chatsRemaining: Math.max(0, availableChats - usage.chatsUsed),
      config: {
        zigmaPerPackage: CHAT_CONFIG.ZIGMA_PER_PACKAGE,
        chatsPerPackage: CHAT_CONFIG.CHATS_PER_PACKAGE,
      }
    });
  } catch (error) {
    console.error('[ZIGMA CHAT] Balance check error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch balance'
    });
  }
});

/**
 * POST /api/chat/message
 * Send a chat message (requires ZIGMA tokens)
 */
router.post('/message', verifyMagicToken, requireZigmaTokens, async (req, res) => {
  try {
    const { message, marketUrl } = req.body;
    const walletAddress = req.user.publicAddress;
    
    if (!message) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Message is required'
      });
    }
    
    // Record chat usage
    recordChatUsage(walletAddress);
    
    // TODO: Integrate with your existing chat/LLM logic here
    // For now, return a mock response
    const response = {
      success: true,
      message: 'Chat message received',
      chatInfo: req.chatInfo,
      // Add your actual chat response here
      response: 'This will be replaced with actual LLM response'
    };
    
    res.json(response);
  } catch (error) {
    console.error('[ZIGMA CHAT] Message error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process message'
    });
  }
});

module.exports = { router, requireZigmaTokens, getZigmaBalance, calculateAvailableChats };
