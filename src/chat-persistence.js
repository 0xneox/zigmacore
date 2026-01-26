/**
 * Chat Persistence Service for Backend
 * Handles saving chat interactions to Supabase database
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Supabase credentials not found. Chat persistence disabled.');
}

// Create Supabase client with service role key for backend operations
const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

/**
 * Save chat message to database
 */
async function saveChatMessage(data) {
  if (!supabase) {
    console.log('Chat persistence disabled - skipping save');
    return null;
  }

  try {
    const messageData = {
      user_id: data.userId,
      session_id: data.sessionId || generateSessionId(),
      message_type: data.messageType,
      content: data.content,
      query_type: data.queryType,
      market_id: data.marketId,
      market_question: data.marketQuestion,
      polymarket_user: data.polymarketUser,
      response_type: data.responseType,
      recommendation_data: data.recommendationData,
      analysis_data: data.analysisData,
      user_profile_data: data.userProfileData,
      comparison_data: data.comparisonData,
      processing_time_ms: data.processingTimeMs,
      context_used: data.contextUsed,
      context_id: data.contextId,
      metadata: data.metadata,
      api_version: 'v1',
      client_info: data.clientInfo,
      ip_address: data.ipAddress
    };

    const { data: saved, error } = await supabase
      .from('user_chat_history')
      .insert(messageData)
      .select()
      .single();

    if (error) {
      console.error('Failed to save chat message:', error);
      return null;
    }

    console.log(`[CHAT_PERSISTENCE] Saved ${data.messageType} for user ${data.userId}`);
    return saved;
  } catch (error) {
    console.error('Error saving chat message:', error);
    return null;
  }
}

/**
 * Save complete chat exchange (user query + response)
 */
async function saveChatExchange(userQuery, response, metadata = {}) {
  if (!supabase) return { userMessage: null, responseMessage: null };

  try {
    const sessionId = metadata.sessionId || generateSessionId();
    const timestamp = new Date().toISOString();

    // Save user query
    const userMessage = await saveChatMessage({
      userId: metadata.userId,
      sessionId,
      messageType: 'user_query',
      content: userQuery,
      queryType: determineQueryType(userQuery, metadata),
      marketId: metadata.marketId,
      marketQuestion: metadata.marketQuestion,
      polymarketUser: metadata.polymarketUser,
      contextId: metadata.contextId,
      processingTimeMs: metadata.processingTimeMs,
      metadata: {
        ...metadata.metadata,
        timestamp,
        source: 'backend_api'
      },
      clientInfo: metadata.clientInfo,
      ipAddress: metadata.ipAddress
    });

    // Save response
    const responseMessage = await saveChatMessage({
      userId: metadata.userId,
      sessionId,
      messageType: 'zigma_response',
      content: response.content,
      responseType: determineResponseType(response),
      recommendationData: response.recommendation,
      analysisData: response.analysis,
      userProfileData: response.userProfile,
      comparisonData: response.comparisonData,
      marketId: metadata.matchedMarket?.id,
      marketQuestion: metadata.matchedMarket?.question,
      contextId: metadata.contextId,
      contextUsed: !!metadata.contextId,
      processingTimeMs: metadata.processingTimeMs,
      metadata: {
        ...metadata.metadata,
        timestamp,
        source: 'backend_api',
        userQuery,
        matchedMarketId: metadata.matchedMarket?.id,
        responseLength: response.content?.length || 0
      },
      clientInfo: metadata.clientInfo,
      ipAddress: metadata.ipAddress
    });

    return { userMessage, responseMessage };
  } catch (error) {
    console.error('Error saving chat exchange:', error);
    return { userMessage: null, responseMessage: null };
  }
}

/**
 * Save error message
 */
async function saveErrorMessage(error, metadata = {}) {
  if (!supabase) return null;

  try {
    return await saveChatMessage({
      userId: metadata.userId,
      sessionId: metadata.sessionId || generateSessionId(),
      messageType: 'error_message',
      content: error,
      responseType: 'error',
      contextId: metadata.contextId,
      processingTimeMs: metadata.processingTimeMs,
      metadata: {
        ...metadata.metadata,
        errorType: 'api_error',
        timestamp: new Date().toISOString(),
        source: 'backend_api'
      },
      clientInfo: metadata.clientInfo,
      ipAddress: metadata.ipAddress
    });
  } catch (error) {
    console.error('Error saving error message:', error);
    return null;
  }
}

/**
 * Get user chat analytics
 */
