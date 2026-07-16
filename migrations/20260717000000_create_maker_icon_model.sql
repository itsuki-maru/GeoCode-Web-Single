CREATE TABLE IF NOT EXISTS marker_icon_model (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    filename CHARACTER VARYING(100) NOT NULL,
    uuid_filename CHARACTER VARYING(100) NOT NULL UNIQUE,
    create_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user_model(id) ON DELETE CASCADE
);

-- PostgreSQL では ADD COLUMN IF NOT EXISTS と ADD CONSTRAINT を別々に実行できるが、
-- SQLite の ADD COLUMN は IF NOT EXISTS と外部キー制約の後付けに対応していない。
-- そのため、列追加時に REFERENCES と ON DELETE を同時に定義する。
ALTER TABLE layer_model
ADD COLUMN marker_icon_id TEXT NULL
REFERENCES marker_icon_model(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_marker_icon_model_user_id_desc
ON marker_icon_model(user_id, create_at DESC);

CREATE INDEX IF NOT EXISTS idx_layer_model_marker_icon_id ON layer_model(marker_icon_id);
