use super::{Geometry, SearchResult, result};
use crate::error::AppError;
use reqwest::Url;
use serde::Deserialize;

pub(super) fn query(url: &mut Url, address: &str) {
    url.query_pairs_mut().append_pair("q", address);
}

#[derive(Deserialize)]
struct Feature {
    geometry: Option<Geometry>,
    properties: Properties,
}
#[derive(Deserialize)]
struct Properties {
    title: String,
}

pub(super) fn parse(bytes: &[u8]) -> Result<Vec<SearchResult>, AppError> {
    let features: Vec<Feature> = serde_json::from_slice(bytes).map_err(|_| AppError::BadGateway)?;
    Ok(features
        .into_iter()
        .filter_map(|feature| result(feature.geometry, feature.properties.title))
        .collect())
}
