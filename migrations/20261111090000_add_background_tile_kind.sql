-- 既存の背景ID・画像URL・保存済み共有JSONを保持して、種別とスタイルを追加する。
ALTER TABLE tileserver_model
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'raster'
    CHECK (kind IN ('raster', 'vector') AND (id <> 1 OR kind = 'raster'));

ALTER TABLE tileserver_model
    ADD COLUMN style_url TEXT
    CHECK (
        (kind = 'raster' AND style_url IS NULL)
        OR (kind = 'vector' AND style_url IS NOT NULL
            AND length(trim(style_url)) > 0 AND length(CAST(style_url AS BLOB)) <= 4096)
    );
