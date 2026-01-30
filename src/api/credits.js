const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

// Lazy Supabase client initialization
let supabase = null;

function getSupabase() {
  if (supabase) return supabase;
  
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      console.warn('[CREDITS] Supabase credentials not found. Credits system disabled.');
      return null;
    }
    
    supabase = createClient(supabaseUrl, supabaseKey);
    return supabase;
  } catch (error) {
    console.error('[CREDITS] Failed to initialize Supabase:', error.message);
    return null;
  }
}

// Credit configuration
const CREDIT_CONFIG = {
  CREDITS_PER_PAYMENT: 25,
  CREDITS_PER_CHAT: 1,
  REQUIRED_USD_AMOUNT: 25,
  MIN_CREDITS_FOR_CHAT: 1,
  FREE_TRIAL_CHATS: 3  // New users get 3 free chats
};

// Middleware to check if user has sufficient credits
async function requireCredits(req, res, next) {
  try {
    const userId = req.user?.id || req.body?.userId;
    
    if (!userId) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'User authentication required'
      });
    }

    const db = getSupabase();
    if (!db) {
      // Database unavailable - allow chat without credits in development mode
      console.warn('[CREDITS] Database unavailable - allowing chat without credit check');
      return next();
    }

    // Extract wallet address from DID format if needed
    const walletOrId = extractWalletFromUserId(userId);
    
    console.log(`[CREDITS] requireCredits - Looking up user: original=${userId}, extracted=${walletOrId}`);

    // Build query based on identifier type
    let query = db
      .from('users')
      .select('id, chat_credits, wallet_address, free_chats_remaining, email');
    
    // Check if it looks like a UUID (format: 8-4-4-4-12 hex characters with dashes)
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(walletOrId);
    
    if (isUUID) {
      // Query by id if it's a valid UUID
      query = query.eq('id', walletOrId);
    } else if (walletOrId.includes('@')) {
      // Query by email if it contains @
      query = query.eq('email', walletOrId);
    } else {
      // Otherwise search by wallet_address (Solana or Ethereum address)
      query = query.eq('wallet_address', walletOrId);
    }
    
    const { data: user, error } = await query.single();

    if (error) {
      console.error('[CREDITS] Error fetching user data:', error);
      
      // If user not found, allow with free trial defaults (new user)
      if (error.code === 'PGRST116') {
        console.log('[CREDITS] User not found - allowing as new user with free trial');
        req.userCredits = 0;
        req.userWallet = walletOrId.includes('@') ? null : walletOrId;
        req.freeChatsRemaining = CREDIT_CONFIG.FREE_TRIAL_CHATS;
        req.usingFreeTrial = true;
        req.userId = walletOrId;
        return next();
      }
      
      return res.status(500).json({ 
        error: 'Internal server error',
        message: 'Failed to verify user account'
      });
    }

    console.log(`[CREDITS] Found user: id=${user.id}, credits=${user.chat_credits}, freeChats=${user.free_chats_remaining}`);

    // Check if user has free trial chats remaining
    const freeChatsRemaining = user?.free_chats_remaining || 0;
    
    if (freeChatsRemaining > 0) {
      // User has free trial chats - allow chat
      req.userCredits = user.chat_credits || 0;
      req.userWallet = user.wallet_address;
      req.freeChatsRemaining = freeChatsRemaining;
      req.usingFreeTrial = true;
      req.userId = user.id; // Store actual database ID for credit deduction
      console.log(`[CREDITS] User ${user.id} using free trial. ${freeChatsRemaining} free chats remaining.`);
      return next();
    }

    // Free trial exhausted - check if user has sufficient credits
    if (!user || !user.chat_credits || user.chat_credits < CREDIT_CONFIG.MIN_CREDITS_FOR_CHAT) {
      return res.status(403).json({ 
        error: 'Insufficient credits',
        message: 'Your free trial is over. You need ZIGMA tokens or credits to continue chatting.',
        currentCredits: user?.chat_credits || 0,
        requiredCredits: CREDIT_CONFIG.MIN_CREDITS_FOR_CHAT,
        freeTrialUsed: true,
        paymentRequired: true
      });
    }

    // Attach user credits to request for later use
    req.userCredits = user.chat_credits;
    req.userWallet = user.wallet_address;
    req.freeChatsRemaining = 0;
    req.usingFreeTrial = false;
    req.userId = user.id; // Store actual database ID for credit deduction
    
    next();
  } catch (error) {
    console.error('[CREDITS] Error in requireCredits middleware:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to verify credits'
    });
  }
}

