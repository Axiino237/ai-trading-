ALTER TABLE payment_requests
DROP CONSTRAINT IF EXISTS payment_requests_user_id_fkey;

ALTER TABLE payment_requests
ADD CONSTRAINT payment_requests_user_id_fkey
FOREIGN KEY (user_id) REFERENCES app_users(id)
ON DELETE CASCADE;

-- Important: This tells Supabase API to reload and recognize the new relationship
NOTIFY pgrst, 'reload schema';
