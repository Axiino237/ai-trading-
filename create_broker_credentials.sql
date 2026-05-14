-- Run this in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS broker_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT REFERENCES app_users(id) ON DELETE CASCADE,
    broker VARCHAR(50) DEFAULT 'ANGEL_ONE',
    client_id VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    totp_secret VARCHAR(255) NOT NULL,
    api_key VARCHAR(255) NOT NULL,
    angel_secret VARCHAR(255) NOT NULL,
    telegram_bot_token VARCHAR(255),
    telegram_chat_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, broker)
);

-- Disable RLS for now to ensure backend has full access
ALTER TABLE broker_credentials DISABLE ROW LEVEL SECURITY;

-- Reload Supabase Schema Cache so the API recognizes the new table immediately
NOTIFY pgrst, 'reload schema';
