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

// GET /api/watchlist - Get user's watchlist
router.get('/', authenticateUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('watchlist')
      .select('*')
      .eq('user_id', req.user.id)
      .order('added_at', { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Get watchlist error:', error);
    res.status(500).json({ error: 'Failed to fetch watchlist' });
  }
});

// POST /api/watchlist - Add item to watchlist
router.post('/', authenticateUser, async (req, res) => {
  try {
    const { marketId, platform = 'polymarket', question, category, description } = req.body;

    if (!marketId || !question) {
      return res.status(400).json({ error: 'Market ID and question are required' });
    }

    // Check if item already exists
    const { data: existing } = await supabase
      .from('watchlist')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('market_id', marketId)
      .eq('platform', platform)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Item already in watchlist' });
    }

    const watchlistItem = {
      user_id: req.user.id,
      market_id: marketId,
      platform,
      question,
      category,
      description,
      status: 'active'
    };

    const { data, error } = await supabase
      .from('watchlist')
      .insert(watchlistItem)
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (error) {
    console.error('Add to watchlist error:', error);
    res.status(500).json({ error: 'Failed to add to watchlist' });
  }
});

// DELETE /api/watchlist/:marketId - Remove item from watchlist
router.delete('/:marketId', authenticateUser, async (req, res) => {
  try {
    const { marketId } = req.params;
    const { platform = 'polymarket' } = req.query;

    const { error } = await supabase
      .from('watchlist')
      .delete()
      .eq('user_id', req.user.id)
      .eq('market_id', marketId)
      .eq('platform', platform);

    if (error) throw error;

    res.json({ message: 'Item removed from watchlist' });
  } catch (error) {
    console.error('Remove from watchlist error:', error);
    res.status(500).json({ error: 'Failed to remove from watchlist' });
  }
});

// POST /api/watchlist/bulk - Bulk import watchlist items
router.post('/bulk', authenticateUser, async (req, res) => {
  try {
    const { marketIds } = req.body;

    if (!Array.isArray(marketIds) || marketIds.length === 0) {
      return res.status(400).json({ error: 'Market IDs array is required' });
    }

    const watchlistItems = marketIds.map(marketId => ({
      user_id: req.user.id,
      market_id: marketId,
      platform: 'polymarket',
      question: `Market ${marketId}`,
      status: 'active'
    }));

    const { data, error } = await supabase
      .from('watchlist')
      .insert(watchlistItems)
      .select();

    if (error) throw error;

    res.status(201).json({ 
      message: 'Items added to watchlist',
      imported: data.length,
      data 
    });
  } catch (error) {
    console.error('Bulk import error:', error);
    res.status(500).json({ error: 'Failed to bulk import watchlist' });
  }
});

// PUT /api/watchlist/:marketId - Update watchlist item
router.put('/:marketId', authenticateUser, async (req, res) => {
  try {
    const { marketId } = req.params;
    const { platform = 'polymarket', updates } = req.body;

    const { data, error } = await supabase
      .from('watchlist')
      .update(updates)
      .eq('user_id', req.user.id)
      .eq('market_id', marketId)
      .eq('platform', platform)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Update watchlist error:', error);
    res.status(500).json({ error: 'Failed to update watchlist item' });
  }
});

module.exports = router;
