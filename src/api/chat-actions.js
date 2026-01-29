const express = require('express');
const { verifyMagicToken } = require('./magic-auth');
const router = express.Router();
const crypto = require('crypto');

// In-memory storage (replace with database in production)
const savedAnalyses = new Map();
const trackedMarkets = new Map();
const marketAlerts = new Map();
const sharedAnalyses = new Map();

/**
 * POST /api/chat/actions/save
 * Save analysis to user's watchlist
 */
router.post('/save', verifyMagicToken, async (req, res) => {
  try {
    const { marketId, marketQuestion, analysis, recommendation, content } = req.body;
    const userId = req.user.email;

    if (!marketId || !content) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'marketId and content are required'
      });
    }

    const analysisId = crypto.randomUUID();
    const savedAnalysis = {
      id: analysisId,
      userId,
      marketId,
      marketQuestion,
      analysis,
      recommendation,
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Store in memory (replace with database)
    if (!savedAnalyses.has(userId)) {
      savedAnalyses.set(userId, []);
    }
    savedAnalyses.get(userId).push(savedAnalysis);

    console.log(`[CHAT ACTIONS] Analysis saved: ${analysisId} for user ${userId}`);

    res.json({
      success: true,
      message: 'Analysis saved successfully',
      analysisId,
      savedAnalysis
    });
  } catch (error) {
    console.error('[CHAT ACTIONS] Save error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to save analysis'
    });
  }
});

/**
 * GET /api/chat/actions/saved
 * Get user's saved analyses
 */
router.get('/saved', verifyMagicToken, async (req, res) => {
  try {
    const userId = req.user.email;
    const userAnalyses = savedAnalyses.get(userId) || [];

    res.json({
      success: true,
      count: userAnalyses.length,
      analyses: userAnalyses
    });
  } catch (error) {
    console.error('[CHAT ACTIONS] Get saved error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch saved analyses'
    });
  }
});

/**
 * DELETE /api/chat/actions/saved/:id
 * Delete saved analysis
 */
router.delete('/saved/:id', verifyMagicToken, async (req, res) => {
  try {
    const userId = req.user.email;
    const analysisId = req.params.id;
    const userAnalyses = savedAnalyses.get(userId) || [];
    
    const index = userAnalyses.findIndex(a => a.id === analysisId);
    if (index === -1) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Analysis not found'
      });
    }

    userAnalyses.splice(index, 1);
    savedAnalyses.set(userId, userAnalyses);

    res.json({
      success: true,
      message: 'Analysis deleted successfully'
    });
  } catch (error) {
    console.error('[CHAT ACTIONS] Delete error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete analysis'
    });
  }
});

/**
 * POST /api/chat/actions/track
 * Add market to tracking list
 */
router.post('/track', verifyMagicToken, async (req, res) => {
  try {
    const { marketId, marketQuestion, initialOdds, targetOdds, stopLoss, notes } = req.body;
    const userId = req.user.email;

    if (!marketId) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'marketId is required'
      });
    }

    const trackId = crypto.randomUUID();
    const trackedMarket = {
      id: trackId,
      userId,
      marketId,
      marketQuestion,
      initialOdds: initialOdds || null,
      currentOdds: initialOdds || null,
      targetOdds: targetOdds || null,
      stopLoss: stopLoss || null,
      notes: notes || '',
      createdAt: new Date().toISOString(),
      lastChecked: new Date().toISOString()
    };

    if (!trackedMarkets.has(userId)) {
      trackedMarkets.set(userId, []);
    }
    trackedMarkets.get(userId).push(trackedMarket);

    console.log(`[CHAT ACTIONS] Market tracked: ${trackId} for user ${userId}`);

    res.json({
      success: true,
      message: 'Market added to tracker',
      trackId,
      trackedMarket
    });
  } catch (error) {
    console.error('[CHAT ACTIONS] Track error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to track market'
    });
  }
});

/**
 * GET /api/chat/actions/tracked
 * Get user's tracked markets
 */
router.get('/tracked', verifyMagicToken, async (req, res) => {
  try {
    const userId = req.user.email;
    const userTracked = trackedMarkets.get(userId) || [];

    res.json({
      success: true,
      count: userTracked.length,
      markets: userTracked
    });
  } catch (error) {
    console.error('[CHAT ACTIONS] Get tracked error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch tracked markets'
    });
  }
});

/**
 * DELETE /api/chat/actions/tracked/:id
 * Remove market from tracking
 */
