/**
 * Supabase Database Configuration
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[SUPABASE] Missing environment variables: SUPABASE_URL or SUPABASE_ANON_KEY');
  throw new Error('Supabase configuration missing');
}

const supabase = createClient(supabaseUrl, supabaseKey);

console.log('[SUPABASE] Client initialized successfully');

module.exports = {
  supabase
};
