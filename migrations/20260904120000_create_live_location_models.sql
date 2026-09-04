ALTER TABLE user_model
ADD COLUMN can_share_live_location BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS live_location_session (
    user_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    accuracy_m REAL CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
    heading_deg REAL CHECK (heading_deg IS NULL OR heading_deg BETWEEN 0 AND 360),
    speed_mps REAL CHECK (speed_mps IS NULL OR speed_mps >= 0),
    sequence_no INTEGER NOT NULL DEFAULT 0 CHECK (sequence_no >= 0),
    observed_at TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES user_model(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_live_location_received_at
ON live_location_session(received_at);

CREATE TABLE IF NOT EXISTS live_map (
    id TEXT PRIMARY KEY NOT NULL,
    public_id TEXT NOT NULL,
    name CHARACTER VARYING(100) NOT NULL,
    created_by TEXT NOT NULL,
    password_hash CHARACTER VARYING(256),
    access_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY (created_by) REFERENCES user_model(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_live_map_active
ON live_map(expires_at) WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_live_map_public_id
ON live_map(public_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_live_map_single_unrevoked
ON live_map ((1))
WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS live_map_member (
    id TEXT PRIMARY KEY NOT NULL,
    map_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name CHARACTER VARYING(100) NOT NULL,
    marker_color CHARACTER VARYING(7) NOT NULL DEFAULT '#1a73e8',
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (map_id) REFERENCES live_map(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES user_model(id) ON DELETE CASCADE,
    UNIQUE(map_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_live_map_member_map
ON live_map_member(map_id);

CREATE TABLE IF NOT EXISTS live_map_password_rate_limit (
    map_id TEXT NOT NULL,
    client_key CHARACTER VARYING(64) NOT NULL,
    window_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    PRIMARY KEY (map_id, client_key),
    FOREIGN KEY (map_id) REFERENCES live_map(id) ON DELETE CASCADE
);
