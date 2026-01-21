-- Migration script to add missing columns to trade_signals table
-- Run this in Supabase SQL editor to add missing columns for executable trades

-- Add missing columns for executable trade signals
ALTER TABLE public.trade_signals 
ADD COLUMN IF NOT EXISTS market_question TEXT,
ADD COLUMN IF NOT EXISTS size REAL,
ADD COLUMN IF NOT EXISTS kelly_percentage REAL,
ADD COLUMN IF NOT EXISTS slippage REAL,
ADD COLUMN IF NOT EXISTS spread REAL,
ADD COLUMN IF NOT EXISTS liquidity_score REAL,
ADD COLUMN IF NOT EXISTS trade_tier TEXT,
ADD COLUMN IF NOT EXISTS execution_confidence REAL,
ADD COLUMN IF NOT EXISTS model_confidence REAL,
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'MANUAL',
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'MANUAL';

-- Update existing records to have proper defaults
UPDATE public.trade_signals 
SET status = 'MANUAL', source = 'MANUAL' 
WHERE status IS NULL OR source IS NULL;
