-- 設定JSONと暗号化したキーを分離し、初期状態では設定行を作らない。
CREATE TABLE IF NOT EXISTS ai_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision TEXT NOT NULL,
    config TEXT NOT NULL CHECK (json_valid(config) AND json_type(config) = 'object'),
    encrypted_api_key BLOB,
    encrypted_speech_api_key BLOB,
    updated_by TEXT REFERENCES user_model(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