// Deduct credit after successful chat
async function deductCredit(userId, chatId, usingFreeTrial = false) {
  try {
    const db = getSupabase();
    if (!db) {
      console.warn('[CREDITS] Database unavailable - credit deduction skipped');
      return false;
    }

    // Get current credits and free trial status
    const { data: user, error: fetchError } = await db
      .from('users')
      .select('chat_credits, free_chats_remaining')
      .eq('id', userId)
      .single();

    if (fetchError || !user) {
      console.error('[CREDITS] Error fetching user for credit deduction:', fetchError);
      return false;
    }

    let updateData = {
      last_chat_at: new Date().toISOString()
    };
    
    let usageType = 'credit';
    let balanceBefore = user.chat_credits || 0;
    let balanceAfter = balanceBefore;

    // Check if using free trial
    if (usingFreeTrial || (user.free_chats_remaining && user.free_chats_remaining > 0)) {
      // Deduct from free trial
      const newFreeChats = Math.max(0, (user.free_chats_remaining || 0) - 1);
      updateData.free_chats_remaining = newFreeChats;
      usageType = 'free_trial';
      balanceBefore = user.free_chats_remaining || 0;
      balanceAfter = newFreeChats;
      
      console.log(`[CREDITS] Deducted 1 free chat from user ${userId}. Remaining free chats: ${newFreeChats}`);
    } else {
      // Deduct from paid credits
      const newBalance = Math.max(0, (user.chat_credits || 0) - CREDIT_CONFIG.CREDITS_PER_CHAT);
      updateData.chat_credits = newBalance;
      balanceAfter = newBalance;
      
      console.log(`[CREDITS] Deducted ${CREDIT_CONFIG.CREDITS_PER_CHAT} credit from user ${userId}. New balance: ${newBalance}`);
    }

    // Update user
    const { error: updateError } = await db
      .from('users')
      .update(updateData)
      .eq('id', userId);

    if (updateError) {
      console.error('[CREDITS] Error updating user:', updateError);
      return false;
    }

    // Record credit usage
    const { error: usageError } = await db
      .from('credit_usage')
      .insert({
        user_id: userId,
        chat_id: chatId,
        credits_used: usageType === 'free_trial' ? 0 : CREDIT_CONFIG.CREDITS_PER_CHAT,
        usage_type: usageType,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        created_at: new Date().toISOString()
      });

    if (usageError) {
      console.error('[CREDITS] Error recording credit usage:', usageError);
      // Don't fail the operation if usage recording fails
    }
    
    return true;
  } catch (error) {
    console.error('[CREDITS] Error in deductCredit:', error);
    return false;
  }
}

// Helper function to extract wallet address from DID or return as-is
function extractWalletFromUserId(userId) {
  if (!userId) return null;
  
  // Check if it's a DID format: did:ethr:0x...
  const didMatch = userId.match(/^did:ethr:(0x[a-fA-F0-9]{40})/i);
  if (didMatch) {
    return didMatch[1];
  }
  
  // Check if it's a Solana address (base58, typically 32-44 chars)
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(userId)) {
    return userId;
  }
  
  // Check if it's already an Ethereum address
  if (/^0x[a-fA-F0-9]{40}$/.test(userId)) {
    return userId;
  }
  
  // Otherwise assume it's a UUID
  return userId;
}

