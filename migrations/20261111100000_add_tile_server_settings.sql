CREATE TABLE IF NOT EXISTS tile_server_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision TEXT NOT NULL,
    proxy_revision TEXT,
    proxy_base_url TEXT,
    encrypted_api_key BLOB,
    vector_origins TEXT CHECK (vector_origins IS NULL OR (json_valid(vector_origins) AND json_type(vector_origins) = 'array')),
    updated_by TEXT REFERENCES user_model(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((proxy_base_url IS NULL) = (encrypted_api_key IS NULL)),
    CHECK (proxy_base_url IS NULL OR proxy_revision IS NOT NULL)
);
