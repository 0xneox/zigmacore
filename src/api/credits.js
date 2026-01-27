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
  MIN_CREDITS_FOR_CHAT: 1
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

    // Get user's current credit balance
    const { data: user, error } = await db
      .from('users')
      .select('chat_credits, wallet_address')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('[CREDITS] Error fetching user data:', error);
      return res.status(500).json({ 
        error: 'Internal server error',
        message: 'Failed to verify user account'
      });
    }

    // Check if user has sufficient credits
    if (!user || !user.chat_credits || user.chat_credits < CREDIT_CONFIG.MIN_CREDITS_FOR_CHAT) {
      return res.status(403).json({ 
        error: 'Insufficient credits',
        message: 'You need at least 1 credit to chat. Please top up your account.',
        currentCredits: user?.chat_credits || 0,
        requiredCredits: CREDIT_CONFIG.MIN_CREDITS_FOR_CHAT,
        paymentRequired: true
      });
    }

    // Attach user credits to request for later use
    req.userCredits = user.chat_credits;
    req.userWallet = user.wallet_address;
    
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
async function deductCredit(userId, chatId) {
  try {
    const db = getSupabase();
    if (!db) {
      console.warn('[CREDITS] Database unavailable - credit deduction skipped');
      return false;
    }

    // Get current credits
    const { data: user, error: fetchError } = await db
      .from('users')
      .select('chat_credits')
      .eq('id', userId)
      .single();

    if (fetchError || !user) {
      console.error('[CREDITS] Error fetching user for credit deduction:', fetchError);
      return false;
    }

    const newBalance = Math.max(0, (user.chat_credits || 0) - CREDIT_CONFIG.CREDITS_PER_CHAT);

    // Update user credits
    const { error: updateError } = await db
      .from('users')
      .update({
        chat_credits: newBalance,
        last_chat_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updateError) {
      console.error('[CREDITS] Error updating user credits:', updateError);
      return false;
    }

    // Record credit usage
    const { error: usageError } = await db
      .from('credit_usage')
      .insert({
        user_id: userId,
        chat_id: chatId,
        credits_used: CREDIT_CONFIG.CREDITS_PER_CHAT,
        balance_before: user.chat_credits,
        balance_after: newBalance,
        created_at: new Date().toISOString()
      });

    if (usageError) {
      console.error('[CREDITS] Error recording credit usage:', usageError);
      // Don't fail the operation if usage recording fails
    }

    console.log(`[CREDITS] Deducted ${CREDIT_CONFIG.CREDITS_PER_CHAT} credit from user ${userId}. New balance: ${newBalance}`);
    
    return true;
  } catch (error) {
    console.error('[CREDITS] Error in deductCredit:', error);
    return false;
  }
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
        creditsPerChat: CREDIT_CONFIG.CREDITS_PER_CHAT,
        minCreditsRequired: CREDIT_CONFIG.MIN_CREDITS_FOR_CHAT,
        message: 'Database unavailable - credits system disabled'
      });
    }

    const { data: user, error } = await db
      .from('users')
      .select('chat_credits, total_credits_earned, last_payment_at, last_chat_at')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('[CREDITS] Error fetching credit balance:', error);
      return res.status(500).json({ 
        error: 'Internal server error',
        message: 'Failed to fetch credit balance'
      });
    }

    res.json({
      currentCredits: user?.chat_credits || 0,
      totalCreditsEarned: user?.total_credits_earned || 0,
      lastPaymentAt: user?.last_payment_at,
      lastChatAt: user?.last_chat_at,
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
