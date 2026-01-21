/**
 * FIXED: Positions Table in Chat.tsx
 * 
 * Replace the Active Positions section (lines ~1197-1226) with this:
 */

// ============================================================
// FIX #1: POSITIONS TABLE - Show market title, use cashPnl
// ============================================================
{positions && positions.length > 0 && (
  <CollapsibleSection 
    title="Active Positions" 
    icon="💼" 
    badge={<Badge className="ml-2 text-[9px] bg-gray-700/50">{positions.length}</Badge>}
  >
    <div className="max-h-64 overflow-y-auto">
      <table className="w-full text-[10px]">
        <thead className="sticky top-0 bg-black/90">
          <tr className="text-muted-foreground border-b border-green-500/20">
            <th className="p-2 text-left">Market</th>
            <th className="p-2 text-center">Side</th>
            <th className="p-2 text-right">Size</th>
            <th className="p-2 text-right">Avg Price</th>
            <th className="p-2 text-right">Cur Price</th>
            <th className="p-2 text-right">P&L</th>
            <th className="p-2 text-right">P&L %</th>
          </tr>
        </thead>
        <tbody>
          {positions.slice(0, 15).map((pos, i) => {
            // FIX: Use cashPnl directly from API instead of recalculating
            const pnl = pos.cashPnl ?? 0;
            const pnlPercent = pos.percentPnl ?? 0;
            const isProfit = pnl >= 0;
            
            return (
              <tr 
                key={i} 
                className={cn(
                  "border-t border-green-500/10 hover:bg-green-500/5 transition-colors",
                  Math.abs(pnlPercent) > 20 && !isProfit && "bg-red-900/10"
                )}
              >
                {/* FIX: Show market title, not outcome */}
                <td className="p-2 text-white">
                  <div className="flex flex-col">
                    <span className="truncate max-w-[180px] font-medium">
                      {pos.title || pos.market || "Unknown Market"}
                    </span>
                    <span className="text-[8px] text-muted-foreground">
                      {pos.outcome || "Yes"}
                    </span>
                  </div>
                </td>
                
                {/* Position side badge */}
                <td className="p-2 text-center">
                  <Badge 
                    className={cn(
                      "text-[8px] px-1.5 py-0.5",
                      pos.outcome === "Yes" 
                        ? "bg-green-600/20 text-green-300 border-green-500/30"
                        : "bg-red-600/20 text-red-300 border-red-500/30"
                    )}
                  >
                    {pos.outcome || "YES"}
                  </Badge>
                </td>
                
                <td className="p-2 text-right font-mono text-white">
                  {(pos.size ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </td>
                
                <td className="p-2 text-right font-mono text-muted-foreground">
                  {((pos.avgPrice ?? 0) * 100).toFixed(1)}¢
                </td>
                
                <td className="p-2 text-right font-mono text-white">
                  {((pos.curPrice ?? 0) * 100).toFixed(1)}¢
                </td>
                
                <td className={cn(
                  "p-2 text-right font-mono font-semibold",
                  isProfit ? "text-green-400" : "text-red-400"
                )}>
                  {isProfit ? "+" : ""}{formatCurrency(pnl)}
                </td>
                
                <td className={cn(
                  "p-2 text-right font-mono text-xs",
                  isProfit ? "text-green-400" : "text-red-400"
                )}>
                  {isProfit ? "+" : ""}{pnlPercent.toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
        
        {/* Total row */}
        <tfoot className="border-t-2 border-green-500/30 bg-black/60">
          <tr>
            <td colSpan={5} className="p-2 text-right text-xs text-muted-foreground font-semibold">
              Total Unrealized P&L:
            </td>
            <td className={cn(
              "p-2 text-right font-mono font-bold",
              (metrics?.unrealizedPnl ?? 0) >= 0 ? "text-green-400" : "text-red-400"
            )}>
              {formatCurrency(metrics?.unrealizedPnl ?? positions.reduce((sum, p) => sum + (p.cashPnl || 0), 0))}
            </td>
            <td className="p-2"></td>
          </tr>
        </tfoot>
      </table>
    </div>
    
    {positions.length > 15 && (
      <p className="text-[10px] text-muted-foreground text-center mt-2">
        Showing 15 of {positions.length} positions
      </p>
    )}
  </CollapsibleSection>
)}

// ============================================================
// FIX #2: CATEGORY PERFORMANCE - Show P&L breakdown
// ============================================================
{analysis?.categoryPerformance && analysis.categoryPerformance.length > 0 && (
  <CollapsibleSection 
    title="Category Performance" 
    icon="📊" 
    badge={<Badge className="ml-2 text-[9px] bg-gray-700/50">{analysis.categoryPerformance.length}</Badge>}
  >
    <div className="space-y-2">
      {analysis.categoryPerformance.map((cat, i) => {
        const isProfit = cat.pnl >= 0;
        const hasUnrealized = cat.unrealizedPnl && cat.unrealizedPnl !== cat.pnl;
        
        return (
          <div 
            key={i} 
            className={cn(
              "flex items-center justify-between p-2 rounded",
              isProfit ? "bg-green-900/10" : "bg-red-900/10"
            )}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-white">{cat.category}</span>
              <Badge className="text-[8px] bg-gray-700/50">
                {cat.uniqueMarkets} market{cat.uniqueMarkets !== 1 ? 's' : ''}
              </Badge>
            </div>
            
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className={cn(
                  "font-mono text-sm font-semibold",
                  isProfit ? "text-green-400" : "text-red-400"
                )}>
                  {formatCurrency(cat.pnl)}
                </div>
                {hasUnrealized && (
                  <div className="text-[9px] text-muted-foreground">
                    Realized: {formatCurrency(cat.realizedPnl || 0)} | 
                    Open: {formatCurrency(cat.unrealizedPnl || 0)}
                  </div>
                )}
              </div>
              
              <div className="text-right min-w-[60px]">
                <div className={cn(
                  "font-mono text-xs",
                  cat.winRate >= 50 ? "text-green-400" : "text-yellow-400"
                )}>
                  {cat.winRate.toFixed(0)}% win
                </div>
                <div className="text-[9px] text-muted-foreground">
                  {cat.trades} trades
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  </CollapsibleSection>
)}

// ============================================================
// FIX #3: TRADING PATTERNS - Better metrics display
// ============================================================
{analysis?.patterns && (
  <CollapsibleSection title="Trading Patterns" icon="📈" defaultOpen={true}>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <MetricCard 
        label="Win Rate"
        value={`${(analysis.patterns.winRate ?? 0).toFixed(1)}%`}
        status={analysis.patterns.winRate >= 55 ? "good" : analysis.patterns.winRate >= 45 ? "warning" : "bad"}
        tooltip="Percentage of profitable positions"
      />
      <MetricCard 
        label="Profit Factor"
        value={(analysis.patterns.profitFactor ?? 0).toFixed(2)}
        status={analysis.patterns.profitFactor >= 2 ? "good" : analysis.patterns.profitFactor >= 1 ? "warning" : "bad"}
        tooltip="Ratio of total wins to total losses"
      />
      <MetricCard 
        label="Sharpe Ratio"
        value={(analysis.patterns.sharpeRatio ?? 0).toFixed(2)}
        status={analysis.patterns.sharpeRatio >= 1.5 ? "good" : analysis.patterns.sharpeRatio >= 0.5 ? "warning" : "neutral"}
        tooltip="Risk-adjusted return metric"
      />
      <MetricCard 
        label="Avg Hold Time"
        value={
          (analysis.patterns.avgHoldTime ?? 0) > 24 
            ? `${(analysis.patterns.avgHoldTime / 24).toFixed(1)}d`
            : (analysis.patterns.avgHoldTime ?? 0) > 0
              ? `${(analysis.patterns.avgHoldTime).toFixed(1)}h`
              : "Position"
        }
        status="neutral"
        tooltip="Average time holding positions"
      />
    </div>
    
    {/* Trading Style Breakdown */}
    <div className="mt-3 pt-3 border-t border-green-500/10">
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground mb-2">Trading Style</p>
      <div className="flex gap-2">
        {analysis.patterns.scalpingTendency > 0.3 && (
          <Badge className="bg-purple-600/20 text-purple-300 border-purple-500/30 text-[9px]">
            Scalper ({(analysis.patterns.scalpingTendency * 100).toFixed(0)}%)
          </Badge>
        )}
        {analysis.patterns.swingTendency > 0.3 && (
          <Badge className="bg-blue-600/20 text-blue-300 border-blue-500/30 text-[9px]">
            Swing ({(analysis.patterns.swingTendency * 100).toFixed(0)}%)
          </Badge>
        )}
        {analysis.patterns.hodlTendency > 0.3 && (
          <Badge className="bg-green-600/20 text-green-300 border-green-500/30 text-[9px]">
            Position ({(analysis.patterns.hodlTendency * 100).toFixed(0)}%)
          </Badge>
        )}
      </div>
    </div>
  </CollapsibleSection>
)}

// ============================================================
// HELPER COMPONENT: MetricCard
// ============================================================
const MetricCard = ({ 
  label, 
  value, 
  status = "neutral", 
  tooltip 
}: { 
  label: string; 
  value: string; 
  status?: "good" | "warning" | "bad" | "neutral"; 
  tooltip?: string;
}) => {
  const statusColors = {
    good: "text-green-400 border-green-500/30",
    warning: "text-yellow-400 border-yellow-500/30",
    bad: "text-red-400 border-red-500/30",
    neutral: "text-white border-green-500/20"
  };

  return (
    <MetricTooltip content={tooltip || label}>
      <div className={cn(
        "bg-black/30 rounded-lg p-2 border",
        statusColors[status].split(" ")[1]
      )}>
        <p className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</p>
        <p className={cn("font-mono text-lg", statusColors[status].split(" ")[0])}>
          {value}
        </p>
      </div>
    </MetricTooltip>
  );
};