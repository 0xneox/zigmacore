const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

// GET /api/users/profile - Get user profile
router.get('/profile', authenticateUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    // If user doesn't exist in our users table, create them
    if (!data) {
      const newUser = {
        id: req.user.id,
        email: req.user.email,
        name: req.user.user_metadata?.name || req.user.email?.split('@')[0] || 'User',
        auth_provider: 'email',
        email_verified: req.user.email_confirmed || false
      };

      const { data: createdUser, error: createError } = await supabase
        .from('users')
        .insert(newUser)
        .select()
        .single();

      if (createError) throw createError;
      res.json(createdUser);
    } else {
      res.json(data);
    }
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PUT /api/users/profile - Update user profile
router.put('/profile', authenticateUser, async (req, res) => {
  try {
    const { name, avatar_url } = req.body;
    
    const updates = {};
    if (name) updates.name = name;
    if (avatar_url) updates.avatar_url = avatar_url;

    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// GET /api/users/preferences - Get user preferences
router.get('/preferences', authenticateUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    // If preferences don't exist, create default preferences
    if (!data) {
      const defaultPreferences = {
        user_id: req.user.id,
        email_notifications: true,
        signal_notifications: true,
        price_alerts: true,
        resolution_notifications: true,
        min_confidence_threshold: 0.7000,
        min_edge_threshold: 0.0500,
        max_position_size: 0.1000,
        risk_tolerance: 'medium',
        theme: 'dark',
        language: 'en',
        timezone: 'UTC',
        currency: 'USD',
        profile_public: false,
        share_analytics: false,
        data_retention_days: 365,
        api_key_enabled: false,
        api_rate_limit: 1000,
        custom_alerts: [],
        dashboard_layout: {},
        filter_preferences: {}
      };

      const { data: createdPrefs, error: createError } = await supabase
        .from('user_preferences')
        .insert(defaultPreferences)
        .select()
        .single();

      if (createError) throw createError;
      res.json(createdPrefs);
    } else {
      res.json(data);
    }
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

// PUT /api/users/preferences - Update user preferences
router.put('/preferences', authenticateUser, async (req, res) => {
  try {
    const preferences = req.body;
    
    const { data, error } = await supabase
      .from('user_preferences')
      .upsert({ ...preferences, user_id: req.user.id })
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// POST /api/users/link-wallet - Link wallet to user account
router.post('/link-wallet', authenticateUser, async (req, res) => {
  try {
    const { wallet_address } = req.body;

    if (!wallet_address) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    // Validate wallet address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet_address)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }

    // Check if wallet is already linked to another user
    const { data: existingWallet } = await supabase
      .from('users')
      .select('id')
      .eq('wallet_address', wallet_address)
      .single();

    if (existingWallet && existingWallet.id !== req.user.id) {
      return res.status(409).json({ error: 'Wallet already linked to another account' });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ 
        wallet_address,
        wallet_verified: true,
        auth_provider: 'wallet'
      })
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Link wallet error:', error);
    res.status(500).json({ error: 'Failed to link wallet' });
  }
});

module.exports = router;
