ALTER TABLE tileserver_model
    ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE CHECK (enabled IN (0, 1));
ALTER TABLE tileserver_model
    ADD COLUMN allow_temporary_share BOOLEAN NOT NULL DEFAULT TRUE CHECK (allow_temporary_share IN (0, 1));
ALTER TABLE tileserver_model
    ADD COLUMN allow_live_map BOOLEAN NOT NULL DEFAULT TRUE CHECK (allow_live_map IN (0, 1));

CREATE TABLE background_map_fallbacks (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    temporary_id INTEGER REFERENCES tileserver_model (id) ON DELETE SET NULL,
    live_id INTEGER REFERENCES tileserver_model (id) ON DELETE SET NULL
);

-- 共有が参照している背景IDは、削除後も再利用しない。
CREATE TABLE background_map_sequence (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_id INTEGER NOT NULL CHECK (last_id >= 0)
);
INSERT INTO background_map_sequence (id, last_id)
SELECT 1, MAX(0, COALESCE(MAX(id), 0)) FROM tileserver_model;

CREATE TRIGGER remember_background_map_id
AFTER INSERT ON tileserver_model
WHEN NEW.id > (SELECT last_id FROM background_map_sequence WHERE id = 1)
BEGIN
    UPDATE background_map_sequence SET last_id = NEW.id WHERE id = 1;
END;
