//! ビルド来歴から独立した、取り込み・描画の互換性契約と安定した識別計算。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    style::{STYLE_VERSION, Style},
    tile::TILE_SIZE,
};

/// 取り込み結果の形状・属性・LODが変わる変更時に更新する。
pub const IMPORT_COMPATIBILITY_VERSION: &str = "roads-import-geometry-lod-v1";
pub const IDENTITY_VERSION: u32 = 2;

/// 画像の圧縮バイト列ではなく、画素・寸法・色とアルファの解釈を識別する。
/// 版番号は、対応する処理の結果を変える変更を採用したときだけ更新する。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenderContract {
    pub identity_version: u32,
    pub schema_version: u32,
    pub geometry_version: u32,
    pub renderer_revision: u32,
    pub reader_revision: u32,
    pub coordinate_revision: u32,
    pub image_revision: u32,
    pub execution_series: String,
    pub style_version: String,
    pub style_hash: String,
    pub tile_size: u32,
    pub pixel_format: String,
    pub color_space: String,
    pub alpha_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_spec: Option<super::render_spec::RenderSpec>,
}

impl RenderContract {
    /// 実際に読む形式だけで契約を決め、対応形式の一覧追加では既存契約を変えない。
    pub fn for_format(schema_version: u32, geometry_version: u32) -> Option<Self> {
        if (schema_version, geometry_version) == (3, 2) {
            return Self::for_spec(
                schema_version,
                geometry_version,
                super::render_spec::RenderSpec::osm_like(),
            );
        }
        if (schema_version, geometry_version) == (2, 2) {
            return Some(Self {
                identity_version: 3,
                schema_version,
                geometry_version,
                renderer_revision: 1,
                reader_revision: 1,
                coordinate_revision: 1,
                image_revision: 1,
                execution_series: "standard-terrain-soft-math-v1".into(),
                style_version: "standard-terrain-v1".into(),
                style_hash: super::standard::paint::style_hash(),
                tile_size: TILE_SIZE,
                pixel_format: "rgba8".into(),
                color_space: "srgb".into(),
                alpha_mode: "straight-opaque".into(),
                render_spec: None,
            });
        }
        if (schema_version, geometry_version) != (1, 1) {
            return None;
        }
        Some(Self {
            identity_version: IDENTITY_VERSION,
            schema_version,
            geometry_version,
            renderer_revision: 1,
            reader_revision: 1,
            coordinate_revision: 1,
            image_revision: 1,
            execution_series: "roads-soft-math-raster-v1".into(),
            style_version: STYLE_VERSION.into(),
            style_hash: Style::roads_v1().hash(),
            tile_size: TILE_SIZE,
            pixel_format: "rgba8".into(),
            color_space: "srgb".into(),
            alpha_mode: "straight-opaque".into(),
            render_spec: None,
        })
    }

    pub fn for_spec(
        schema_version: u32,
        geometry_version: u32,
        spec: super::render_spec::RenderSpec,
    ) -> Option<Self> {
        if (schema_version, geometry_version) != (3, 2) || spec.validate().is_err() {
            return None;
        }
        let spec = spec.normalized();
        Some(Self {
            identity_version: 4,
            schema_version,
            geometry_version,
            renderer_revision: 1,
            reader_revision: 1,
            coordinate_revision: 1,
            image_revision: 1,
            execution_series: "osm-label-soft-math-v1".into(),
            style_version: "osm-like-v1".into(),
            style_hash: spec.hash(),
            tile_size: TILE_SIZE,
            pixel_format: "rgba8".into(),
            color_space: "srgb".into(),
            alpha_mode: "straight-opaque".into(),
            render_spec: Some(spec),
        })
    }

    /// フィールド順・整数形式・文字列長を固定し、JSON整形やビルド環境に依存させない。
    pub fn id(&self) -> String {
        let mut hash = IdentityHasher::new(match self.identity_version {
            2 => "geocode-render-contract-v2",
            3 => "geocode-render-contract-v3",
            _ => "geocode-render-contract-v4",
        });
        for value in [
            self.identity_version,
            self.schema_version,
            self.geometry_version,
            self.renderer_revision,
            self.reader_revision,
            self.coordinate_revision,
            self.image_revision,
            self.tile_size,
        ] {
            hash.u32(value);
        }
        for value in [
            &self.execution_series,
            &self.style_version,
            &self.style_hash,
            &self.pixel_format,
            &self.color_space,
            &self.alpha_mode,
        ] {
            hash.text(value);
        }
        if self.identity_version == 4 {
            hash.text(&self.render_spec.map(|spec| spec.hash()).unwrap_or_default());
        }
        hash.finish()
    }
}

