CREATE TABLE IF NOT EXISTS marker_form_rate_limit_model (
    marker_id TEXT PRIMARY KEY NOT NULL,
    window_started_at INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    FOREIGN KEY (marker_id) REFERENCES marker_form_config_model(marker_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS marker_form_image_model (
    image_id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
    create_at TEXT NOT NULL,
    FOREIGN KEY (image_id) REFERENCES image_model(id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id) REFERENCES user_model(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_marker_form_image_owner
ON marker_form_image_model(owner_id);