async function getUserChatAnalytics(userId, startDate, endDate) {
  if (!supabase) return null;

  try {
    let query = supabase
      .from('user_chat_analytics')
      .select('*')
      .eq('user_id', userId);

    if (startDate) {
      query = query.gte('chat_date', startDate);
    }
    if (endDate) {
      query = query.lte('chat_date', endDate);
    }

    const { data, error } = await query.order('chat_date', { ascending: false });

    if (error) {
      console.error('Failed to get chat analytics:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Error getting chat analytics:', error);
    return null;
  }
}

/**
 * Get user chat summary
 */
async function getUserChatSummary(userId) {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('user_chat_summary')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Failed to get chat summary:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Error getting chat summary:', error);
    return null;
  }
}

/**
 * Update chat message rating
 */
async function updateChatMessageRating(messageId, rating, feedback, wasHelpful) {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('user_chat_history')
      .update({
        user_rating: rating,
        user_feedback: feedback,
        was_helpful: wasHelpful,
        updated_at: new Date().toISOString()
      })
      .eq('id', messageId)
      .select()
      .single();

    if (error) {
      console.error('Failed to update message rating:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Error updating message rating:', error);
    return null;
  }
}

/**
 * Helper function to generate session ID
 */
function generateSessionId() {
  return `session_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Determine query type from content and metadata
 */
function determineQueryType(content, metadata) {
  if (metadata.polymarketUser) return 'user_profile';
  if (metadata.marketId) return 'market_analysis';
  if (content.toLowerCase().includes('compare') && content.toLowerCase().includes('market')) return 'multi_market_comparison';
  if (content.toLowerCase().includes('signal') || content.toLowerCase().includes('recommendation')) return 'signal_request';
  return 'general_query';
}

/**
 * Determine response type from response object
 */
function determineResponseType(response) {
  if (response.recommendation) return 'recommendation';
  if (response.userProfile) return 'user_profile_data';
  if (response.analysis) return 'analysis';
  if (response.comparisonData) return 'comparison';
  return 'analysis';
}

/**
 * Extract client information from request
 */
function extractClientInfo(req) {
  return {
    userAgent: req.get('User-Agent'),
    ip: req.ip || req.connection.remoteAddress,
    language: req.get('Accept-Language'),
    referer: req.get('Referer'),
    timestamp: new Date().toISOString()
  };
}

/**
 * Middleware to enhance chat endpoint with persistence
 */
function chatPersistenceMiddleware() {
  return async (req, res, next) => {
    // Store original send method
    const originalSend = res.send;

    // Override send method to intercept response
    res.send = function(data) {
      // Only process chat endpoint responses
      if (req.path === '/chat' && req.method === 'POST') {
        handleChatPersistence(req, data);
      }
      
      // Call original send method
      originalSend.call(this, data);
    };

    next();
  };
}

/**
 * Handle chat persistence for requests
 */
async function handleChatPersistence(req, responseData) {
  try {
    // Parse response data if it's a string
    let parsedData;
    try {
      parsedData = typeof responseData === 'string' ? JSON.parse(responseData) : responseData;
    } catch (e) {
      console.error('Failed to parse response data:', e);
      return;
    }

    // Skip if there's an error in the response
    if (parsedData.error) {
      await saveErrorMessage(parsedData.error, {
        userId: req.user?.id,
        sessionId: req.body?.contextId,
        contextId: req.body?.contextId,
        clientInfo: extractClientInfo(req),
        ipAddress: req.ip
      });
      return;
    }

    // Extract user ID from request (should be added by auth middleware)
    const userId = req.user?.id || req.body?.userId;
    if (!userId) {
      console.log('No user ID found for chat persistence');
      return;
    }

    // Save the chat exchange
    const userQuery = req.body?.query || '';
    const lastMessage = parsedData.messages?.[parsedData.messages.length - 1];
    
    if (lastMessage && userQuery) {
      await saveChatExchange(userQuery, lastMessage, {
        userId,
        sessionId: req.body?.contextId || generateSessionId(),
        marketId: parsedData.matchedMarket?.id,
        marketQuestion: parsedData.matchedMarket?.question,
        polymarketUser: req.body?.polymarketUser,
        contextId: parsedData.contextId,
        matchedMarket: parsedData.matchedMarket,
        processingTimeMs: req.processingTime,
        clientInfo: extractClientInfo(req),
        ipAddress: req.ip,
        metadata: {
          apiVersion: 'v1',
          source: 'backend_middleware'
        }
      });
    }
  } catch (error) {
    console.error('Error in chat persistence handler:', error);
  }
}

module.exports = {
  saveChatMessage,
  saveChatExchange,
  saveErrorMessage,
  getUserChatAnalytics,
  getUserChatSummary,
  updateChatMessageRating,
  chatPersistenceMiddleware,
  extractClientInfo,
  generateSessionId
};
