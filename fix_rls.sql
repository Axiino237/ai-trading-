-- Fix Row Level Security (RLS) blocking the backend from inserting records
ALTER TABLE wallet_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE trades DISABLE ROW LEVEL SECURITY;
ALTER TABLE paper_funds DISABLE ROW LEVEL SECURITY;
