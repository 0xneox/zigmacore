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
 * Middleware to check ZIGMA token balance OR credits before allowing chat
 * Now supports free trial system via credits API
 */
async function requireZigmaTokens(req, res, next) {
  try {
    const walletAddress = req.user?.publicAddress;
    const userEmail = req.user?.email;
    const userIssuer = req.user?.issuer;
    
    console.log('[ZIGMA CHAT] requireZigmaTokens - req.user:', req.user);
    console.log('[ZIGMA CHAT] walletAddress:', walletAddress);
    console.log('[ZIGMA CHAT] userEmail:', userEmail);
    
    if (!walletAddress && !userEmail) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'User identification not found in session'
      });
    }

    // DEV EXCEPTION: Allow unlimited chat for dev/test accounts
    const DEV_EMAILS = ['neohex262@gmail.com', 'jissjoseph30@gmail.com'];
    console.log('[ZIGMA CHAT] Checking dev exception for email:', userEmail);
    
    if (userEmail && DEV_EMAILS.includes(userEmail.toLowerCase())) {
      console.log('[ZIGMA CHAT] ✅ DEV MODE: Unlimited chat access for', userEmail);
      return next();
    }
    
    console.log('[ZIGMA CHAT] Checking credits/free trial status...');

    // Use credits API to check for free trial or paid credits
    const { requireCredits } = require('./credits');
    
    // Create a mock request object for credits middleware
    const creditsReq = {
      user: { id: userEmail || userIssuer },
      body: { userId: userEmail || userIssuer }
    };
    
    const creditsRes = {
      status: (code) => ({
        json: (data) => {
          console.log('[ZIGMA CHAT] Credits check failed:', code, data);
          return res.status(code).json(data);
        }
      })
    };
    
    // Check credits using the credits middleware logic
    try {
      await requireCredits(creditsReq, creditsRes, () => {
        // Credits check passed
        console.log('[ZIGMA CHAT] ✅ Credits check passed');
        console.log('[ZIGMA CHAT] User credits:', creditsReq.userCredits);
        console.log('[ZIGMA CHAT] Free chats remaining:', creditsReq.freeChatsRemaining);
        console.log('[ZIGMA CHAT] Using free trial:', creditsReq.usingFreeTrial);
        console.log('[ZIGMA CHAT] User ID from credits:', creditsReq.userId);
        
        // Attach chat info to request
        req.chatInfo = {
          credits: creditsReq.userCredits || 0,
          freeChatsRemaining: creditsReq.freeChatsRemaining || 0,
          usingFreeTrial: creditsReq.usingFreeTrial || false,
          userEmail: userEmail,
          userId: creditsReq.userId || userEmail || userIssuer // Use actual DB user ID from requireCredits
        };
        
        next();
      });
    } catch (error) {
      console.error('[ZIGMA CHAT] Credits middleware error:', error);
      // Fallback to old ZIGMA balance check if credits system fails
      console.log('[ZIGMA CHAT] Falling back to ZIGMA balance check...');
      
      const balance = await getZigmaBalance(walletAddress);
      const availableChats = calculateAvailableChats(balance);
      
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
      
      req.chatInfo = {
        balance,
        availableChats,
        chatsUsed: 0,
        chatsRemaining: availableChats
      };
      
      next();
    }
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
    console.log('[ZIGMA CHAT] Chat info:', req.chatInfo);
    
    // Generate a unique chat ID for tracking
    const chatId = `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
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
      
      // Deduct credit after successful chat
      if (req.chatInfo?.userId) {
        console.log('[ZIGMA CHAT] Attempting to deduct credit...');
        console.log('[ZIGMA CHAT] - userId:', req.chatInfo.userId);
        console.log('[ZIGMA CHAT] - chatId:', chatId);
        console.log('[ZIGMA CHAT] - usingFreeTrial:', req.chatInfo.usingFreeTrial);
        
        const { deductCredit } = require('./credits');
        const deducted = await deductCredit(req.chatInfo.userId, chatId, req.chatInfo.usingFreeTrial);
        
        if (deducted) {
          console.log('[ZIGMA CHAT] ✅ Credit successfully deducted for user:', req.chatInfo.userId);
        } else {
          console.error('[ZIGMA CHAT] ❌ Failed to deduct credit for user:', req.chatInfo.userId);
        }
      } else {
        console.error('[ZIGMA CHAT] ⚠️ No userId in chatInfo, credit deduction skipped');
      }
      
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
    const isMultiOutcome = !!intent.allMarkets && intent.allMarkets.length > 1;
    
    // MULTI-OUTCOME: Analyze ALL outcomes and return top opportunities
    if (isMultiOutcome) {
      console.log(`[ZIGMA CHAT] Multi-outcome event detected: ${intent.allMarkets.length} outcomes`);
      console.log('[ZIGMA CHAT] Analyzing all outcomes...');
      
      const allAnalyses = [];
      
      for (const market of intent.allMarkets) {
        try {
          const analysis = await generateEnhancedAnalysis(market);
          allAnalyses.push({
            market,
            analysis,
            edge: analysis?.effectiveEdge || 0,
            confidence: analysis?.confidence || 0
          });
        } catch (error) {
          console.error(`[ZIGMA CHAT] Error analyzing ${market.question}:`, error.message);
        }
      }
      
      // Sort by edge (best opportunities first)
      allAnalyses.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
      
      // Filter to only active markets (exclude resolved ones with yesPrice 0 or 1)
      const activeAnalyses = allAnalyses.filter(a => {
        const yesPrice = a.market?.yesPrice;
        return typeof yesPrice === 'number' && yesPrice > 0.001 && yesPrice < 0.999;
      });
      
      // Take top 5 opportunities from active markets only
      const topOpportunities = activeAnalyses.slice(0, 5);
      
      console.log(`[ZIGMA CHAT] Found ${topOpportunities.length} top opportunities`);
      
      // Build multi-outcome response
      let multiOutcomeMessage = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      multiOutcomeMessage += `🎯 MULTI-OUTCOME EVENT ANALYSIS\n`;
      multiOutcomeMessage += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      multiOutcomeMessage += `📊 Analyzed ${intent.allMarkets.length} outcomes\n`;
      multiOutcomeMessage += `🏆 Top ${topOpportunities.length} Opportunities:\n\n`;
      
      topOpportunities.forEach((opp, idx) => {
        const action = normalizeAction(opp.analysis?.action);
        const actionEmoji = action === 'BUY_YES' ? '🟢' : action === 'BUY_NO' ? '🔴' : '⚪';
        multiOutcomeMessage += `${idx + 1}. ${actionEmoji} ${opp.market.question}\n`;
        multiOutcomeMessage += `   Action: ${action}\n`;
        multiOutcomeMessage += `   Zigma Odds: ${(opp.analysis?.probability * 100).toFixed(1)}%\n`;
        multiOutcomeMessage += `   Market Odds: ${(opp.market.yesPrice * 100).toFixed(1)}%\n`;
        multiOutcomeMessage += `   Edge: ${opp.edge > 0 ? '+' : ''}${opp.edge.toFixed(2)}%\n`;
        multiOutcomeMessage += `   Confidence: ${opp.confidence}%\n\n`;
      });
      
      // Filter out resolved/closed markets - only show active ones with valid prices
      // Exclude markets where yesPrice is 0 or 1 (resolved to NO or YES)
      const activeMarkets = intent.allMarkets.filter(m => {
        const hasValidPrice = typeof m.yesPrice === 'number' && m.yesPrice > 0.001 && m.yesPrice < 0.999;
        const isActive = m.active !== false && m.closed !== true;
        const hasLiquidity = !m.liquidity || m.liquidity > 0; // Allow if liquidity undefined or > 0
        return hasValidPrice && isActive && hasLiquidity;
      });
      
      console.log(`[ZIGMA CHAT] Filtered markets: ${intent.allMarkets.length} total → ${activeMarkets.length} active`);
      
      const response = {
        success: true,
        answer: multiOutcomeMessage,
        confidence: topOpportunities[0]?.confidence || 0,
        recommendation: {
          action: normalizeAction(topOpportunities[0]?.analysis?.action),
          confidence: topOpportunities[0]?.confidence || 0,
          probability: topOpportunities[0]?.analysis?.probability 
            ? Number((topOpportunities[0].analysis.probability * 100).toFixed(2))
            : null,
          marketOdds: topOpportunities[0]?.market?.yesPrice
            ? Number((topOpportunities[0].market.yesPrice * 100).toFixed(2))
            : null,
          effectiveEdge: topOpportunities[0]?.edge || null
        },
        analysis: topOpportunities[0]?.analysis,
        market: topOpportunities[0]?.market,
        allMarkets: activeMarkets, // Only send active markets to frontend
        allAnalyses: topOpportunities,
        isMultiOutcome: true
      };
      
      console.log('[ZIGMA CHAT] Sending multi-outcome response (length:', multiOutcomeMessage.length, 'chars)');
      console.log('[ZIGMA CHAT] Multi-outcome data:', {
        isMultiOutcome: response.isMultiOutcome,
        allMarketsCount: response.allMarkets?.length || 0,
        topOpportunitiesCount: topOpportunities.length
      });
      
      // Deduct credit after successful chat
      if (req.chatInfo?.userId) {
        console.log('[ZIGMA CHAT] Attempting to deduct credit...');
        const { deductCredit } = require('./credits');
        const deducted = await deductCredit(req.chatInfo.userId, chatId, req.chatInfo.usingFreeTrial);
        if (deducted) {
          console.log('[ZIGMA CHAT] ✅ Credit successfully deducted');
        } else {
          console.error('[ZIGMA CHAT] ❌ Failed to deduct credit');
        }
      } else {
        console.error('[ZIGMA CHAT] ⚠️ No userId in chatInfo, credit deduction skipped');
      }
      
      return res.json(response);
    }
    
    // SINGLE OUTCOME: Original logic
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
      market: matchedMarket,
      allMarkets: intent.allMarkets || null, // Multi-outcome events
      isMultiOutcome: false
    };
    
    console.log('[ZIGMA CHAT] Sending response (length:', assistantMessage.length, 'chars)');
    console.log('[ZIGMA CHAT] Multi-outcome data:', {
      isMultiOutcome: response.isMultiOutcome,
      allMarketsCount: response.allMarkets?.length || 0,
      hasIntent: !!intent,
      hasIntentAllMarkets: !!intent.allMarkets,
      intentAllMarketsCount: intent.allMarkets?.length || 0
    });
    
    // Deduct credit after successful chat
    if (req.chatInfo?.userId) {
      console.log('[ZIGMA CHAT] Attempting to deduct credit...');
      console.log('[ZIGMA CHAT] - userId:', req.chatInfo.userId);
      console.log('[ZIGMA CHAT] - chatId:', chatId);
      console.log('[ZIGMA CHAT] - usingFreeTrial:', req.chatInfo.usingFreeTrial);
      
      const { deductCredit } = require('./credits');
      const deducted = await deductCredit(req.chatInfo.userId, chatId, req.chatInfo.usingFreeTrial);
      
      if (deducted) {
        console.log('[ZIGMA CHAT] ✅ Credit successfully deducted for user:', req.chatInfo.userId);
      } else {
        console.error('[ZIGMA CHAT] ❌ Failed to deduct credit for user:', req.chatInfo.userId);
      }
    } else {
      console.error('[ZIGMA CHAT] ⚠️ No userId in chatInfo, credit deduction skipped');
    }
    
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
