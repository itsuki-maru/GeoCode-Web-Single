-- 映像は保存せず、接続情報だけを保持する。配信IDは再利用しない。
CREATE TABLE live_camera_session (
    id BLOB PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES user_model(id) ON DELETE CASCADE,
    location_session_id TEXT NOT NULL,
    expires_at TEXT NOT NULL DEFAULT (datetime('now','+15 seconds')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX live_camera_session_owner ON live_camera_session(user_id);
CREATE INDEX live_camera_session_expiry ON live_camera_session(expires_at);
CREATE TABLE live_camera_viewer (
    id BLOB PRIMARY KEY NOT NULL,
    camera_id BLOB NOT NULL REFERENCES live_camera_session(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES live_map_member(id) ON DELETE CASCADE,
    access_version INTEGER NOT NULL,
    key_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL DEFAULT (datetime('now','+15 seconds'))
);
CREATE INDEX live_camera_viewer_camera ON live_camera_viewer(camera_id);
CREATE TABLE live_camera_signal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id BLOB NOT NULL,
    viewer_id BLOB NOT NULL REFERENCES live_camera_viewer(id) ON DELETE CASCADE,
    to_publisher BOOLEAN NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('offer', 'answer', 'ice')),
    data TEXT NOT NULL,
    UNIQUE(viewer_id, to_publisher, message_id)
);
CREATE INDEX live_camera_signal_inbox ON live_camera_signal(viewer_id, to_publisher, id);
-- 接続情報の交換は各視聴IDで一度だけ行い、再接続時は新しい視聴IDを使用する。
CREATE UNIQUE INDEX live_camera_signal_description ON live_camera_signal(viewer_id, kind)
WHERE kind IN ('offer', 'answer');

ALTER TABLE live_camera_viewer ADD COLUMN failed BOOLEAN NOT NULL DEFAULT false;
