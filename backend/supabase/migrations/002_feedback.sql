-- 002_feedback.sql  –  Feedback & cancellation reasons

CREATE TABLE feedback (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    TEXT NOT NULL DEFAULT 'anonymous',
    type       TEXT NOT NULL DEFAULT 'general',  -- 'general' | 'cancellation'
    reason     TEXT NOT NULL DEFAULT '',
    message    TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_feedback_user ON feedback(user_id);
CREATE INDEX idx_feedback_type ON feedback(type);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY feedback_insert ON feedback FOR INSERT WITH CHECK (true);
CREATE POLICY feedback_own    ON feedback FOR SELECT USING (user_id = current_setting('app.user_id', true));