// GET /api/credits/balance - Get user's credit balance
router.get('/balance', async (req, res) => {
  try {
    const userId = req.user?.id || req.query.userId;
    
    if (!userId) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'User authentication required'
      });
    }

    const db = getSupabase();
    if (!db) {
      return res.json({
        currentCredits: 0,
        totalCreditsEarned: 0,
        lastPaymentAt: null,
        lastChatAt: null,
        freeChatsRemaining: 0,
        freeTrialTotal: CREDIT_CONFIG.FREE_TRIAL_CHATS,
        creditsPerChat: CREDIT_CONFIG.CREDITS_PER_CHAT,
        minCreditsRequired: CREDIT_CONFIG.MIN_CREDITS_FOR_CHAT,
        message: 'Database unavailable - credits system disabled'
      });
    }

    // Extract wallet address from DID format if needed
    const walletOrId = extractWalletFromUserId(userId);
    
    console.log(`[CREDITS] Looking up user: original=${userId}, extracted=${walletOrId}`);

    // Try to find user by wallet_address first, then by id
    let query = db
      .from('users')
      .select('id, chat_credits, total_credits_earned, last_payment_at, last_chat_at, free_chats_remaining, wallet_address, email');
    
    // Check if it looks like a UUID (format: 8-4-4-4-12 hex characters with dashes)
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(walletOrId);
    
    if (isUUID) {
      // Query by id if it's a valid UUID
      query = query.eq('id', walletOrId);
    } else if (walletOrId.includes('@')) {
      // Query by email if it contains @
      query = query.eq('email', walletOrId);
    } else {
      // Otherwise search by wallet_address (Solana or Ethereum address)
      query = query.eq('wallet_address', walletOrId);
    }
    
    const { data: user, error } = await query.single();

    if (error) {
      console.error('[CREDITS] Error fetching credit balance:', error);
      
      // If user not found, return default values (new user scenario)
      if (error.code === 'PGRST116') {
        console.log('[CREDITS] User not found in database, returning defaults for new user');
        return res.json({
          currentCredits: 0,
          totalCreditsEarned: 0,
          lastPaymentAt: null,
          lastChatAt: null,
          freeChatsRemaining: CREDIT_CONFIG.FREE_TRIAL_CHATS,
          freeTrialTotal: CREDIT_CONFIG.FREE_TRIAL_CHATS,
          creditsPerChat: CREDIT_CONFIG.CREDITS_PER_CHAT,
          minCreditsRequired: CREDIT_CONFIG.MIN_CREDITS_FOR_CHAT,
          message: 'New user - free trial available'
        });
      }
      
      return res.status(500).json({ 
        error: 'Internal server error',
        message: 'Failed to fetch credit balance'
      });
    }

    console.log(`[CREDITS] Found user: id=${user.id}, credits=${user.chat_credits}, freeChats=${user.free_chats_remaining}`);

    res.json({
      currentCredits: user?.chat_credits || 0,
      totalCreditsEarned: user?.total_credits_earned || 0,
      lastPaymentAt: user?.last_payment_at,
      lastChatAt: user?.last_chat_at,
      freeChatsRemaining: user?.free_chats_remaining || 0,
      freeTrialTotal: CREDIT_CONFIG.FREE_TRIAL_CHATS,
      creditsPerChat: CREDIT_CONFIG.CREDITS_PER_CHAT,
      minCreditsRequired: CREDIT_CONFIG.MIN_CREDITS_FOR_CHAT
    });
  } catch (error) {
    console.error('[CREDITS] Error fetching credit balance:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to fetch credit balance'
    });
  }
});

// GET /api/credits/history - Get credit usage history
router.get('/history', async (req, res) => {
  try {
    const userId = req.user?.id || req.query.userId;
    const limit = parseInt(req.query.limit) || 50;
    
    if (!userId) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'User authentication required'
      });
    }

    const { data: history, error } = await supabase
      .from('credit_usage')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[CREDITS] Error fetching credit history:', error);
      return res.status(500).json({ 
        error: 'Internal server error',
        message: 'Failed to fetch credit history'
      });
    }

    res.json({ history });
  } catch (error) {
    console.error('[CREDITS] Error in credit history endpoint:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to fetch credit history'
    });
  }
});

// GET /api/credits/stats - Get credit statistics
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user?.id || req.query.userId;
    
    if (!userId) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'User authentication required'
      });
    }

    // Get user's total credit usage
    const { data: usageData, error: usageError } = await supabase
      .from('credit_usage')
      .select('credits_used, created_at')
      .eq('user_id', userId);

    if (usageError) {
      console.error('[CREDITS] Error fetching credit stats:', usageError);
      return res.status(500).json({ 
        error: 'Internal server error',
        message: 'Failed to fetch credit statistics'
      });
    }

    const totalCreditsUsed = usageData.reduce((sum, record) => sum + record.credits_used, 0);
    const totalChats = usageData.length;

    // Calculate average credits per day (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const recentUsage = usageData.filter(record => 
      new Date(record.created_at) > sevenDaysAgo
    );
    
    const avgCreditsPerDay = recentUsage.length > 0 
      ? recentUsage.reduce((sum, record) => sum + record.credits_used, 0) / 7
      : 0;

    res.json({
      totalCreditsUsed,
      totalChats,
      avgCreditsPerDay: Math.round(avgCreditsPerDay * 100) / 100,
      creditsPerChat: CREDIT_CONFIG.CREDITS_PER_CHAT
    });
  } catch (error) {
    console.error('[CREDITS] Error in credit stats endpoint:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to fetch credit statistics'
    });
  }
});

module.exports = {
  router,
  requireCredits,
  deductCredit,
  CREDIT_CONFIG
};