/// データセットと描画契約から、公開URLと保存ディレクトリに使う世代を得る。
pub fn render_id(dataset_id: &str, contract: &RenderContract) -> String {
    let mut hash = IdentityHasher::new(match contract.identity_version {
        2 => "geocode-local-render-v2",
        3 => "geocode-local-render-v3",
        _ => "geocode-local-render-v4",
    });
    hash.text(dataset_id);
    hash.text(&contract.id());
    hash.finish()
}

/// 生成元の製品版・ビルド・保存先を含めず、同じ画像要求に同じキーを返す。
pub fn tile_cache_key(
    dataset_id: &str,
    contract: &RenderContract,
    z: u8,
    x: u32,
    y: u32,
) -> String {
    let mut hash = IdentityHasher::new(match contract.identity_version {
        2 => "geocode-tile-v2",
        3 => "geocode-tile-v3",
        _ => "geocode-tile-v4",
    });
    hash.text(dataset_id);
    hash.text(&contract.id());
    hash.u8(z);
    hash.u32(x);
    hash.u32(y);
    hash.finish()
}

/// 新規完成DBだけに適用する。既存DBの識別やメタデータは再計算・更新しない。
pub fn imported_dataset_id(source_sha256: &str, import_rules_hash: &str) -> String {
    let mut hash = IdentityHasher::new("geocode-dataset-v2");
    hash.text(IMPORT_COMPATIBILITY_VERSION);
    hash.text(source_sha256);
    hash.text(import_rules_hash);
    hash.finish()
}

/// 用途と文字列長を含め、数値はリトルエンディアンで直列化する。
pub(crate) struct IdentityHasher(Sha256);

impl IdentityHasher {
    pub(crate) fn new(domain: &str) -> Self {
        let mut value = Self(Sha256::new());
        value.text(domain);
        value
    }
    pub(crate) fn text(&mut self, text: &str) {
        self.0.update((text.len() as u64).to_le_bytes());
        self.0.update(text.as_bytes());
    }
    pub(crate) fn bytes(&mut self, bytes: &[u8]) {
        self.0.update((bytes.len() as u64).to_le_bytes());
        self.0.update(bytes);
    }
    pub(crate) fn u8(&mut self, value: u8) {
        self.0.update([value]);
    }
    pub(crate) fn u32(&mut self, value: u32) {
        self.0.update(value.to_le_bytes());
    }
    pub(crate) fn f32(&mut self, value: f32) {
        self.u32(value.to_bits());
    }
    pub(crate) fn finish(self) -> String {
        format!("{:x}", self.0.finalize())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 識別は描画契約と入力だけを追跡しビルド来歴を受け取らない() {
        let contract = RenderContract::for_format(1, 1).unwrap();
        assert_eq!(
            contract.id(),
            "7c68847da1551594c29c3c95e2e379fc78ce36f8f3e1b4dee868a39fff187207"
        );
        let same: RenderContract =
            serde_json::from_str(&serde_json::to_string_pretty(&contract).unwrap()).unwrap();
        assert_eq!(contract.id(), same.id());
        assert_eq!(render_id("dataset", &contract), render_id("dataset", &same));
        assert_eq!(
            render_id("dataset", &contract),
            "6893c10433dd91b581571a88a7c0a2b1601034f98986300289f6602e7d2ecfb1"
        );
        assert_eq!(
            tile_cache_key("dataset", &contract, 14, 10, 20),
            tile_cache_key("dataset", &same, 14, 10, 20)
        );
        assert_eq!(
            tile_cache_key("dataset", &contract, 14, 10, 20),
            "88043be15c3518375c376a349082b5cb5bbd17ba5f64d790155ea807d8616f38"
        );
        assert_ne!(
            tile_cache_key("dataset", &contract, 14, 10, 20),
            tile_cache_key("dataset", &contract, 14, 10, 21)
        );
        assert_ne!(
            render_id("dataset", &contract),
            render_id("another", &contract)
        );
        let mut changed = contract.clone();
        changed.renderer_revision += 1;
        assert_ne!(contract.id(), changed.id());
        assert_ne!(
            render_id("dataset", &contract),
            render_id("dataset", &changed)
        );
        assert!(RenderContract::for_format(2, 1).is_none());
    }

    #[test]
    fn 新規完成dbの識別は入力内容と取り込み条件で決まる() {
        let expected = imported_dataset_id("source", "rules");
        assert_eq!(
            expected,
            "fcb1e1df1ff3840da981a95a873b923561f3de0b8a5c79f09ae400e494342a4b"
        );
        assert_ne!(expected, imported_dataset_id("source-2", "rules"));
        assert_ne!(expected, imported_dataset_id("source", "rules-2"));
        assert_eq!(expected.len(), 64);
    }
}
