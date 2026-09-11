CREATE TABLE tile_overlay_model (
    id TEXT PRIMARY KEY NOT NULL,
    name VARCHAR(100) NOT NULL,
    url TEXT NOT NULL,
    attribution VARCHAR(1000) NOT NULL DEFAULT '',
    min_zoom INTEGER NOT NULL DEFAULT 0 CHECK (min_zoom BETWEEN 0 AND 22),
    max_zoom INTEGER NOT NULL DEFAULT 18 CHECK (max_zoom BETWEEN min_zoom AND 22),
    opacity REAL NOT NULL DEFAULT 0.7 CHECK (opacity BETWEEN 0 AND 1),
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_tile_overlay_model (
    user_id TEXT NOT NULL REFERENCES user_model(id) ON DELETE CASCADE,
    tile_overlay_id TEXT NOT NULL REFERENCES tile_overlay_model(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, tile_overlay_id)
);
CREATE INDEX idx_user_tile_overlay_tile ON user_tile_overlay_model(tile_overlay_id);
