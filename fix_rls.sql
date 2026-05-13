-- Run this in Supabase SQL Editor to disable RLS on paper_funds
-- (or add a policy so the anon key can read/write)

-- Option 1: Disable RLS entirely (simple, fine for this app)
ALTER TABLE paper_funds DISABLE ROW LEVEL SECURITY;

-- Verify rows are visible now
SELECT * FROM paper_funds;

