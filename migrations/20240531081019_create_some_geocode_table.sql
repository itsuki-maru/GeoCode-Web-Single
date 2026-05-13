-- Add migration script here
CREATE TABLE IF NOT EXISTS user_model (
    id TEXT PRIMARY KEY NOT NULL,
    username CHARACTER VARYING(256) NOT NULL UNIQUE,
    password CHARACTER VARYING(256) NOT NULL,
    create_at TEXT NOT NULL,
    is_superuser BOOLEAN NOT NULL,
    failed_count INTEGER NOT NULL,
    next_challenge_time TEXT NOT NULL,
    is_locked BOOLEAN NOT NULL,
    is_private BOOLEAN NOT NULL,
    is_basic_authed BOOLEAN DEFAULT FALSE NOT NULL,
    is_basic_authed_at TEXT NOT NULL,
    totp_secret CHARACTER VARYING(256) NOT NULL,
    totp_temp_secret CHARACTER VARYING(256) NOT NULL
);

CREATE TABLE IF NOT EXISTS image_model (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    uuid_filename TEXT NOT NULL,
    create_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user_model(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS layer_model (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    layer_name TEXT NOT NULL,
    is_master BOOLEAN DEFAULT FALSE NOT NULL,
    create_at TEXT NOT NULL,
    update_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user_model(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS marker_info_model (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    layer_id TEXT NOT NULL,
    marker_name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    detail CHARACTER VARYING NOT NULL,
    create_at TEXT NOT NULL,
    update_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user_model(id) ON DELETE CASCADE,
    FOREIGN KEY (layer_id) REFERENCES layer_model(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS tileserver_model (
    id INTEGER PRIMARY KEY NOT NULL,
    layer_name CHARACTER VARYING(255) NOT NULL,
    label CHARACTER VARYING(255) NOT NULL,
    url CHARACTER VARYING(255) NOT NULL,
    attribution CHARACTER VARYING(255) NOT NULL,
    include_foreign_tiles BOOLEAN DEFAULT FALSE NOT NULL,
    min_zoom INTEGER,
    max_zoom INTEGER,
    create_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS temporary_urls (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    expiration TEXT NOT NULL,
    layers TEXT NOT NULL,
    markers TEXT NOT NULL,
    shapes TEXT NOT NULL DEFAULT '{}',
    create_at TEXT NOT NULL,
    password_hash CHARACTER VARYING(256)
);

CREATE TABLE IF NOT EXISTS application_settings (
    id TEXT PRIMARY KEY NOT NULL,
    setting_key VARCHAR(255) NOT NULL UNIQUE,
    setting_value VARCHAR(255) NOT NULL,
    description TEXT,
    create_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shape_model (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT,
    shape_type CHARACTER VARYING(32) NOT NULL,
    geojson TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    layer_id TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user_model(id) ON DELETE CASCADE,
    FOREIGN KEY (layer_id) REFERENCES layer_model(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shape_model_user_layer
ON shape_model(user_id, layer_id);
