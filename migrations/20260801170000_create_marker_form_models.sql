CREATE TABLE IF NOT EXISTS marker_form_config_model (
    marker_id TEXT PRIMARY KEY NOT NULL,
    public_id TEXT NOT NULL UNIQUE,
    enabled BOOLEAN DEFAULT FALSE NOT NULL,
    form_title CHARACTER VARYING(100) NOT NULL,
    form_description CHARACTER VARYING(1000) NOT NULL,
    form_schema TEXT NOT NULL,
    password_hash CHARACTER VARYING(256),
    create_at TEXT NOT NULL,
    update_at TEXT NOT NULL,
    FOREIGN KEY (marker_id) REFERENCES marker_info_model(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS marker_form_submission_model (
    id TEXT PRIMARY KEY NOT NULL,
    marker_id TEXT NOT NULL,
    submitted_values TEXT NOT NULL,
    rendered_markdown TEXT NOT NULL,
    create_at TEXT NOT NULL,
    FOREIGN KEY (marker_id) REFERENCES marker_info_model(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_marker_form_submission_marker_create
ON marker_form_submission_model(marker_id, create_at DESC);