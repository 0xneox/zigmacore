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

// GET /api/signals - Get user's signals
router.get('/', authenticateUser, async (req, res) => {
  try {
    const { limit = 50, status } = req.query;
    
    let query = supabase
      .from('user_signals')
      .select('*')
      .eq('user_id', req.user.id)
      .order('generated_at', { ascending: false })
      .limit(parseInt(limit));

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Get signals error:', error);
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

// GET /api/signals/performance - Get user's signal performance metrics
router.get('/performance', authenticateUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .rpc('get_user_signal_performance', { p_user_id: req.user.id });

    if (error) throw error;

    res.json(data[0] || {});
  } catch (error) {
    console.error('Get performance error:', error);
    res.status(500).json({ error: 'Failed to fetch performance metrics' });
  }
});

// POST /api/signals - Create a new signal (for system use)
router.post('/', authenticateUser, async (req, res) => {
  try {
    const signalData = req.body;
    
    const { data, error } = await supabase
      .from('user_signals')
      .insert({ ...signalData, user_id: req.user.id })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (error) {
    console.error('Create signal error:', error);
    res.status(500).json({ error: 'Failed to create signal' });
  }
});

// PUT /api/signals/:signalId - Update signal (e.g., mark as executed)
router.put('/:signalId', authenticateUser, async (req, res) => {
  try {
    const { signalId } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from('user_signals')
      .update(updates)
      .eq('id', signalId)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Update signal error:', error);
    res.status(500).json({ error: 'Failed to update signal' });
  }
});

// GET /api/signals/watchlist/:watchlistId - Get signals for specific watchlist item
router.get('/watchlist/:watchlistId', authenticateUser, async (req, res) => {
  try {
    const { watchlistId } = req.params;
    const { limit = 10 } = req.query;

    const { data, error } = await supabase
      .from('user_signals')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('watchlist_item_id', watchlistId)
      .order('generated_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Get watchlist signals error:', error);
    res.status(500).json({ error: 'Failed to fetch watchlist signals' });
  }
});

// POST /api/signals/generate - Generate signals for user's watchlist (system endpoint)
router.post('/generate', authenticateUser, async (req, res) => {
  try {
    // This would typically be called by a background job
    // For now, it's a placeholder for signal generation logic
    
    const { data, error } = await supabase
      .from('watchlist')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('status', 'active');

    if (error) throw error;

    // Here you would integrate with your signal generation system
    // For now, return a success response
    res.json({ 
      message: 'Signal generation initiated',
      watchlist_items: data.length 
    });
  } catch (error) {
    console.error('Generate signals error:', error);
    res.status(500).json({ error: 'Failed to generate signals' });
  }
});

module.exports = router;
