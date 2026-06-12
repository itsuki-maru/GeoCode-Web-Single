CREATE INDEX IF NOT EXISTS idx_marker_info_user_layer
ON marker_info_model(user_id, layer_id);

CREATE INDEX IF NOT EXISTS idx_marker_info_layer_id
ON marker_info_model(layer_id);

CREATE INDEX IF NOT EXISTS idx_layer_model_user_master
ON layer_model(user_id, is_master);

CREATE INDEX IF NOT EXISTS idx_image_model_user_id_desc
ON image_model(user_id, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_image_model_uuid_filename
ON image_model(uuid_filename);

CREATE INDEX IF NOT EXISTS idx_temporary_urls_user_create_desc
ON temporary_urls(user_id, create_at DESC);

CREATE INDEX IF NOT EXISTS idx_shape_model_layer_id
ON shape_model(layer_id);
