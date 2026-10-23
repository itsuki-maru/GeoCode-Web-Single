-- Existing content and answer history are kept verbatim; metadata is adopted lazily.
ALTER TABLE marker_form_submission_model ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE marker_form_submission_model ADD COLUMN edited_at TEXT;
ALTER TABLE shape_form_submission_model ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE shape_form_submission_model ADD COLUMN edited_at TEXT;
ALTER TABLE marker_info_model ADD COLUMN form_body_parts TEXT;
ALTER TABLE shape_model ADD COLUMN form_body_parts TEXT;
