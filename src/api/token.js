const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ZIGMA token configuration
const ZIGMA_TOKEN_MINT = 'xT4tzTkuyXyDqCWeZyahrhnknPd8KBuuNjPngvqcyai';
const MIN_TOKEN_HOLDING = 1; // Minimum 1 ZIGMA token required

// Middleware to verify user authentication
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }

    const token = authHeader.substring(7);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Unauthorized - Invalid token' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Helper function to check Solana token holdings
async function checkTokenHoldings(walletAddress) {
  try {
    if (!walletAddress) {
      return { hasTokens: false, balance: 0 };
    }

    console.log(`Checking token holdings for wallet: ${walletAddress}`);
    
    // Use DexScreener API to check token holdings
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/solana/${walletAddress}`);
    const data = await response.json();
    
    if (data.pairs && data.pairs.length > 0) {
      // Look for ZIGMA token pairs
      const zigmaPairs = data.pairs.filter(pair => 
        pair.baseToken.address === ZIGMA_TOKEN_MINT || 
        pair.quoteToken.address === ZIGMA_TOKEN_MINT
      );
      
      if (zigmaPairs.length > 0) {
        // Calculate total ZIGMA balance across all pairs
        let totalBalance = 0;
        for (const pair of zigmaPairs) {
          if (pair.baseToken.address === ZIGMA_TOKEN_MINT) {
            totalBalance += parseFloat(pair.balance || 0);
          } else if (pair.quoteToken.address === ZIGMA_TOKEN_MINT) {
            totalBalance += parseFloat(pair.balance || 0);
          }
        }
        
        console.log(`Found ZIGMA balance: ${totalBalance}`);
        return { hasTokens: totalBalance > 0, balance: totalBalance };
      }
    }
    
    return { hasTokens: false, balance: 0 };
  } catch (error) {
    console.error('Error checking token holdings:', error);
    return { hasTokens: false, balance: 0 };
  }
}

// GET /api/token/check - Check if user holds ZIGMA tokens
router.get('/check', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get user's wallet address from database
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('wallet_address, email')
      .eq('id', userId)
      .single();

    if (userError) {
      console.error('Error fetching user data:', userError);
      return res.status(500).json({ error: 'Failed to fetch user data' });
    }

    let walletAddress = userData?.wallet_address;
    
    // If no wallet address but user has email, create a mock wallet for demo
    if (!walletAddress && userData?.email) {
      // For email users, we'll use a deterministic mock wallet
      walletAddress = `mock_${userData.email.replace(/[^a-zA-Z0-9]/g, '')}`;
    }

    if (!walletAddress) {
      return res.json({
        hasTokens: false,
        balance: 0,
        requiresToken: true,
        message: 'Please connect your wallet to verify token holdings'
      });
    }

    // Check token holdings
    const { hasTokens, balance } = await checkTokenHoldings(walletAddress);
    
    const response = {
      hasTokens: hasTokens && balance >= MIN_TOKEN_HOLDING,
      balance,
      requiresToken: true,
      minTokenRequired: MIN_TOKEN_HOLDING,
      tokenMint: ZIGMA_TOKEN_MINT,
      walletAddress: walletAddress.startsWith('mock_') ? null : walletAddress
    };

    // Update user's token status in database
    await supabase
      .from('users')
      .update({
        has_zigma_tokens: response.hasTokens,
        zigma_balance: balance,
        token_check_at: new Date().toISOString()
      })
      .eq('id', userId);

    res.json(response);
  } catch (error) {
    console.error('Token check error:', error);
    res.status(500).json({ error: 'Failed to check token holdings' });
  }
});

// POST /api/token/verify - Verify specific wallet address holds tokens
router.post('/verify', async (req, res) => {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    // Validate wallet address format (basic check)
    if (walletAddress.length < 32) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }

    // Check token holdings
    const { hasTokens, balance } = await checkTokenHoldings(walletAddress);
    
    res.json({
      walletAddress,
      hasTokens: hasTokens && balance >= MIN_TOKEN_HOLDING,
      balance,
      requiresToken: true,
      minTokenRequired: MIN_TOKEN_HOLDING,
      tokenMint: ZIGMA_TOKEN_MINT
    });
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({ error: 'Failed to verify token holdings' });
  }
});

// GET /api/token/status - Get token status for current user
router.get('/status', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get user's token status from database
    const { data: userData, error } = await supabase
      .from('users')
      .select('has_zigma_tokens, zigma_balance, token_check_at, wallet_address')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('Error fetching token status:', error);
      return res.status(500).json({ error: 'Failed to fetch token status' });
    }

    res.json({
      hasTokens: userData?.has_zigma_tokens || false,
      balance: userData?.zigma_balance || 0,
      lastChecked: userData?.token_check_at,
      walletAddress: userData?.wallet_address,
      requiresToken: true,
      minTokenRequired: MIN_TOKEN_HOLDING,
      tokenMint: ZIGMA_TOKEN_MINT
    });
  } catch (error) {
    console.error('Token status error:', error);
    res.status(500).json({ error: 'Failed to get token status' });
  }
});

module.exports = router;
