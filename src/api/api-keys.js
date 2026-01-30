/**
 * API Key Management Endpoints
 * Generate and manage API keys for OpenClaw integration
 */

const express = require('express');
const router = express.Router();
const { generateApiKey, validateApiKey } = require('../middleware/auth');
const crypto = require('crypto');

// In-memory API key storage (in production, use database)
const API_KEY_STORE = new Map();

/**
 * Generate a new API key
 * POST /api/keys/generate
 */
router.post('/generate', async (req, res) => {
  try {
    const { userId, tier, email, description } = req.body;

    if (!userId) {
      return res.status(400).json({
        error: 'Missing required field',
        message: 'userId is required'
      });
    }

    // Generate API key
    const apiKey = generateApiKey(userId, tier || 'FREE');

    // Store additional metadata
    API_KEY_STORE.set(apiKey, {
      userId,
      tier: tier || 'FREE',
      email: email || null,
      description: description || 'OpenClaw Integration',
      createdAt: Date.now(),
      lastUsed: null,
      requestCount: 0
    });

    console.log(`[API KEYS] Generated new key for user ${userId} (${tier || 'FREE'})`);

    res.json({
      success: true,
      apiKey,
      userId,
      tier: tier || 'FREE',
      createdAt: new Date().toISOString(),
      message: 'API key generated successfully. Store this securely - it cannot be retrieved again.'
    });
  } catch (error) {
    console.error('[API KEYS] Error generating key:', error);
    res.status(500).json({
      error: 'Failed to generate API key',
      message: error.message
    });
  }
});

/**
 * Validate an API key
 * POST /api/keys/validate
 */
router.post('/validate', async (req, res) => {
  try {
    const { apiKey } = req.body;

    if (!apiKey) {
      return res.status(400).json({
        error: 'Missing API key',
        message: 'apiKey is required'
      });
    }

    const keyData = validateApiKey(apiKey);

    if (!keyData) {
      return res.status(401).json({
        valid: false,
        message: 'Invalid API key'
      });
    }

    res.json({
      valid: true,
      userId: keyData.userId,
      tier: keyData.tier,
      createdAt: new Date(keyData.createdAt).toISOString(),
      lastUsed: keyData.lastUsed ? new Date(keyData.lastUsed).toISOString() : null
    });
  } catch (error) {
    console.error('[API KEYS] Error validating key:', error);
    res.status(500).json({
      error: 'Failed to validate API key',
      message: error.message
    });
  }
});

/**
 * Revoke an API key
 * DELETE /api/keys/revoke
 */
router.delete('/revoke', async (req, res) => {
  try {
    const { apiKey } = req.body;

    if (!apiKey) {
      return res.status(400).json({
        error: 'Missing API key',
        message: 'apiKey is required'
      });
    }

    const keyData = API_KEY_STORE.get(apiKey);
    
    if (!keyData) {
      return res.status(404).json({
        error: 'API key not found',
        message: 'This API key does not exist or has already been revoked'
      });
    }

    API_KEY_STORE.delete(apiKey);

    console.log(`[API KEYS] Revoked key for user ${keyData.userId}`);

    res.json({
      success: true,
      message: 'API key revoked successfully',
      userId: keyData.userId
    });
  } catch (error) {
    console.error('[API KEYS] Error revoking key:', error);
    res.status(500).json({
      error: 'Failed to revoke API key',
      message: error.message
    });
  }
});

/**
 * List API keys for a user
 * GET /api/keys/list/:userId
 */
router.get('/list/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const userKeys = Array.from(API_KEY_STORE.entries())
      .filter(([_, data]) => data.userId === userId)
      .map(([key, data]) => ({
        apiKey: `${key.substring(0, 12)}...${key.substring(key.length - 4)}`, // Masked
        tier: data.tier,
        description: data.description,
        createdAt: new Date(data.createdAt).toISOString(),
        lastUsed: data.lastUsed ? new Date(data.lastUsed).toISOString() : null,
        requestCount: data.requestCount
      }));

    res.json({
      userId,
      keys: userKeys,
      total: userKeys.length
    });
  } catch (error) {
    console.error('[API KEYS] Error listing keys:', error);
    res.status(500).json({
      error: 'Failed to list API keys',
      message: error.message
    });
  }
});

/**
 * Get API key usage statistics
 * GET /api/keys/stats/:apiKey
 */
router.get('/stats/:apiKey', async (req, res) => {
  try {
    const { apiKey } = req.params;

    const keyData = API_KEY_STORE.get(apiKey);

    if (!keyData) {
      return res.status(404).json({
        error: 'API key not found',
        message: 'This API key does not exist'
      });
    }

    res.json({
      userId: keyData.userId,
      tier: keyData.tier,
      requestCount: keyData.requestCount,
      createdAt: new Date(keyData.createdAt).toISOString(),
      lastUsed: keyData.lastUsed ? new Date(keyData.lastUsed).toISOString() : null,
      description: keyData.description
    });
  } catch (error) {
    console.error('[API KEYS] Error fetching stats:', error);
    res.status(500).json({
      error: 'Failed to fetch API key stats',
      message: error.message
    });
  }
});

module.exports = router;
