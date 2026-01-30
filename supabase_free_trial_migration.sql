-- ============================================
-- FREE TRIAL SYSTEM - SUPABASE MIGRATION
-- Add free trial support for new email signups
-- ============================================

-- 1. Add free_chats_remaining column to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS free_chats_remaining INTEGER DEFAULT 3;

-- 2. Update credit_usage table to track usage type
ALTER TABLE credit_usage
ADD COLUMN IF NOT EXISTS usage_type TEXT DEFAULT 'credit' CHECK (usage_type IN ('credit', 'free_trial'));

-- 3. Set existing users to 0 free chats (already established users)
UPDATE users 
SET free_chats_remaining = 0 
WHERE free_chats_remaining IS NULL;

-- 4. Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_users_free_chats ON users(free_chats_remaining);

-- 5. Create function to auto-grant free trial on signup
CREATE OR REPLACE FUNCTION grant_free_trial_on_signup()
RETURNS TRIGGER AS $$
BEGIN
  -- Grant 3 free chats to new users
  NEW.free_chats_remaining := 3;
  NEW.chat_credits := COALESCE(NEW.chat_credits, 0);
  NEW.total_credits_earned := COALESCE(NEW.total_credits_earned, 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. Create trigger to auto-grant free trial
DROP TRIGGER IF EXISTS trigger_grant_free_trial ON users;
CREATE TRIGGER trigger_grant_free_trial
  BEFORE INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION grant_free_trial_on_signup();

-- 7. Grant permissions
GRANT ALL ON users TO authenticated;
GRANT ALL ON users TO anon;
GRANT ALL ON credit_usage TO authenticated;
GRANT ALL ON credit_usage TO anon;

-- Success message
DO $$
BEGIN
  RAISE NOTICE '✅ Free trial system migration completed!';
  RAISE NOTICE '📝 New users will automatically get 3 free chats';
  RAISE NOTICE '🔄 Existing users set to 0 free chats (already established)';
END $$;
