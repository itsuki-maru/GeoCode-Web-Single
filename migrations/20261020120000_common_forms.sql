CREATE TABLE common_form_model (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES user_model(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    deleted INTEGER NOT NULL DEFAULT 0,
    form_title TEXT NOT NULL,
    form_description TEXT NOT NULL,
    form_schema TEXT NOT NULL,
    create_at TEXT NOT NULL,
    update_at TEXT NOT NULL
);

CREATE INDEX idx_common_form_owner ON common_form_model(user_id, update_at DESC);

CREATE TABLE common_form_revision_model (
    form_id TEXT NOT NULL REFERENCES common_form_model(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    form_schema TEXT NOT NULL,
    PRIMARY KEY(form_id, version)
);

ALTER TABLE marker_form_config_model ADD COLUMN source_form TEXT;
ALTER TABLE shape_form_config_model ADD COLUMN source_form TEXT;
ALTER TABLE marker_form_submission_model ADD COLUMN source_form TEXT;
ALTER TABLE marker_form_submission_model ADD COLUMN form_snapshot TEXT;
ALTER TABLE shape_form_submission_model ADD COLUMN source_form TEXT;
ALTER TABLE shape_form_submission_model ADD COLUMN form_snapshot TEXT;
