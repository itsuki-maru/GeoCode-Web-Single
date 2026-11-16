-- 確認対象と実行結果を同じ操作IDに結び付け、再送による二重作成を防ぐ。
-- APIキー・会話・音声は保存しない。
CREATE TABLE IF NOT EXISTS ai_operation_model (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES user_model(id) ON DELETE CASCADE,
    settings_revision TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
    result TEXT CHECK (result IS NULL OR (json_valid(result) AND json_type(result) = 'object')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK ((result IS NULL) = (completed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_ai_operation_owner ON ai_operation_model(user_id, created_at DESC);
