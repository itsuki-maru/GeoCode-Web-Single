ALTER TABLE live_map ADD COLUMN layers_configured_by TEXT REFERENCES user_model(id) ON DELETE SET NULL;

CREATE TABLE live_map_layer (
    map_id TEXT NOT NULL REFERENCES live_map(id) ON DELETE CASCADE,
    layer_id TEXT NOT NULL REFERENCES layer_model(id) ON DELETE CASCADE,
    PRIMARY KEY (map_id, layer_id)
);
CREATE INDEX live_map_layer_layer_id_idx ON live_map_layer(layer_id);
