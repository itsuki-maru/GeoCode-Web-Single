CREATE TABLE IF NOT EXISTS shape_form_config_model (
    shape_id TEXT PRIMARY KEY NOT NULL,
    public_id TEXT NOT NULL UNIQUE,
    enabled BOOLEAN DEFAULT FALSE NOT NULL,
    form_title CHARACTER VARYING(100) NOT NULL,
    form_description CHARACTER VARYING(1000) NOT NULL,
    form_schema TEXT NOT NULL,
    password_hash CHARACTER VARYING(256),
    create_at TEXT NOT NULL,
    update_at TEXT NOT NULL,
    FOREIGN KEY (shape_id) REFERENCES shape_model(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shape_form_submission_model (
    id TEXT PRIMARY KEY NOT NULL,
    shape_id TEXT NOT NULL,
    submitted_values TEXT NOT NULL,
    rendered_markdown TEXT NOT NULL,
    create_at TEXT NOT NULL,
    FOREIGN KEY (shape_id) REFERENCES shape_model(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shape_form_submission_shape_create
ON shape_form_submission_model(shape_id, create_at DESC);

CREATE TABLE IF NOT EXISTS shape_form_rate_limit_model (
    shape_id TEXT PRIMARY KEY NOT NULL,
    window_started_at INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    FOREIGN KEY (shape_id) REFERENCES shape_form_config_model(shape_id) ON DELETE CASCADE
);