router.delete('/tracked/:id', verifyMagicToken, async (req, res) => {
  try {
    const userId = req.user.email;
    const trackId = req.params.id;
    const userTracked = trackedMarkets.get(userId) || [];
    
    const index = userTracked.findIndex(t => t.id === trackId);
    if (index === -1) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tracked market not found'
      });
    }

    userTracked.splice(index, 1);
    trackedMarkets.set(userId, userTracked);

    res.json({
      success: true,
      message: 'Market removed from tracker'
    });
  } catch (error) {
    console.error('[CHAT ACTIONS] Delete tracked error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to remove tracked market'
    });
  }
});

/**
 * POST /api/chat/actions/alert
 * Create price/odds alert
 */
router.post('/alert', verifyMagicToken, async (req, res) => {
  try {
    const { marketId, marketQuestion, alertType, threshold, message } = req.body;
    const userId = req.user.email;

    if (!marketId || !alertType || threshold === undefined) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'marketId, alertType, and threshold are required'
      });
    }

    const alertId = crypto.randomUUID();
    const alert = {
      id: alertId,
      userId,
      marketId,
      marketQuestion,
      alertType, // 'price_above', 'price_below', 'edge_threshold', 'volume_spike'
      threshold,
      message: message || '',
      triggered: false,
      createdAt: new Date().toISOString()
    };

    if (!marketAlerts.has(userId)) {
      marketAlerts.set(userId, []);
    }
    marketAlerts.get(userId).push(alert);

    console.log(`[CHAT ACTIONS] Alert created: ${alertId} for user ${userId}`);

    res.json({
      success: true,
      message: 'Alert created successfully',
      alertId,
      alert
    });
  } catch (error) {
    console.error('[CHAT ACTIONS] Alert error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create alert'
    });
  }
});

/**
 * GET /api/chat/actions/alerts
 * Get user's alerts
 */
router.get('/alerts', verifyMagicToken, async (req, res) => {
  try {
    const userId = req.user.email;
    const userAlerts = marketAlerts.get(userId) || [];

    res.json({
      success: true,
      count: userAlerts.length,
      alerts: userAlerts
    });
  } catch (error) {
    console.error('[CHAT ACTIONS] Get alerts error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch alerts'
    });
  }
});

/**
 * DELETE /api/chat/actions/alerts/:id
 * Delete alert
 */
router.delete('/alerts/:id', verifyMagicToken, async (req, res) => {
  try {
    const userId = req.user.email;
    const alertId = req.params.id;
    const userAlerts = marketAlerts.get(userId) || [];
    
    const index = userAlerts.findIndex(a => a.id === alertId);
    if (index === -1) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Alert not found'
      });
    }

    userAlerts.splice(index, 1);
    marketAlerts.set(userId, userAlerts);

    res.json({
      success: true,
      message: 'Alert deleted successfully'
    });
  } catch (error) {
    console.error('[CHAT ACTIONS] Delete alert error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete alert'
    });
  }
});

/**
 * POST /api/chat/actions/share
 * Generate shareable link for analysis
 */
router.post('/share', verifyMagicToken, async (req, res) => {
  try {
    const { analysisId, content, recommendation, market } = req.body;
    const userId = req.user.email;

    if (!content) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'content is required'
      });
    }

    const shareToken = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const sharedAnalysis = {
      shareToken,
      analysisId,
      userId,
      content,
      recommendation,
      market,
      viewCount: 0,
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date().toISOString()
    };

    sharedAnalyses.set(shareToken, sharedAnalysis);

    const shareUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/shared/${shareToken}`;

    console.log(`[CHAT ACTIONS] Analysis shared: ${shareToken} by user ${userId}`);

    res.json({
      success: true,
      message: 'Share link generated',
      shareToken,
      shareUrl,
      expiresAt: expiresAt.toISOString()
    });
  } catch (error) {
    console.error('[CHAT ACTIONS] Share error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to generate share link'
    });
  }
});

/**
 * GET /api/chat/actions/share/:token
 * Get shared analysis (public, no auth required)
 */
router.get('/share/:token', async (req, res) => {
  try {
    const shareToken = req.params.token;
    const shared = sharedAnalyses.get(shareToken);

    if (!shared) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Shared analysis not found or expired'
      });
    }

    // Check expiration
    if (new Date(shared.expiresAt) < new Date()) {
      sharedAnalyses.delete(shareToken);
      return res.status(410).json({
        error: 'Gone',
        message: 'Shared analysis has expired'
      });
    }

    // Increment view count
    shared.viewCount++;

    res.json({
      success: true,
      content: shared.content,
      recommendation: shared.recommendation,
      market: shared.market,
      viewCount: shared.viewCount,
      createdAt: shared.createdAt
    });
  } catch (error) {
    console.error('[CHAT ACTIONS] Get shared error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch shared analysis'
    });
  }
});

module.exports = { router };
