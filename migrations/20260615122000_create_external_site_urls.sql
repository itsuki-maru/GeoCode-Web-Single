CREATE TABLE IF NOT EXISTS external_site_urls (
    user_id TEXT PRIMARY KEY NOT NULL,
    url TEXT NOT NULL,
    create_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user_model(id) ON DELETE CASCADE
);
