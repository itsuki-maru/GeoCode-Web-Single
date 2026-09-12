ALTER TABLE temporary_urls ADD COLUMN include_tile_overlays BOOLEAN NOT NULL DEFAULT 0;
UPDATE temporary_urls SET include_tile_overlays = 1;
