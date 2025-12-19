const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;
const path = require('path');
const fs = require('fs');

// Middleware
app.use(express.json());

// CORS headers
const allowedOrigins = ['https://zigma.pro', 'https://www.zigma.pro', 'http://localhost:8080'];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

// Logs endpoint for UI (sanitized for public display)
app.get('/logs', (req, res) => {
  try {
    const logPath = path.join(__dirname, 'console_output.log');
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

        // Remove debug details and calculation logs
        if (line.includes('DEBUG:')) return false;
        if (line.includes('Using cached LLM response')) return false;
        if (line.includes('Probability chain:')) return false;
        if (line.includes('Effective Edge:')) return false;
        if (line.includes('Survivability test:')) return false;
        if (line.includes('SAFE_MODE:')) return false;
        if (line.includes('Fetched new Tavily results')) return false;
        if (line.includes('Using cached Tavily results')) return false;
        if (line.includes('Headlines found:')) return false;
        if (line.includes('NEWS for')) return false;
        if (line.includes('Cached new LLM response')) return false;
        if (line.includes('🌐 FETCH:')) return false;
        if (line.includes('✅ Fetched')) return false;
        if (line.includes('📊 After sanity filter:')) return false;
        if (line.includes('💰')) return false;
        if (line.includes('[CACHE]')) return false;
        if (line.includes('[LLM] Analyzing:')) return false;

        return true;
      })
      .slice(-50) // Show last 50 lines of essential info
      .join('\n');

    res.json({ logs: sanitizedLogs });
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
  module.exports.startServer();
}
