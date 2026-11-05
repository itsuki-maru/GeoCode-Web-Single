-- NULLは通常共有。別画面地図の表示状態とタイル定義をJSON文字列で保存する。
ALTER TABLE temporary_urls ADD COLUMN map_snapshot TEXT;
