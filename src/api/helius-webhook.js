const express = require('express');
const router = express.Router();

// Helius webhook configuration
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const ZIGMA_TOKEN_MINT = 'xT4tzTkuyXyDqCWeZyahrhnknPd8KBuuNjPngvqcyai';

// In-memory payment tracking (replace with database in production)
const pendingPayments = new Map();
const completedPayments = new Map();

/**
 * POST /api/helius/webhook
 * Helius webhook endpoint for monitoring ZIGMA token transfers
 */
router.post('/webhook', express.json(), async (req, res) => {
  try {
    console.log('[HELIUS WEBHOOK] Received webhook:', JSON.stringify(req.body, null, 2));

    const webhookData = req.body;

    // Validate webhook data
    if (!webhookData || !Array.isArray(webhookData)) {
      console.error('[HELIUS WEBHOOK] Invalid webhook data format');
      return res.status(400).json({ error: 'Invalid webhook data' });
    }

    // Process each transaction in the webhook
    for (const transaction of webhookData) {
      await processTransaction(transaction);
    }

    res.status(200).json({ success: true, message: 'Webhook processed' });
  } catch (error) {
    console.error('[HELIUS WEBHOOK] Error processing webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Process a single transaction from Helius webhook
 */
async function processTransaction(transaction) {
  try {
    const { signature, type, tokenTransfers, timestamp } = transaction;

    // Only process token transfers
    if (type !== 'TRANSFER' || !tokenTransfers || tokenTransfers.length === 0) {
      return;
    }

    // Check if this is a ZIGMA token transfer
    for (const transfer of tokenTransfers) {
      if (transfer.mint === ZIGMA_TOKEN_MINT) {
        const { fromUserAccount, toUserAccount, tokenAmount } = transfer;
        
        console.log('[HELIUS WEBHOOK] ZIGMA transfer detected:', {
          signature,
          from: fromUserAccount,
          to: toUserAccount,
          amount: tokenAmount,
          timestamp
        });

        // Store completed payment
        completedPayments.set(signature, {
          from: fromUserAccount,
          to: toUserAccount,
          amount: tokenAmount,
          timestamp: timestamp || Date.now(),
          processed: true
        });

        // Check if this payment was pending
        const pendingKey = `${toUserAccount}-${tokenAmount}`;
        if (pendingPayments.has(pendingKey)) {
          const pending = pendingPayments.get(pendingKey);
          pending.status = 'completed';
          pending.signature = signature;
          pending.completedAt = Date.now();
          
          console.log('[HELIUS WEBHOOK] Payment completed for:', toUserAccount);
        }
      }
    }
  } catch (error) {
    console.error('[HELIUS WEBHOOK] Error processing transaction:', error);
  }
}

/**
 * GET /api/helius/payment-status/:walletAddress
 * Check payment status for a wallet
 */
router.get('/payment-status/:walletAddress', (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    // Find any pending or completed payments for this wallet
    const pending = [];
    const completed = [];

    pendingPayments.forEach((payment, key) => {
      if (key.startsWith(walletAddress)) {
        pending.push(payment);
      }
    });

    completedPayments.forEach((payment, signature) => {
      if (payment.to === walletAddress) {
        completed.push({ ...payment, signature });
      }
    });

    res.json({
      success: true,
      walletAddress,
      pending,
      completed,
      hasRecentPayment: completed.length > 0
    });
  } catch (error) {
    console.error('[HELIUS WEBHOOK] Error checking payment status:', error);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

/**
 * POST /api/helius/register-payment
 * Register a pending payment expectation
 */
router.post('/register-payment', express.json(), (req, res) => {
  try {
    const { walletAddress, expectedAmount } = req.body;

    if (!walletAddress || !expectedAmount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const key = `${walletAddress}-${expectedAmount}`;
    pendingPayments.set(key, {
      walletAddress,
      expectedAmount,
      status: 'pending',
      registeredAt: Date.now()
    });

    console.log('[HELIUS WEBHOOK] Registered pending payment:', { walletAddress, expectedAmount });

    res.json({
      success: true,
      message: 'Payment expectation registered'
    });
  } catch (error) {
    console.error('[HELIUS WEBHOOK] Error registering payment:', error);
    res.status(500).json({ error: 'Failed to register payment' });
  }
});

module.exports = router;
