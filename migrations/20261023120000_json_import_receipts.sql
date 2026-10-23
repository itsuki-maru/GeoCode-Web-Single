CREATE TABLE IF NOT EXISTS json_import_receipt_model (
    user_id TEXT NOT NULL REFERENCES user_model(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    payload_sha256 BLOB NOT NULL CHECK (
        typeof(payload_sha256) = 'blob' AND length(payload_sha256) = 32
    ),
    completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, request_id)
);
