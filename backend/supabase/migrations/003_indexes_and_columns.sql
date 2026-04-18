-- Add missing index on stripe_customer_id for webhook lookups
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer
    ON users (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

-- Add per-user model preference columns
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS analysis_model TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS fast_model TEXT DEFAULT NULL;

-- Create atomic increment function to avoid read-then-write races
CREATE OR REPLACE FUNCTION increment_paper_count(uid TEXT, delta INT DEFAULT 1)
RETURNS VOID AS $$
BEGIN
    UPDATE users
    SET paper_count = GREATEST(0, paper_count + delta)
    WHERE user_id = uid;
END;
$$ LANGUAGE plpgsql;
