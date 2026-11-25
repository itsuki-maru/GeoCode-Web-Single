CREATE TABLE osrm_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision TEXT,
    encrypted_drive_key BLOB,
    encrypted_walk_key BLOB,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (revision IS NOT NULL OR (encrypted_drive_key IS NULL AND encrypted_walk_key IS NULL))
);

INSERT INTO osrm_settings (id) VALUES (1);
