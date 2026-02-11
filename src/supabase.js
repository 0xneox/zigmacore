/**
 * Supabase Database Configuration — centralized lazy-init singleton
 * All modules should import getSupabase / getServiceSupabase from here.
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Anon-key client (for public / RLS-aware queries)
let anonClient = null;

function getSupabase() {
  if (anonClient) return anonClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.warn('[SUPABASE] Missing SUPABASE_URL or SUPABASE_ANON_KEY — anon client unavailable');
    return null;
  }
  anonClient = createClient(url, key);
  console.log('[SUPABASE] Anon client initialized');
  return anonClient;
}

// Service-role client (for admin / bypasses RLS)
let serviceClient = null;

function getServiceSupabase() {
  if (serviceClient) return serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[SUPABASE] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — service client unavailable');
    return null;
  }
  serviceClient = createClient(url, key);
  console.log('[SUPABASE] Service-role client initialized');
  return serviceClient;
}

module.exports = {
  getSupabase,
  getServiceSupabase
};
