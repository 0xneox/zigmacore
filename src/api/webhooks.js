/**
 * Webhook System for Proactive Alerts
 * Sends notifications to OpenClaw users when signals meet criteria
 */

const express = require('express');
const router = express.Router();

// Webhook subscriptions store
// Format: { userId: { webhookUrl, filters, createdAt } }
const WEBHOOK_SUBSCRIPTIONS = new Map();

// Alert queue for batch processing
const ALERT_QUEUE = [];

/**
 * Register a webhook for proactive alerts
 * POST /api/webhooks/subscribe
 */
router.post('/subscribe', async (req, res) => {
  try {
    const { userId, webhookUrl, filters } = req.body;

    if (!userId || !webhookUrl) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'userId and webhookUrl are required'
      });
    }

    // Validate webhook URL
    try {
      new URL(webhookUrl);
    } catch {
      return res.status(400).json({
        error: 'Invalid webhook URL',
        message: 'Please provide a valid HTTPS URL'
      });
    }

    // Store subscription
    WEBHOOK_SUBSCRIPTIONS.set(userId, {
      webhookUrl,
      filters: filters || {
        minEdge: 0.05, // 5% minimum edge
        minConfidence: 0.70, // 70% minimum confidence
        tiers: ['STRONG_TRADE', 'SMALL_TRADE']
      },
      createdAt: Date.now(),
      lastTriggered: null
    });

    console.log(`[WEBHOOK] Registered webhook for user ${userId}`);

    res.json({
      success: true,
      message: 'Webhook registered successfully',
      subscription: {
        userId,
        filters: WEBHOOK_SUBSCRIPTIONS.get(userId).filters
      }
    });
  } catch (error) {
    console.error('[WEBHOOK] Error registering webhook:', error);
    res.status(500).json({
      error: 'Failed to register webhook',
      message: error.message
    });
  }
});

/**
 * Unregister a webhook
 * DELETE /api/webhooks/unsubscribe/:userId
 */
router.delete('/unsubscribe/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!WEBHOOK_SUBSCRIPTIONS.has(userId)) {
      return res.status(404).json({
        error: 'Subscription not found',
        message: 'No webhook registered for this user'
      });
    }

    WEBHOOK_SUBSCRIPTIONS.delete(userId);

    res.json({
      success: true,
      message: 'Webhook unregistered successfully'
    });
  } catch (error) {
    console.error('[WEBHOOK] Error unregistering webhook:', error);
    res.status(500).json({
      error: 'Failed to unregister webhook',
      message: error.message
    });
  }
});

/**
 * Get webhook subscription status
 * GET /api/webhooks/status/:userId
 */
router.get('/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!WEBHOOK_SUBSCRIPTIONS.has(userId)) {
      return res.json({
        subscribed: false,
        message: 'No active webhook subscription'
      });
    }

    const subscription = WEBHOOK_SUBSCRIPTIONS.get(userId);

    res.json({
      subscribed: true,
      filters: subscription.filters,
      createdAt: new Date(subscription.createdAt).toISOString(),
      lastTriggered: subscription.lastTriggered 
        ? new Date(subscription.lastTriggered).toISOString() 
        : null
    });
  } catch (error) {
    console.error('[WEBHOOK] Error checking status:', error);
    res.status(500).json({
      error: 'Failed to check status',
      message: error.message
    });
  }
});

/**
 * Send webhook notification
 * @param {string} userId - User ID
 * @param {object} payload - Notification payload
 */
async function sendWebhook(userId, payload) {
  const subscription = WEBHOOK_SUBSCRIPTIONS.get(userId);
  if (!subscription) return;

  try {
    const response = await fetch(subscription.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zigma-Event': 'signal.alert',
        'X-Zigma-User': userId
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error(`[WEBHOOK] Failed to send to ${userId}: ${response.status}`);
    } else {
      subscription.lastTriggered = Date.now();
      WEBHOOK_SUBSCRIPTIONS.set(userId, subscription);
      console.log(`[WEBHOOK] Sent alert to ${userId}`);
    }
  } catch (error) {
    console.error(`[WEBHOOK] Error sending to ${userId}:`, error.message);
  }
}

/**
 * Process signals and trigger webhooks
 * Called by main cycle when new signals are generated
 * @param {Array} signals - Array of trading signals
 */
async function processSignalsForWebhooks(signals) {
  if (!signals || signals.length === 0) return;

  const notifications = [];

  // Check each subscription
  for (const [userId, subscription] of WEBHOOK_SUBSCRIPTIONS.entries()) {
    const { filters } = subscription;

    // Filter signals based on user preferences
    const matchingSignals = signals.filter(signal => {
      // Check edge threshold
      if (signal.effectiveEdge < filters.minEdge) return false;

      // Check confidence threshold
      if (signal.confidence < filters.minConfidence) return false;

      // Check tier filter
      if (filters.tiers && !filters.tiers.includes(signal.tier)) return false;

      return true;
    });

    if (matchingSignals.length > 0) {
      notifications.push({
        userId,
        signals: matchingSignals.slice(0, 3) // Top 3 signals
      });
    }
  }

  // Send notifications
  for (const notification of notifications) {
    await sendWebhook(notification.userId, {
      event: 'signal.alert',
      timestamp: new Date().toISOString(),
      signals: notification.signals.map(s => ({
        marketId: s.marketId || s.id,
        question: s.question,
        action: s.action === 'YES' ? 'BUY YES' : s.action === 'NO' ? 'BUY NO' : 'HOLD',
        edge: s.effectiveEdge,
        confidence: s.confidence,
        tier: s.tier,
        kelly: s.kelly,
        reasoning: s.rationale
      }))
    });
  }

  if (notifications.length > 0) {
    console.log(`[WEBHOOK] Sent ${notifications.length} alert notifications`);
  }
}

/**
 * Get all active subscriptions (admin only)
 * GET /api/webhooks/subscriptions
 */
router.get('/subscriptions', async (req, res) => {
  try {
    const subscriptions = Array.from(WEBHOOK_SUBSCRIPTIONS.entries()).map(([userId, data]) => ({
      userId,
      createdAt: new Date(data.createdAt).toISOString(),
      lastTriggered: data.lastTriggered ? new Date(data.lastTriggered).toISOString() : null,
      filters: data.filters
    }));

    res.json({
      total: subscriptions.length,
      subscriptions
    });
  } catch (error) {
    console.error('[WEBHOOK] Error listing subscriptions:', error);
    res.status(500).json({
      error: 'Failed to list subscriptions',
      message: error.message
    });
  }
});

module.exports = {
  router,
  sendWebhook,
  processSignalsForWebhooks,
  WEBHOOK_SUBSCRIPTIONS
};
