//! 保存済みDBから生成する地図の、不変で正規化された表示設定。

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

use super::identity::IdentityHasher;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LabelLanguage {
    Ja,
    Local,
    En,
}
impl LabelLanguage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ja => "ja",
            Self::Local => "local",
            Self::En => "en",
        }
    }
}
impl std::str::FromStr for LabelLanguage {
    type Err = anyhow::Error;
    fn from_str(value: &str) -> Result<Self> {
        match value {
            "ja" => Ok(Self::Ja),
            "local" => Ok(Self::Local),
            "en" => Ok(Self::En),
            _ => anyhow::bail!("名称の言語はja・local・enを指定してください。"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenderSpec {
    pub revision: u32,
    pub roads: bool,
    pub buildings: bool,
    pub contours: bool,
    pub hillshade: bool,
    pub labels: bool,
    pub language: LabelLanguage,
}
impl RenderSpec {
    pub fn osm_like() -> Self {
        Self {
            revision: 1,
            roads: true,
            buildings: true,
            contours: false,
            hillshade: false,
            labels: true,
            language: LabelLanguage::Ja,
        }
    }
    pub fn validate(self) -> Result<()> {
        ensure!(self.revision == 1, "未対応の描画設定版です。");
        Ok(())
    }
    pub fn normalized(mut self) -> Self {
        if !self.labels {
            self.language = LabelLanguage::Local;
        }
        self
    }
    /// 未使用の言語・フォントは識別へ入れず、表示名や保存先も受け取らない。
    pub fn hash(self) -> String {
        let spec = self.normalized();
        let mut hash = IdentityHasher::new("geocode-osm-render-spec-v1");
        hash.u32(spec.revision);
        for value in [
            spec.roads,
            spec.buildings,
            spec.contours,
            spec.hillshade,
            spec.labels,
        ] {
            hash.u8(u8::from(value));
        }
        hash.text(&super::standard::carto_style::style_hash_for(&spec));
        if spec.labels {
            hash.text(spec.language.as_str());
            hash.text(&super::standard::text::font_hash());
            hash.text(&super::standard::text::layout_hash());
        }
        hash.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 未使用の言語は同じ設定へ正規化し表示変更を区別する() {
        let mut a = RenderSpec::osm_like();
        a.labels = false;
        let mut b = a;
        b.language = LabelLanguage::En;
        assert_eq!(a.hash(), b.hash());
        b.roads = false;
        assert_ne!(a.hash(), b.hash());
        assert_ne!(a.hash(), RenderSpec::osm_like().hash());
    }
}
