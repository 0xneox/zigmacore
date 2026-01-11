/**
 * Personalized LLM Analysis Module
 * Generates user-specific trading insights by incorporating trading history
 */

const { getUserPerformanceHistory, getUserPerformanceTrend } = require('../db');

/**
 * Build user context for LLM prompt
 * @param {Object} userProfile - User profile data
 * @returns {Object} - User context summary
 */
function buildUserContext(userProfile) {
  const { metrics, analysis, trend } = userProfile || {};

  return {
    tradingStyle: analysis?.patterns ? {
      avgHoldTime: analysis.patterns.avgHoldTime,
      tradeFrequency: analysis.patterns.tradeFrequency,
      buySellRatio: analysis.patterns.buySellRatio,
      avgPositionSize: analysis.patterns.avgPositionSize,
      style: [
        analysis.patterns.scalpingTendency > 0.3 ? 'Scalper' : null,
        analysis.patterns.swingTendency > 0.3 ? 'Swing' : null,
        analysis.patterns.hodlTendency > 0.3 ? 'HODL' : null
      ].filter(Boolean).join(' + ') || 'Balanced'
    } : null,

    performance: {
      totalTrades: metrics?.totalTrades || 0,
      winRate: metrics?.winRate || 0,
      realizedPnl: metrics?.realizedPnl || 0,
      unrealizedPnl: metrics?.unrealizedPnl || 0,
      totalVolume: metrics?.totalVolume || 0
    },

    strengths: analysis?.categoryPerformance
      ?.filter(cat => (cat.pnl || 0) > 0)
      .map(cat => cat.category)
      .slice(0, 3) || [],

    weaknesses: analysis?.categoryPerformance
      ?.filter(cat => (cat.pnl || 0) < 0)
      .map(cat => cat.category)
      .slice(0, 3) || [],

    riskProfile: analysis?.risk ? {
      diversificationScore: analysis.risk.diversificationScore,
      topPositionExposure: analysis.risk.topPositionExposure,
      concentrationScore: analysis.risk.concentrationScore
    } : null,

    recentTrend: trend ? {
      pnlChange: trend.realizedPnlChange,
      winRateChange: trend.winRateChange,
      healthScoreChange: trend.healthScoreChange,
      tradesAdded: trend.totalTradesAdded
    } : null,

    portfolioHealth: analysis?.health ? {
      grade: analysis.health.grade,
      score: analysis.health.score
    } : null
  };
}

/**
 * Generate personalized LLM prompt for market analysis
 * @param {Object} market - Market data
 * @param {Object} userContext - User trading context
 * @returns {string} - Personalized prompt
 */
