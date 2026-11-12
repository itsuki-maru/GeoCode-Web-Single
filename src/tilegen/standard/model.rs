//! 新形式だけで使用する地物・入力・取り込み条件。

use crate::tilegen::{geometry::Point, import::ImportOptions};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(i64)]
pub enum FeatureKind {
    Land = 1,
    Forest = 10,
    Grass = 20,
    Park = 30,
    Farmland = 40,
    Residential = 50,
    Commercial = 60,
    Industrial = 70,
    Sand = 80,
    BareRock = 90,
    Wetland = 100,
    Water = 110,
    Building = 120,
    Waterway = 130,
    Railway = 140,
    Contour = 150,
}
impl FeatureKind {
    pub fn from_code(code: i64) -> Result<Self> {
        Ok(match code {
            1 => Self::Land,
            10 => Self::Forest,
            20 => Self::Grass,
            30 => Self::Park,
            40 => Self::Farmland,
            50 => Self::Residential,
            60 => Self::Commercial,
            70 => Self::Industrial,
            80 => Self::Sand,
            90 => Self::BareRock,
            100 => Self::Wetland,
            110 => Self::Water,
            120 => Self::Building,
            130 => Self::Waterway,
            140 => Self::Railway,
            150 => Self::Contour,
            _ => bail!("未対応の地物分類: {code}"),
        })
    }
    pub fn min_zoom(self) -> u8 {
        match self {
            Self::Land => 0,
            Self::Forest | Self::Water => 6,
            Self::Building => 14,
            Self::Waterway => 11,
            Self::Railway => 9,
            Self::Contour => 10,
            _ => 10,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolygonPart {
    pub outer: Vec<Point>,
    pub holes: Vec<Vec<Point>>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Geometry {
    Line(Vec<Point>),
    Polygon(Vec<PolygonPart>),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Feature {
    pub osm_type: i64,
    pub osm_id: i64,
    pub role: i64,
    pub kind: FeatureKind,
    pub geometry: Geometry,
    pub layer: i16,
    pub structure: u8,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceInfo {
    pub kind: String,
    pub sha256: String,
    pub bytes: u64,
    pub details: serde_json::Value,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StandardMetadata {
    pub revision: u32,
    pub counts: BTreeMap<String, u64>,
    pub skipped_areas: BTreeMap<String, u64>,
    pub sources: Vec<SourceInfo>,
    pub elevation: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<DatasetCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<LabelMetadata>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetCapabilities {
    pub labels: bool,
    pub contours: bool,
    pub elevation: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelMetadata {
    pub revision: u32,
    pub count: u64,
    pub categories: BTreeMap<String, u64>,
    pub skipped: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum StandardFeatureSet {
    #[default]
    #[serde(rename = "standard-v1")]
    StandardV1,
    #[serde(rename = "standard-v2")]
    StandardV2,
}
impl StandardFeatureSet {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StandardV1 => "standard-v1",
            Self::StandardV2 => "standard-v2",
        }
    }
    pub fn schema(self) -> u32 {
        if self == Self::StandardV2 { 3 } else { 2 }
    }
}
impl std::str::FromStr for StandardFeatureSet {
    type Err = anyhow::Error;
    fn from_str(value: &str) -> Result<Self> {
        match value {
            "standard-v1" => Ok(Self::StandardV1),
            "standard-v2" => Ok(Self::StandardV2),
            _ => bail!("標準形式はstandard-v1またはstandard-v2を指定してください"),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContourData {
    #[default]
    On,
    Off,
}
impl ContourData {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::On => "on",
            Self::Off => "off",
        }
    }
}
impl std::str::FromStr for ContourData {
    type Err = anyhow::Error;
    fn from_str(value: &str) -> Result<Self> {
        match value {
            "on" => Ok(Self::On),
            "off" => Ok(Self::Off),
            _ => bail!("contour-dataはonまたはoffを指定してください"),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InvalidAreas {
    Error,
    SkipFeature,
}
impl InvalidAreas {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::SkipFeature => "skip-feature",
        }
    }
}

/// 原資料の測地系を識別し、座標値の補正とは区別して保持する。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ElevationCrs {
    #[serde(rename = "fguuid:jgd2000.bl")]
    Jgd2000,
    #[serde(rename = "fguuid:jgd2011.bl")]
    Jgd2011,
    #[serde(rename = "fguuid:jgd2024.bl")]
    Jgd2024,
}
impl ElevationCrs {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jgd2000 => "fguuid:jgd2000.bl",
            Self::Jgd2011 => "fguuid:jgd2011.bl",
            Self::Jgd2024 => "fguuid:jgd2024.bl",
        }
    }
}
impl std::str::FromStr for ElevationCrs {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "fguuid:jgd2000.bl" => Ok(Self::Jgd2000),
            "fguuid:jgd2011.bl" => Ok(Self::Jgd2011),
            "fguuid:jgd2024.bl" => Ok(Self::Jgd2024),
            _ => Err(UnknownElevationCrs(value.to_owned()).into()),
        }
    }
}

#[derive(Debug)]
pub(crate) struct UnknownElevationCrs(pub String);
impl std::fmt::Display for UnknownElevationCrs {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "未対応のDEM座標参照系です: {}", self.0)
    }
}
impl std::error::Error for UnknownElevationCrs {}

/// 混在資料を原座標・原標高で併用する場合だけ、明示的に許可する。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ElevationDatumPolicy {
    #[default]
    #[serde(rename = "strict")]
    Strict,
    #[serde(rename = "allow-jgd2000-2011")]
    AllowJgd20002011,
}
impl ElevationDatumPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Strict => "strict",
            Self::AllowJgd20002011 => "allow-jgd2000-2011",
        }
    }
}
impl std::str::FromStr for ElevationDatumPolicy {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "strict" => Ok(Self::Strict),
            "allow-jgd2000-2011" => Ok(Self::AllowJgd20002011),
            _ => {
                bail!("elevation_datum_policyはstrictまたはallow-jgd2000-2011を指定してください。")
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct StandardImportOptions {
    pub base: ImportOptions,
    pub elevation_input: Option<PathBuf>,
    pub elevation_datum_policy: ElevationDatumPolicy,
    pub landmask_input: Option<PathBuf>,
    pub invalid_areas: InvalidAreas,
    pub feature_set: StandardFeatureSet,
    pub contour_data: ContourData,
}
