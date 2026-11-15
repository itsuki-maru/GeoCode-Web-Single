CREATE TABLE tile_catalog_schema (
    version INTEGER PRIMARY KEY NOT NULL CHECK (version = 1),
    checksum TEXT NOT NULL
);

CREATE TABLE tile_catalog_binding (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    app_database_path TEXT NOT NULL,
    app_file_id TEXT NOT NULL
);

CREATE TABLE local_tile_datasets (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    storage_kind TEXT NOT NULL CHECK (storage_kind IN ('managed', 'external')),
    database_path TEXT NOT NULL CHECK (length(database_path) > 0),
    dataset_key TEXT NOT NULL,
    info_json TEXT NOT NULL CHECK (json_valid(info_json)),
    created_at TEXT NOT NULL,
    retired BOOLEAN NOT NULL DEFAULT FALSE CHECK (retired IN (0, 1))
);

CREATE TABLE local_tile_render_profiles (
    id TEXT NOT NULL,
    dataset_id TEXT NOT NULL REFERENCES local_tile_datasets(id),
    build_id TEXT NOT NULL,
    info_json TEXT NOT NULL CHECK (json_valid(info_json)),
    retired BOOLEAN NOT NULL DEFAULT FALSE CHECK (retired IN (0, 1)),
    PRIMARY KEY (dataset_id, id)
);

CREATE TABLE local_tile_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('import', 'precompute')),
    dataset_id TEXT REFERENCES local_tile_datasets(id),
    state TEXT NOT NULL CHECK (state IN (
        'queued', 'running', 'cancelling', 'succeeded', 'failed',
        'cancelled', 'deadline_exceeded', 'interrupted'
    )),
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    progress_json TEXT NOT NULL CHECK (json_valid(progress_json)),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_id TEXT NOT NULL
);

CREATE INDEX local_tile_jobs_created ON local_tile_jobs(created_at DESC, id);
CREATE INDEX local_tile_jobs_owner_state ON local_tile_jobs(owner_id, state);
