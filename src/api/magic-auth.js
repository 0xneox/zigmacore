const express = require('express');
const { Magic } = require('@magic-sdk/admin');
const router = express.Router();

// Initialize Magic Admin SDK with secret key
const magic = new Magic(process.env.MAGIC_SECRET_KEY || 'sk_live_8EE99E3C64B862F9');

/**
 * Middleware to verify Magic.link token
 */
async function verifyMagicToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'No authentication token provided' 
      });
    }

    const didToken = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    // Validate the DID token with Magic
    magic.token.validate(didToken);
    
    // Get user metadata from the token
    const metadata = await magic.users.getMetadataByToken(didToken);
    
    // Attach user info to request
    req.user = {
      email: metadata.email,
      publicAddress: metadata.publicAddress,
      issuer: metadata.issuer,
    };
    
    next();
  } catch (error) {
    console.error('[MAGIC AUTH] Token verification failed:', error);
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Invalid or expired authentication token' 
    });
  }
}

/**
 * POST /api/auth/magic/verify
 * Verify Magic.link DID token and return user info
 */
router.post('/verify', async (req, res) => {
  try {
    const { didToken } = req.body;
    
    if (!didToken) {
      return res.status(400).json({ 
        error: 'Bad Request',
        message: 'DID token is required' 
      });
    }

    // Validate the DID token
    magic.token.validate(didToken);
    
    // Get user metadata
    const metadata = await magic.users.getMetadataByToken(didToken);
    
    res.json({
      success: true,
      user: {
        email: metadata.email,
        publicAddress: metadata.publicAddress,
        issuer: metadata.issuer,
      }
    });
  } catch (error) {
    console.error('[MAGIC AUTH] Verification error:', error);
    res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Token verification failed' 
    });
  }
});

/**
 * POST /api/auth/magic/logout
 * Logout user by invalidating their session
 */
router.post('/logout', verifyMagicToken, async (req, res) => {
  try {
    // Magic.link handles session management client-side
    // This endpoint is mainly for logging/cleanup
    console.log('[MAGIC AUTH] User logged out:', req.user.email);
    
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('[MAGIC AUTH] Logout error:', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      message: 'Logout failed' 
    });
  }
});

module.exports = { router, verifyMagicToken };
