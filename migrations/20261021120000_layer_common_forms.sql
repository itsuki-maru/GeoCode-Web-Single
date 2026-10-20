-- 既存のフォーム・回答・公開URL・パスワードは変更しない。
ALTER TABLE common_form_model ADD COLUMN password_hash TEXT;
ALTER TABLE layer_model ADD COLUMN common_form_id TEXT REFERENCES common_form_model(id);
ALTER TABLE layer_model ADD COLUMN common_form_version INTEGER CHECK ((common_form_id IS NULL) = (common_form_version IS NULL));
ALTER TABLE layer_model ADD COLUMN form_binding_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE marker_form_config_model ADD COLUMN managed_layer_id TEXT REFERENCES layer_model(id) ON DELETE SET NULL;
ALTER TABLE shape_form_config_model ADD COLUMN managed_layer_id TEXT REFERENCES layer_model(id) ON DELETE SET NULL;
CREATE INDEX idx_layer_common_form ON layer_model(common_form_id) WHERE common_form_id IS NOT NULL;
CREATE INDEX idx_marker_form_managed_layer ON marker_form_config_model(managed_layer_id) WHERE managed_layer_id IS NOT NULL;
CREATE INDEX idx_shape_form_managed_layer ON shape_form_config_model(managed_layer_id) WHERE managed_layer_id IS NOT NULL;
