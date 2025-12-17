const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

// Health monitoring state
let systemHealth = {
  status: 'initializing',
  uptime: 0,
  lastRun: null,
  posts: 0,
  marketsMonitored: 0,
  alertsActive: 0,
  startTime: Date.now()
};

// Update health metrics
function updateHealthMetrics(metrics) {
  systemHealth = {
    ...systemHealth,
    ...metrics,
    uptime: Math.floor((Date.now() - systemHealth.startTime) / 1000)
  };
}

// Health check endpoint
app.get('/status', (req, res) => {
  res.json({
    status: systemHealth.status,
    uptime: systemHealth.uptime,
    lastRun: systemHealth.lastRun,
    posts: systemHealth.posts,
    marketsMonitored: systemHealth.marketsMonitored,
    alertsActive: systemHealth.alertsActive,
    timestamp: Date.now(),
    version: '1.1-beta'
  });
});

// Basic metrics endpoint (for monitoring)
app.get('/metrics', (req, res) => {
  res.json({
    uptime_seconds: systemHealth.uptime,
    posts_total: systemHealth.posts,
    markets_monitored: systemHealth.marketsMonitored,
    alerts_active: systemHealth.alertsActive,
    last_run_timestamp: systemHealth.lastRun
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Oracle of Poly',
    version: '1.1-beta',
    status: 'operational',
    description: 'Polymarket intelligence agent with real-time alerts',
    endpoints: {
      health: '/status',
      metrics: '/metrics'
    }
  });
});

// Export functions for external updates
module.exports = {
  app,
  updateHealthMetrics,
  startServer: () => {
    app.listen(PORT, () => {
      console.log(`Oracle of Poly server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/status`);
      systemHealth.status = 'operational';
    });
  }
};

// Start server if run directly
if (require.main === module) {
  module.exports.startServer();
}
