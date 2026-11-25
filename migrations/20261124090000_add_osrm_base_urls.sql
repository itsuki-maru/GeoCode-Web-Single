ALTER TABLE osrm_settings ADD COLUMN drive_base_url TEXT;

ALTER TABLE osrm_settings ADD COLUMN walk_base_url TEXT
    CONSTRAINT osrm_settings_distinct_mode_urls CHECK (
        walk_base_url IS NULL OR (
            drive_base_url IS NOT NULL AND rtrim(drive_base_url, '/') <> rtrim(walk_base_url, '/')
        )
    );
