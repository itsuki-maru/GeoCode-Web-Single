ALTER TABLE user_model ADD COLUMN totp_challenge_id TEXT;
ALTER TABLE user_model ADD COLUMN totp_challenge_expires_at TEXT;
ALTER TABLE user_model ADD COLUMN totp_challenge_attempts INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS user_model_totp_challenge_id_idx
ON user_model (totp_challenge_id)
WHERE totp_challenge_id IS NOT NULL;