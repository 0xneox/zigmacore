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
    const userEmail = req.user?.email;
    
    console.log('[ZIGMA CHAT] requireZigmaTokens - req.user:', req.user);
    console.log('[ZIGMA CHAT] walletAddress:', walletAddress);
    console.log('[ZIGMA CHAT] userEmail:', userEmail);
    
    if (!walletAddress) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Wallet address not found in session'
      });
    }

    // DEV EXCEPTION: Allow unlimited chat for dev/test accounts
    const DEV_EMAILS = ['neohex262@gmail.com', 'jissjoseph30@gmail.com'];
    console.log('[ZIGMA CHAT] Checking dev exception for email:', userEmail);
    console.log('[ZIGMA CHAT] Is dev email?', userEmail && DEV_EMAILS.includes(userEmail.toLowerCase()));
    
    if (userEmail && DEV_EMAILS.includes(userEmail.toLowerCase())) {
      console.log('[ZIGMA CHAT] ✅ DEV MODE: Unlimited chat access for', userEmail);
      return next();
    }
    
    console.log('[ZIGMA CHAT] ❌ Not a dev email, checking ZIGMA balance...');

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
    const { message, marketUrl, query, marketId, marketQuestion, polymarketUser } = req.body;
    const walletAddress = req.user.publicAddress;
    
    // Accept either 'message' or 'query' field for compatibility
    const userQuery = message || query;
    
    if (!userQuery && !marketId && !marketQuestion && !marketUrl && !polymarketUser) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Message, query, marketId, marketQuestion, marketUrl, or polymarketUser is required'
      });
    }
    
    // Record chat usage
    recordChatUsage(walletAddress);
    
    console.log('[ZIGMA CHAT] Processing message:', userQuery);
    console.log('[ZIGMA CHAT] polymarketUser:', polymarketUser);
    
    // Handle user profile analysis if polymarketUser is provided
    if (polymarketUser) {
      console.log('[ZIGMA CHAT] User profile request for:', polymarketUser);
      
      const { fetchUserProfile } = require('../../server');
      
      // Validate wallet address format
      if (!/^0x[a-fA-F0-9]{40}$/.test(polymarketUser)) {
        return res.status(400).json({
          error: 'Invalid wallet address format',
          message: 'Please provide a valid Polymarket wallet address (starts with 0x and is 42 characters long)',
          user: polymarketUser
        });
      }
      
      console.log('[ZIGMA CHAT] Fetching user profile for:', polymarketUser);
      const userProfile = await fetchUserProfile(polymarketUser);
      
      if (!userProfile) {
        return res.status(404).json({
          error: 'User profile not found',
          message: 'Unable to find trading activity for this wallet address',
          user: polymarketUser
        });
      }
      
      const { metrics, positions, activity, maker, profile, balance } = userProfile;
      const analysis = userProfile.analysis || {};
      const health = analysis.health || {};
      const risk = analysis.risk || {};
      const patterns = analysis.patterns || {};
      
      // Calculate total P&L
      const totalPnl = metrics.realizedPnl + metrics.unrealizedPnl;
      
      // Build user profile response
      const profileMessage = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 USER PROFILE ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Wallet: ${maker}
Balance: $${balance?.toFixed(2) || 'N/A'}

📊 Performance Metrics:
  Total Positions: ${metrics.totalPositions}
  Total Trades: ${metrics.totalTrades}
  Realized P&L: $${metrics.realizedPnl.toFixed(2)}
  Unrealized P&L: $${metrics.unrealizedPnl.toFixed(2)}
  Total P&L: $${totalPnl.toFixed(2)}
  Total Volume: $${metrics.totalVolume.toFixed(2)}
  Win Rate: ${metrics.winRate.toFixed(1)}%
  Average Position Size: $${metrics.averagePositionSize.toFixed(2)}

🏆 Top Markets by P&L:
${metrics.topMarkets.slice(0, 5).map((m, i) => `  ${i + 1}. ${m.title}: $${m.pnl.toFixed(2)}`).join('\n')}

⚠️ Risk Assessment:
  Diversification: ${risk.diversificationScore?.toFixed(0) || 'N/A'}%
  Top Position Exposure: ${risk.topPositionExposure?.toFixed(1) || 'N/A'}%
  Portfolio Health: ${health.grade || 'N/A'} (${health.score?.toFixed(0) || 'N/A'}/100)

📈 Trading Patterns:
  Average Hold Time: ${patterns.avgHoldTime?.toFixed(1) || 'N/A'} hours
  Trade Frequency: ${patterns.tradeFrequency?.toFixed(1) || 'N/A'} trades/day
  Trading Style: ${patterns.scalpingTendency > 0.5 ? '🏎️ Scalper' : patterns.hodlTendency > 0.5 ? '📊 Position Trader' : '📈 Swing Trader'}

📜 Recent Activity:
${metrics.recentActivity.slice(0, 5).map(a => `  ${a.side} ${a.size} @ ${a.price} - ${a.title}`).join('\n')}
`;
      
      const response = {
        success: true,
        answer: profileMessage,
        confidence: 100,
        userProfile: {
          maker,
          profile,
          metrics,
          positions: positions, // Send all positions for PositionTable
          activity: activity.slice(0, 50) // Increase activity for better insights
        }
      };
      
      console.log('[ZIGMA CHAT] Sending user profile response');
      return res.json(response);
    }
    
    // Use the original chat logic from server.js for market analysis
    const { resolveMarketIntent, generateEnhancedAnalysis, buildAssistantMessage, normalizeAction } = require('../../server');
    
    // Resolve market intent (handles URLs, market IDs, questions, etc.)
    const intent = await resolveMarketIntent({
      marketId: marketId,
      marketQuestion: marketQuestion || userQuery,
      query: userQuery,
      existingMarket: null
    });
    
    if (!intent?.market) {
      return res.status(404).json({
        error: 'No matching market found',
        message: 'Unable to find a market matching your query. Try providing a Polymarket URL or full market question.',
        query: userQuery
      });
    }
    
    const matchedMarket = intent.market;
    console.log('[ZIGMA CHAT] Analyzing market:', matchedMarket.question);
    
    // Generate analysis using the original LLM logic
    const analysis = await generateEnhancedAnalysis(matchedMarket);
    console.log('[ZIGMA CHAT] Analysis complete');
    
    // Build assistant message using original formatting
    const assistantMessage = buildAssistantMessage({
      analysis,
      matchedMarket,
      userPrompt: userQuery || marketQuestion || '(market analysis)'
    });
    
    const recommendation = {
      action: normalizeAction(analysis?.action),
      confidence: analysis?.confidence ?? null,
      probability: typeof analysis?.probability === 'number'
        ? Number((analysis.probability * 100).toFixed(2))
        : null,
      marketOdds: typeof matchedMarket?.yesPrice === 'number'
        ? Number((matchedMarket.yesPrice * 100).toFixed(2))
        : null,
      effectiveEdge: analysis?.effectiveEdge ?? null
    };
    
    const response = {
      success: true,
      answer: assistantMessage, // Full formatted response
      confidence: analysis?.confidence || 0,
      recommendation: recommendation,
      analysis: analysis,
      market: matchedMarket
    };
    
    console.log('[ZIGMA CHAT] Sending response (length:', assistantMessage.length, 'chars)');
    res.json(response);
  } catch (error) {
    console.error('[ZIGMA CHAT] Message error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process message: ' + error.message
    });
  }
});

module.exports = { router, requireZigmaTokens, getZigmaBalance, calculateAvailableChats };
