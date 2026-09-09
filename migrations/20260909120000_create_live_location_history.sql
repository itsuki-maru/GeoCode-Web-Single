CREATE TABLE live_location_history (
    user_id TEXT NOT NULL REFERENCES user_model(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    accuracy_m REAL CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
    heading_deg REAL CHECK (heading_deg IS NULL OR heading_deg BETWEEN 0 AND 360),
    speed_mps REAL CHECK (speed_mps IS NULL OR speed_mps >= 0),
    observed_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (session_id, sequence_no)
);

CREATE INDEX idx_live_location_history_user_received
ON live_location_history (user_id, received_at);
