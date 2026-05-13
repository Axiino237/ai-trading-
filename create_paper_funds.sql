-- Run this in Supabase Dashboard > SQL Editor
-- https://app.supabase.com/project/cypgokwtvpzfrsynzxaj/editor

CREATE TABLE IF NOT EXISTS paper_funds (
    user_id TEXT PRIMARY KEY,
    balance DECIMAL DEFAULT 100000.00
);

-- Seed both user IDs
INSERT INTO paper_funds (user_id, balance)
VALUES ('550e8400-e29b-41d4-a716-446655440000', 100000.00)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO paper_funds (user_id, balance)
VALUES ('00000000-0000-0000-0000-000000000000', 100000.00)
ON CONFLICT (user_id) DO NOTHING;

-- Verify
SELECT * FROM paper_funds;