function generatePersonalizedPrompt(market, userContext) {
  const basePrompt = `You are analyzing a Polymarket prediction market for a specific trader.

MARKET DETAILS:
- Question: ${market.question || 'Unknown'}
- Current YES Price: ${(market.yesPrice * 100).toFixed(2)}%
- Current NO Price: ${(market.noPrice * 100).toFixed(2)}%
- Liquidity: $${(market.liquidity || 0).toLocaleString()}
- Volume 24h: $${(market.volume24hr || 0).toLocaleString()}
- End Date: ${market.endDateIso || 'Unknown'}

TRADER PROFILE:
- Trading Style: ${userContext.tradingStyle?.style || 'Unknown'}
- Average Hold Time: ${userContext.tradingStyle?.avgHoldTime?.toFixed(1) || 'N/A'} hours
- Trade Frequency: ${userContext.tradingStyle?.tradeFrequency?.toFixed(1) || 'N/A'} trades/day
- Average Position Size: $${(userContext.tradingStyle?.avgPositionSize || 0).toFixed(2)}

PERFORMANCE:
- Total Trades: ${userContext.performance?.totalTrades || 0}
- Win Rate: ${(userContext.performance?.winRate || 0).toFixed(1)}%
- Realized P&L: $${(userContext.performance?.realizedPnl || 0).toFixed(2)}
- Unrealized P&L: $${(userContext.performance?.unrealizedPnl || 0).toFixed(2)}
- Total Volume: $${(userContext.performance?.totalVolume || 0).toFixed(2)}

STRONG CATEGORIES: ${userContext.strengths?.join(', ') || 'None identified'}
WEAK CATEGORIES: ${userContext.weaknesses?.join(', ') || 'None identified'}

RISK PROFILE:
- Diversification Score: ${(userContext.riskProfile?.diversificationScore || 0).toFixed(0)}%
- Top Position Exposure: ${(userContext.riskProfile?.topPositionExposure || 0).toFixed(1)}%
- Concentration Score: ${(userContext.riskProfile?.concentrationScore || 0).toFixed(0)}

PORTFOLIO HEALTH: Grade ${userContext.portfolioHealth?.grade || 'N/A'} (Score: ${(userContext.portfolioHealth?.score || 0).toFixed(0)})

RECENT TREND (7 days):
- P&L Change: $${(userContext.recentTrend?.pnlChange || 0).toFixed(2)}
- Win Rate Change: ${(userContext.recentTrend?.winRateChange || 0).toFixed(1)}%
- Health Score Change: ${(userContext.recentTrend?.healthScoreChange || 0).toFixed(0)}
- New Trades: ${userContext.recentTrend?.tradesAdded || 0}

ANALYSIS REQUIREMENTS:
1. Assess market probability based on fundamentals and news
2. Consider if this market aligns with the trader's strengths
3. Evaluate risk given the trader's current portfolio concentration
4. Recommend position size based on Kelly criterion and trader's risk profile
5. Provide personalized reasoning that references the trader's actual performance

Respond in JSON format:
{
  "probability": 0.0-1.0,
  "confidence": 0.0-1.0,
  "action": "BUY YES" | "BUY NO" | "HOLD",
  "reasoning": "Personalized analysis referencing trader's profile",
  "effectiveEdge": 0.0-1.0,
  "positionSize": 0.0-1.0 (fraction of portfolio),
  "personalizedInsights": ["Specific insight 1", "Specific insight 2"]
}`;

  return basePrompt;
}

/**
 * Generate personalized recommendation summary
 * @param {Object} analysis - LLM analysis result
 * @param {Object} userContext - User trading context
 * @returns {string} - Personalized summary
 */
function generatePersonalizedSummary(analysis, userContext) {
  const insights = analysis.personalizedInsights || [];
  const action = analysis.action || 'HOLD';
  const probability = analysis.probability || 0.5;
  const confidence = analysis.confidence || 0.5;

  let summary = `Based on your trading profile (${userContext.tradingStyle?.style || 'balanced style'}), `;

  if (action === 'BUY YES' || action === 'BUY NO') {
    summary += `I recommend ${action} on this market. `;
    summary += `Your ${(probability * 100).toFixed(1)}% probability estimate shows a `;
    summary += `${(analysis.effectiveEdge * 100).toFixed(1)}% edge against the market. `;
    
    if (userContext.recentTrend?.pnlChange > 0) {
      summary += `Given your recent positive trend ($${userContext.recentTrend.pnlChange.toFixed(2)}), `;
      summary += `this aligns with your current momentum. `;
    } else if (userContext.recentTrend?.pnlChange < 0) {
      summary += `Consider sizing conservatively given your recent drawdown. `;
    }

    if (userContext.riskProfile?.diversificationScore < 50) {
      summary += `Your portfolio is concentrated (${userContext.riskProfile.diversificationScore.toFixed(0)}% diversification), `;
      summary += `so keep position size at ${(analysis.positionSize * 100).toFixed(1)}% of portfolio. `;
    }
  } else {
    summary += `I recommend HOLDING on this market. `;
    summary += `The edge is insufficient given your ${(confidence * 100).toFixed(1)}% confidence threshold. `;
  }

  if (insights.length > 0) {
    summary += `\n\nKey insights:\n`;
    insights.forEach((insight, i) => {
      summary += `${i + 1}. ${insight}\n`;
    });
  }

  return summary;
}

module.exports = {
  buildUserContext,
  generatePersonalizedPrompt,
  generatePersonalizedSummary
};
