-- Add missing was_correct column to trade_signals table
ALTER TABLE trade_signals ADD COLUMN was_correct INTEGER DEFAULT 0;

-- Add other missing columns if they don't exist
ALTER TABLE trade_signals ADD COLUMN resolved_at INTEGER;
ALTER TABLE trade_signals ADD COLUMN actual_pnl REAL;

-- Verify the table structure
PRAGMA table_info(trade_signals);
