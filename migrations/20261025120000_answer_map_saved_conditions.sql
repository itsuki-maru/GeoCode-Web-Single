CREATE TABLE IF NOT EXISTS answer_map_saved_condition_model (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES user_model(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('filter', 'coloring')),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100 AND length(trim(name)) > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    definition TEXT NOT NULL CHECK (json_valid(definition) AND json_type(definition) = 'object'),
    display TEXT NOT NULL CHECK (json_valid(display) AND json_type(display) = 'object'),
    create_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answer_map_saved_condition_owner
    ON answer_map_saved_condition_model(user_id, create_at DESC, id DESC);
