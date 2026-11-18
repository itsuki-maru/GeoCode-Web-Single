ALTER TABLE tileserver_model
    ADD COLUMN provider TEXT NOT NULL DEFAULT 'generic';

ALTER TABLE tileserver_model
    ADD COLUMN google_map_type TEXT CHECK (
        (provider = 'generic' AND google_map_type IS NULL)
        OR (provider = 'google' AND kind = 'raster' AND id <> 1
            AND google_map_type IS NOT NULL
            AND google_map_type IN ('roadmap', 'satellite', 'terrain'))
    );

CREATE TABLE google_maps_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE CHECK (enabled IN (0, 1)),
    encrypted_tiles_key BLOB,
    language TEXT NOT NULL DEFAULT 'ja-JP',
    region TEXT NOT NULL DEFAULT 'JP',
    requests_per_minute INTEGER NOT NULL DEFAULT 1200 CHECK (requests_per_minute BETWEEN 60 AND 60000),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
