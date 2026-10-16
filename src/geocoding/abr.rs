// ABR の OpenAPI 3.0.22 にある /geocode（FeatureCollection）に対応し、バージョン 2 には対応しない。
use super::{Geometry, SearchResult, result};
use crate::error::AppError;
use reqwest::Url;
use serde::Deserialize;

pub(super) fn query(url: &mut Url, address: &str) {
    url.query_pairs_mut()
        .append_pair("address", address)
        .append_pair("limit", "5");
}

#[derive(Deserialize)]
struct Response {
    features: Vec<Feature>,
}
#[derive(Deserialize)]
struct Feature {
    geometry: Option<Geometry>,
    properties: Properties,
}
#[derive(Deserialize)]
struct Properties {
    matched_address: String,
    match_level: String,
}

pub(super) fn parse(bytes: &[u8]) -> Result<Vec<SearchResult>, AppError> {
    let response: Response = serde_json::from_slice(bytes).map_err(|_| AppError::BadGateway)?;
    Ok(response
        .features
        .into_iter()
        .filter(|feature| feature.properties.match_level != "unknown")
        .filter_map(|feature| result(feature.geometry, feature.properties.matched_address))
        .collect())
}
