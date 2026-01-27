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
      console.warn('[PAYMENTS] Supabase credentials not found. Payment system disabled.');
      return null;
    }
    
    supabase = createClient(supabaseUrl, supabaseKey);
    return supabase;
  } catch (error) {
    console.error('[PAYMENTS] Failed to initialize Supabase:', error.message);
    return null;
  }
}

// Payment configuration
const PAYMENT_CONFIG = {
  ZIGMA_TOKEN_MINT: 'xT4tzTkuyXyDqCWeZyahrhnknPd8KBuuNjPngvqcyai',
  PAYMENT_WALLET_ADDRESS: process.env.PAYMENT_WALLET_ADDRESS || '8xXtE9nL3mFzKqY5vZ2hP7mRtNqW4sKbV6cD8fG3hJkL',
  REQUIRED_USD_AMOUNT: 25,
  CREDITS_PER_PAYMENT: 25,
  PRICE_PER_CREDIT: 1
};

// Helper: Validate Solana address format
function isValidSolanaAddress(address) {
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Test(address);
}

function base58Test(address) {
  try {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = BigInt(0);
    for (let i = 0; i < address.length; i++) {
      const char = address[i];
      const index = alphabet.indexOf(char);
      if (index === -1) return false;
      num = num * BigInt(58) + BigInt(index);
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Helper: Calculate ZIGMA tokens needed for $25 USD
async function calculateZigmaAmount(usdAmount) {
  // In production, fetch real-time price from DexScreener or Jupiter API
  // For now, assume 1 ZIGMA = $1 (adjust based on actual token price)
  const zigmaPriceUSD = 1; // $1 per ZIGMA token
  return Math.ceil(usdAmount / zigmaPriceUSD);
}

// POST /api/payments/webhook - Helius webhook endpoint
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  // Note: Helius doesn't support webhook secrets, so we use IP whitelisting instead
  // Add your server's IP to Helius webhook whitelist for security
  
  try {
    const payload = JSON.parse(req.body.toString());
    console.log('[PAYMENT] Helius webhook received:', JSON.stringify(payload, null, 2));

    // Handle different webhook types
    if (payload.type === 'TRANSACTION') {
      await handleTransactionWebhook(payload);
    } else if (payload.type === 'ACCOUNT') {
      await handleAccountWebhook(payload);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[PAYMENT] Webhook processing error:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Handle transaction webhook
async function handleTransactionWebhook(payload) {
  const transaction = payload.transaction;
  
  if (!transaction) {
    console.log('[PAYMENT] No transaction in webhook payload');
    return;
  }

  // Check if transaction is to payment wallet
  const transfers = extractTokenTransfers(transaction);
  
  for (const transfer of transfers) {
    if (transfer.toAddress === PAYMENT_CONFIG.PAYMENT_WALLET_ADDRESS) {
      await processPayment(transfer, transaction);
    }
  }
}

// Extract token transfers from transaction
function extractTokenTransfers(transaction) {
  const transfers = [];
  
  try {
    // Parse transaction to find token transfers
    // This depends on Helius webhook payload structure
    if (transaction.tokenTransfers) {
      for (const transfer of transaction.tokenTransfers) {
        transfers.push({
          fromAddress: transfer.fromUserAccount,
          toAddress: transfer.toUserAccount,
          tokenMint: transfer.mint,
          amount: transfer.tokenAmount,
          decimals: transfer.decimals
        });
      }
    }
  } catch (error) {
    console.error('[PAYMENT] Error extracting token transfers:', error);
  }
  
  return transfers;
}

// Process payment transaction
async function processPayment(transfer, transaction) {
  try {
    // Validate token mint
    if (transfer.tokenMint !== PAYMENT_CONFIG.ZIGMA_TOKEN_MINT) {
      console.log(`[PAYMENT] Invalid token mint: ${transfer.tokenMint}`);
      return;
    }

    // Validate amount (minimum $25 worth)
    const zigmaAmount = transfer.amount / Math.pow(10, transfer.decimals || 9);
    const usdValue = zigmaAmount; // Assuming 1 ZIGMA = $1
    
    if (usdValue < PAYMENT_CONFIG.REQUIRED_USD_AMOUNT) {
      console.log(`[PAYMENT] Insufficient amount: ${usdValue} USD (required: ${PAYMENT_CONFIG.REQUIRED_USD_AMOUNT} USD)`);
      return;
    }

    // Check if transaction already processed
    const { data: existingPayment } = await supabase
      .from('payments')
      .select('id')
      .eq('transaction_signature', transaction.signature)
      .single();

    if (existingPayment) {
      console.log('[PAYMENT] Transaction already processed:', transaction.signature);
      return;
    }

    // Get or create user by wallet address
    const user = await getOrCreateUser(transfer.fromAddress);
    
    if (!user) {
      console.error('[PAYMENT] Failed to get/create user:', transfer.fromAddress);
      return;
    }

    // Calculate credits
    const creditsEarned = Math.floor(usdValue / PAYMENT_CONFIG.PRICE_PER_CREDIT);
    
    // Record payment
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .insert({
        user_id: user.id,
        wallet_address: transfer.fromAddress,
        transaction_signature: transaction.signature,
        token_mint: transfer.tokenMint,
        amount: zigmaAmount,
        usd_value: usdValue,
        credits_earned: creditsEarned,
        status: 'completed',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (paymentError) {
      console.error('[PAYMENT] Error recording payment:', paymentError);
      return;
    }

    // Update user credits
    const { error: updateError } = await supabase
      .from('users')
      .update({
        chat_credits: (user.chat_credits || 0) + creditsEarned,
        total_credits_earned: (user.total_credits_earned || 0) + creditsEarned,
        last_payment_at: new Date().toISOString()
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('[PAYMENT] Error updating user credits:', updateError);
      return;
    }

    console.log(`[PAYMENT] Payment processed successfully: User ${user.id} earned ${creditsEarned} credits`);
    
  } catch (error) {
    console.error('[PAYMENT] Error processing payment:', error);
  }
}

// Get or create user by wallet address
async function getOrCreateUser(walletAddress) {
  const db = getSupabase();
  if (!db) {
    console.warn('[PAYMENTS] Database unavailable - cannot create user');
    return null;
  }

  try {
    // Try to find existing user
    const { data: existingUser, error: fetchError } = await db
      .from('users')
      .select('*')
      .eq('wallet_address', walletAddress)
      .single();

    if (existingUser) {
      return existingUser;
    }

    // Create new user
    const { data: newUser, error: createError } = await db
      .from('users')
      .insert({
        wallet_address: walletAddress,
        auth_provider: 'wallet',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (createError) {
      console.error('[PAYMENTS] Error creating user:', createError);
      return null;
    }

    console.log(`[PAYMENTS] Created new user for wallet: ${walletAddress}`);
    return newUser;
  } catch (error) {
    console.error('[PAYMENTS] Error in getOrCreateUser:', error);
    return null;
  }
}

// GET /api/payments/config - Get payment configuration for frontend
router.get('/config', async (req, res) => {
  res.json({
    paymentWalletAddress: PAYMENT_CONFIG.PAYMENT_WALLET_ADDRESS,
    zigmaTokenMint: PAYMENT_CONFIG.ZIGMA_TOKEN_MINT,
    requiredAmount: PAYMENT_CONFIG.REQUIRED_USD_AMOUNT,
    creditsPerPayment: PAYMENT_CONFIG.CREDITS_PER_PAYMENT,
    pricePerCredit: PAYMENT_CONFIG.PRICE_PER_CREDIT,
    minConfirmations: PAYMENT_CONFIG.MIN_CONFIRMATIONS
  });
});

// GET /api/payments/user/:userId - Get user payment history
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const { data: payments, error } = await supabase
      .from('payments')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[PAYMENT] Error fetching payment history:', error);
      return res.status(500).json({ error: 'Failed to fetch payment history' });
    }

    res.json({ payments });
  } catch (error) {
    console.error('[PAYMENT] Error in payment history endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/payments/manual - Manual payment verification (for testing)
router.post('/manual', async (req, res) => {
  try {
    const { transactionSignature, walletAddress, amount } = req.body;

    if (!transactionSignature || !walletAddress || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // In production, verify transaction on blockchain
    // For now, create manual payment record
    const user = await getOrCreateUser(walletAddress);
    
    if (!user) {
      return res.status(500).json({ error: 'Failed to get/create user' });
    }

    const creditsEarned = PAYMENT_CONFIG.CREDITS_PER_PAYMENT;

    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .insert({
        user_id: user.id,
        wallet_address: walletAddress,
        transaction_signature: transactionSignature,
        token_mint: PAYMENT_CONFIG.ZIGMA_TOKEN_MINT,
        amount: amount,
        usd_value: PAYMENT_CONFIG.REQUIRED_USD_AMOUNT,
        credits_earned: creditsEarned,
        status: 'completed',
        manual: true,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (paymentError) {
      console.error('[PAYMENT] Error recording manual payment:', paymentError);
      return res.status(500).json({ error: 'Failed to record payment' });
    }

    // Update user credits
    const { error: updateError } = await supabase
      .from('users')
      .update({
        chat_credits: (user.chat_credits || 0) + creditsEarned,
        total_credits_earned: (user.total_credits_earned || 0) + creditsEarned,
        last_payment_at: new Date().toISOString()
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('[PAYMENT] Error updating user credits:', updateError);
      return res.status(500).json({ error: 'Failed to update credits' });
    }

    res.json({ 
      success: true, 
      payment,
      creditsEarned,
      newBalance: (user.chat_credits || 0) + creditsEarned
    });
  } catch (error) {
    console.error('[PAYMENT] Error in manual payment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
