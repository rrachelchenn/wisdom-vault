-- Supabase SQL Schema for Wisdom Vault
-- Run this in your Supabase SQL Editor to create the required table

-- Create the wisdom_vault_logs table
CREATE TABLE IF NOT EXISTS wisdom_vault_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  show_name TEXT,
  timestamp_seconds INTEGER DEFAULT 0,
  spotify_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create an index for faster queries by date
CREATE INDEX IF NOT EXISTS idx_wisdom_vault_logs_created_at 
  ON wisdom_vault_logs(created_at DESC);

-- Create an index for searching by title
CREATE INDEX IF NOT EXISTS idx_wisdom_vault_logs_title 
  ON wisdom_vault_logs USING gin(to_tsvector('english', title));

-- Enable Row Level Security (optional but recommended)
ALTER TABLE wisdom_vault_logs ENABLE ROW LEVEL SECURITY;

-- Create a policy to allow inserts from the anon key
-- Adjust this based on your security requirements
CREATE POLICY "Allow anonymous inserts" ON wisdom_vault_logs
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Create a policy to allow reading own entries (if you add user auth later)
CREATE POLICY "Allow anonymous reads" ON wisdom_vault_logs
  FOR SELECT
  TO anon
  USING (true);

-- Sample query to view recent logs:
-- SELECT * FROM wisdom_vault_logs ORDER BY created_at DESC LIMIT 10;

