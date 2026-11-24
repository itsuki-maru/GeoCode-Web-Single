CREATE TABLE google_routes_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE CHECK (enabled IN (0, 1)),
    requests_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (requests_per_minute BETWEEN 1 AND 3000)
);

INSERT INTO google_routes_settings (id, revision)
VALUES (1, '00000000-0000-0000-0000-000000000000');
