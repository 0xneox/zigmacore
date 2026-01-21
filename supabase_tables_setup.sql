-- Supabase Migration Script for Zigma Oracle
-- Run this in your Supabase SQL editor to create required tables

-- Price cache table
CREATE TABLE IF NOT EXISTS public.price_cache (
  id TEXT PRIMARY KEY,
  price REAL NOT NULL,
  created_at BIGINT NOT NULL
);

-- Alert subscriptions table
CREATE TABLE IF NOT EXISTS public.alert_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  condition TEXT NOT NULL,
  price REAL NOT NULL,
  alert_type TEXT NOT NULL,
  duration TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  active INTEGER DEFAULT 1
);

-- Analysis cache table
CREATE TABLE IF NOT EXISTS public.analysis_cache (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  market_id TEXT UNIQUE,
  last_price REAL,
  reasoning TEXT,
  confidence REAL,
  created_at BIGINT
);

-- Trade signals table
CREATE TABLE IF NOT EXISTS public.trade_signals (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  market_id TEXT,
  market_question TEXT,
  action TEXT,
  price REAL,
  confidence REAL,
  edge REAL,
  category TEXT,
  size REAL,
  kelly_percentage REAL,
  slippage REAL,
  spread REAL,
  liquidity_score REAL,
  trade_tier TEXT,
  execution_confidence REAL,
  model_confidence REAL,
  status TEXT DEFAULT 'MANUAL',
  source TEXT DEFAULT 'MANUAL',
  raw_confidence REAL,
  kelly_fraction REAL,
  predicted_probability REAL,
  entropy REAL,
  sentiment_score REAL,
  was_correct INTEGER DEFAULT 0,
  resolved_at BIGINT,
  actual_pnl REAL,
  valid INTEGER DEFAULT 1,
  created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))
);

-- Volume snapshots table (CRITICAL - this was missing)
CREATE TABLE IF NOT EXISTS public.volume_snapshots (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  market_id TEXT,
  volume REAL,
  created_at BIGINT
);

-- User performance snapshots table
CREATE TABLE IF NOT EXISTS public.user_performance_snapshots (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  total_positions INTEGER,
  total_trades INTEGER,
  realized_pnl REAL,
  unrealized_pnl REAL,
  total_volume REAL,
  win_rate REAL,
  avg_position_size REAL,
  portfolio_health_score REAL,
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, snapshot_date)
);

-- Conversation cache table
CREATE TABLE IF NOT EXISTS public.conversation_cache (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  context_data TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

-- CLOB price cache table
CREATE TABLE IF NOT EXISTS public.clob_price_cache (
  market_id TEXT PRIMARY KEY,
  mid_price REAL,
  bid_price REAL,
  ask_price REAL,
  bids_json TEXT,
  asks_json TEXT,
  updated_at BIGINT NOT NULL
);

-- Analysis cache v2 table
CREATE TABLE IF NOT EXISTS public.analysis_cache_v2 (
  market_id TEXT PRIMARY KEY,
  analysis_json TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- Signal validations table
CREATE TABLE IF NOT EXISTS public.signal_validations (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  signal_id TEXT NOT NULL,
  valid INTEGER NOT NULL,
  status TEXT NOT NULL,
  validations_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  signal_age INTEGER
);

-- Calibration history table
CREATE TABLE IF NOT EXISTS public.calibration_history (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  confidence_bin TEXT NOT NULL,
  category TEXT,
  predicted_confidence REAL NOT NULL,
  actual_accuracy REAL NOT NULL,
  sample_size INTEGER NOT NULL,
  adjustment REAL NOT NULL,
  created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))
);

-- Learning history table
CREATE TABLE IF NOT EXISTS public.learning_history (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  signal_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  original_edge REAL NOT NULL,
  adjusted_edge REAL NOT NULL,
  original_confidence REAL NOT NULL,
  adjusted_confidence REAL NOT NULL,
  outcome TEXT,
  was_correct INTEGER,
  learning_factor REAL NOT NULL,
  created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_price_cache_timestamp ON public.price_cache(created_at);
CREATE INDEX IF NOT EXISTS idx_alert_subscriptions_user_active ON public.alert_subscriptions(user_id, active);
CREATE INDEX IF NOT EXISTS idx_analysis_cache_market_id ON public.analysis_cache(market_id);
CREATE INDEX IF NOT EXISTS idx_trade_signals_market_timestamp ON public.trade_signals(market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_signals_category_outcome ON public.trade_signals(category, outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_volume_snapshots_market_timestamp ON public.volume_snapshots(market_id, created_at);
CREATE INDEX IF NOT EXISTS idx_user_performance_snapshots_user_date ON public.user_performance_snapshots(user_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_conversation_cache_expires ON public.conversation_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_clob_price_cache_updated ON public.clob_price_cache(updated_at);
CREATE INDEX IF NOT EXISTS idx_analysis_cache_v2_updated ON public.analysis_cache_v2(updated_at);
CREATE INDEX IF NOT EXISTS idx_signal_validations_timestamp ON public.signal_validations(created_at);
CREATE INDEX IF NOT EXISTS idx_calibration_history_timestamp ON public.calibration_history(created_at);
CREATE INDEX IF NOT EXISTS idx_learning_history_timestamp ON public.learning_history(created_at);
