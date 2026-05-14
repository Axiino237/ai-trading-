-- Create wallet_logs table for financial auditing
CREATE TABLE IF NOT EXISTS wallet_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    amount DECIMAL NOT NULL,
    type TEXT NOT NULL, -- 'CREDIT' or 'DEBIT'
    reason TEXT, -- 'TRADE_ENTRY', 'TRADE_EXIT', 'DEPOSIT', 'ADMIN_ADJUST'
    trade_id UUID, -- Optional link to trades table
    balance_after DECIMAL NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster user-specific lookup
CREATE INDEX IF NOT EXISTS idx_wallet_logs_user_id ON wallet_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_logs_created_at ON wallet_logs(created_at);
