// Cron job to check for resolved markets every hour
const cron = require('node-cron');
const { checkPendingResolutions } = require('./resolution-monitor');

function startResolutionMonitoring() {
  // Check for resolutions every hour
  cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Starting resolution check...');
    try {
      const resolutions = await checkPendingResolutions();
      if (resolutions.length > 0) {
        console.log(`[CRON] ✅ Found ${resolutions.length} new resolutions`);
      } else {
        console.log('[CRON] No new resolutions');
      }
    } catch (error) {
      console.error('[CRON] Resolution check failed:', error.message);
    }
  });
  
  console.log('[CRON] ✅ Resolution monitoring started (runs every hour)');
  
  // Run immediately on startup
  setTimeout(async () => {
    console.log('[STARTUP] Running initial resolution check...');
    try {
      await checkPendingResolutions();
    } catch (error) {
      console.error('[STARTUP] Initial resolution check failed:', error.message);
    }
  }, 5000); // Wait 5 seconds after startup
}

module.exports = { startResolutionMonitoring };
