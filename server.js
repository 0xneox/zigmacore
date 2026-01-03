const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;
const path = require('path');
const fs = require('fs');

// Middleware
app.use(express.json());

// Auth middleware (skipped for testing)
app.use((req, res, next) => {
  // const apiKey = req.headers['x-api-key'];
  // if (process.env.API_KEY && (!apiKey || apiKey !== process.env.API_KEY)) {
  //   return res.status(401).json({ error: 'Unauthorized' });
  // }
  next();
});

// CORS headers
const allowedOrigins = ['https://zigma.pro', 'https://www.zigma.pro', 'http://localhost:8080', 'http://localhost:5173'];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') res.sendStatus(200);
  else next();
});

// Import agent functions
const { fetchMarkets } = require('./src/fetcher');
const { generateEnhancedAnalysis } = require('./src/llm');
const { loadCache } = require('./src/db');

// Simple string similarity function
function calculateSimilarity(query, text) {
  const queryWords = query.toLowerCase().split(/\s+/);
  const textWords = text.toLowerCase().split(/\s+/);
  
  const commonWords = queryWords.filter(word => textWords.includes(word));
  return commonWords.length / Math.max(queryWords.length, 1);
}

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

// Latest cycle data for UI
global.latestData = {
  cycleSummary: null,
  liveSignals: [],
  marketOutlook: [],
  rejectedSignals: [],
  volumeSpikes: [],
  lastRun: null,
  marketsMonitored: 0,
  posts: 0
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

// Data endpoint for UI (structured cycle data)
app.get('/data', (req, res) => {
  res.json(global.latestData);
});

// Logs endpoint for UI (sanitized for public display)
app.get('/logs', (req, res) => {
  try {
    const logPath = 'console_output.log';
    const stats = fs.statSync(logPath);
    if (stats.size > 10 * 1024 * 1024) { // 10MB
      const oldPath = path.join(__dirname, 'console_output.log.old');
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      fs.renameSync(logPath, oldPath);
      fs.writeFileSync(logPath, ''); // Create new empty log
    }
    const rawLogs = fs.readFileSync(logPath, 'utf8');

    // Sanitize logs for public display
    const sanitizedLogs = rawLogs
      .split('\n')
      .filter(line => {
        // Remove lines containing sensitive information
        if (line.toLowerCase().includes('api_key')) return false;
        if (line.toLowerCase().includes('password')) return false;
        if (line.toLowerCase().includes('secret')) return false;
        if (line.toLowerCase().includes('token')) return false;
        if (line.toLowerCase().includes('key')) return false;
        if (line.toLowerCase().includes('auth')) return false;
        if (line.toLowerCase().includes('error') && line.toLowerCase().includes('internal')) return false;

        // Allow CYCLE_SUMMARY lines even if they contain filtered words
        if (line.includes('CYCLE_SUMMARY::')) return true;

        // Remove debug details and calculation logs
        // if (line.includes('DEBUG:')) return false; // Temporarily allow for UI parsing
        if (line.includes('Using cached LLM response')) return false;
        if (line.includes('Probability chain:')) return false;
        if (line.includes('Survivability test:')) return false;
        if (line.includes('Fetched new Tavily results')) return false;
        if (line.includes('Using cached Tavily results')) return false;
        if (line.includes('Cached new LLM response')) return false;
        if (line.includes('🌐 FETCH:')) return false;
        // if (line.includes('✅ Fetched')) return false;
        if (line.includes('📊 After sanity filter:')) return false;
        if (line.includes('💰')) return false;
        if (line.includes('[CACHE]')) return false;
        // if (line.includes('[LLM] Analyzing:')) return false; // Allow for UI parsing

        // Allow certain lines
        if (line.includes('DEBUG:')) return true;
        if (line.includes('Effective Edge:')) return true;
        if (line.includes('Headlines found:')) return true;
        if (line.includes('NEWS for')) return true;
        if (line.includes(' VOLUME SPIKE DETECTED:')) return true;
        if (line.includes('🚀 VOLUME SPIKE DETECTED:')) return true;
        if (line.includes('[LLM] Analyzing:')) return true; // Allow for UI parsing

        return true;
      })
      .join('\n');

    res.json({ logs: sanitizedLogs.split('\n').slice(-5000).join('\n') });
  } catch (error) {
    console.error('Error reading logs:', error);
    res.status(500).json({ error: 'Failed to read logs', message: error.message });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Agent Zigma',
    version: '1.1-beta',
    status: 'operational',
    description: 'Polymarket intelligence agent with real-time alerts',
    endpoints: {
      health: '/status',
      metrics: '/metrics',
      chat: '/chat'
    }
  });
});

// Chat endpoint for natural language queries
app.post('/chat', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid query parameter' });
    }

    // Fetch recent markets
    const markets = await fetchMarkets(1000);
    
    // Find best market match by question similarity
    let bestMatch = null;
    let bestScore = 0;
    
    for (const market of markets) {
      const question = market.question || '';
      const score = calculateSimilarity(query.toLowerCase(), question.toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        bestMatch = market;
      }
    }
    
    if (!bestMatch || bestScore < 0.3) { // Minimum similarity threshold
      return res.status(404).json({ 
        error: 'No matching market found', 
        query: query,
        suggestion: 'Try more specific market terms like "US election" or "bitcoin price"'
      });
    }
    
    // Load cache
    const cache = loadCache();
    
    // Generate enhanced analysis
    const analysis = await generateEnhancedAnalysis(bestMatch, cache);
    
    res.json({
      query: query,
      matchedMarket: {
        id: bestMatch.id,
        question: bestMatch.question,
        similarity: bestScore
      },
      analysis: analysis,
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('Chat endpoint error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Export functions for external updates
module.exports = {
  app,
  updateHealthMetrics,
  startServer: () => {
    app.listen(PORT, () => {
      console.log(`Agent Zigma server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/status`);
      systemHealth.status = 'operational';
    });
  }
};

// Start server if run directly
if (require.main === module) {
  require('./src/index.js');
  module.exports.startServer();
}
