mod abr;
mod csis;
mod gsi;

use crate::error::AppError;
use reqwest::{Client, Url, header::HeaderValue};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Copy)]
pub enum Provider {
    Gsi,
    Abr,
    Csis,
}

pub struct GeocoderConfig {
    provider: Provider,
    url: Url,
    api_key: Option<HeaderValue>,
}

impl GeocoderConfig {
    pub fn from_values(
        provider: Option<&str>,
        url: Option<&str>,
        key: Option<&str>,
    ) -> Result<Self, &'static str> {
        let nonempty = |s: &str| !s.trim().is_empty();
        let provider = match provider
            .map(str::trim)
            .filter(|s| nonempty(s))
            .unwrap_or("csis")
        {
            "gsi" => Provider::Gsi,
            "abr" => Provider::Abr,
            "csis" => Provider::Csis,
            _ => return Err("GEOCODER_PROVIDER must be gsi, abr or csis"),
        };
        let url = match url.map(str::trim).filter(|s| nonempty(s)) {
            Some(url) => url,
            None if matches!(provider, Provider::Gsi) => {
                "https://msearch.gsi.go.jp/address-search/AddressSearch"
            },
            None if matches!(provider, Provider::Csis) => {
                "https://geocode.csis.u-tokyo.ac.jp/cgi-bin/simple_geocode.cgi"
            },
            None => return Err("GEOCODER_URL is required for abr"),
        };
        let url = Url::parse(url).map_err(|_| "GEOCODER_URL must be an absolute HTTP(S) URL")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("GEOCODER_URL must be HTTP(S), without credentials or a fragment");
        }
        let api_key = key
            .filter(|s| nonempty(s))
            .map(|key| {
                let mut value =
                    HeaderValue::from_str(key).map_err(|_| "Invalid GEOCODER_API_KEY header")?;
                value.set_sensitive(true);
                Ok::<HeaderValue, &'static str>(value)
            })
            .transpose()?;
        Ok(Self {
            provider,
            url,
            api_key,
        })
    }

    pub fn uses_csis(&self) -> bool {
        matches!(self.provider, Provider::Csis)
    }

    pub fn client() -> Client {
        Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("Failed to create geocoder client")
    }

    pub async fn search(
        &self,
        client: &Client,
        address: &str,
    ) -> Result<Vec<SearchResult>, AppError> {
        let mut url = self.url.clone();
        // Preserve operator-supplied options, replacing search parameters only.
        let names: &[&str] = match self.provider {
            Provider::Gsi => &["q"],
            Provider::Abr => &["address", "limit"],
            Provider::Csis => &["addr", "charset", "series"],
        };
        let options: Vec<_> = url
            .query_pairs()
            .filter(|(key, _)| !names.contains(&key.as_ref()))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        url.set_query(None);
        url.query_pairs_mut().extend_pairs(options);
        match self.provider {
            Provider::Gsi => gsi::query(&mut url, address),
            Provider::Abr => abr::query(&mut url, address),
            Provider::Csis => csis::query(&mut url, address),
        }
        let mut request = client.get(url);
        if let Some(key) = &self.api_key {
            request = request.header("X-API-Key", key);
        }
        let mut response = request.send().await.map_err(|_| AppError::BadGateway)?;
        if !response.status().is_success() {
            return Err(AppError::BadGateway);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| AppError::BadGateway)? {
            if bytes.len() + chunk.len() > 1024 * 1024 {
                return Err(AppError::BadGateway);
            }
            bytes.extend_from_slice(&chunk);
        }
        match self.provider {
            Provider::Gsi => gsi::parse(&bytes),
            Provider::Abr => abr::parse(&bytes),
            Provider::Csis => csis::parse(&bytes),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub address: String,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Deserialize)]
struct Geometry {
    #[serde(rename = "type")]
    kind: String,
    coordinates: Vec<f64>,
}

fn result(geometry: Option<Geometry>, address: String) -> Option<SearchResult> {
    let geometry = geometry?;
    if geometry.kind != "Point" || geometry.coordinates.len() < 2 {
        return None;
    }
    let longitude = geometry.coordinates[0];
    let latitude = geometry.coordinates[1];
    if !(-180.0..=180.0).contains(&longitude) || !(-90.0..=90.0).contains(&latitude) {
        return None;
    }
    Some(SearchResult {
        address,
        latitude,
        longitude,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_configuration_without_revealing_secrets() {
        for provider in [None, Some(""), Some("  "), Some("csis")] {
            let config = GeocoderConfig::from_values(provider, None, None).unwrap();
            assert!(config.uses_csis());
            assert_eq!(
                config.url.as_str(),
                "https://geocode.csis.u-tokyo.ac.jp/cgi-bin/simple_geocode.cgi"
            );
            assert!(config.api_key.is_none());
        }
        let config = GeocoderConfig::from_values(Some("gsi"), None, None).unwrap();
        assert_eq!(
            config.url.as_str(),
            "https://msearch.gsi.go.jp/address-search/AddressSearch"
        );
        assert!(config.api_key.is_none());
        assert!(!config.uses_csis());
        assert!(GeocoderConfig::from_values(Some("abr"), None, None).is_err());
        assert!(GeocoderConfig::from_values(Some("google"), None, None).is_err());
        for url in [
            "file:///etc/passwd",
            "https://user:secret@example.com/",
            "invalid",
        ] {
            assert!(GeocoderConfig::from_values(None, Some(url), None).is_err());
        }
        assert!(GeocoderConfig::from_values(None, None, Some("secret\nheader")).is_err());
    }

    #[test]
    fn provider_responses_preserve_candidates_and_coordinate_order() {
        let gsi = br#"[{"geometry":{"type":"Point","coordinates":[139.7,35.6]},"properties":{"title":"first"}},{"geometry":{"type":"Point","coordinates":[130,30]},"properties":{"title":"second"}}]"#;
        let results = gsi::parse(gsi).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[1].address, "second");
        let result = &results[0];
        assert_eq!(
            (result.address.as_str(), result.latitude, result.longitude),
            ("first", 35.6, 139.7)
        );
        let abr = br#"{"features":[{"geometry":{"type":"Point","coordinates":[139.7,35.6]},"properties":{"matched_address":"first","match_level":"machiaza"}}]}"#;
        assert_eq!(abr::parse(abr).unwrap()[0].latitude, 35.6);
        assert!(gsi::parse(b"[]").unwrap().is_empty());
        assert!(abr::parse(br#"{"features":[]}"#).unwrap().is_empty());
        assert!(abr::parse(br#"{"features":[{"geometry":null,"properties":{"matched_address":"","match_level":"unknown"}}]}"#).unwrap().is_empty());
        assert!(gsi::parse(br#"[{"geometry":{"type":"Point","coordinates":[999,35]},"properties":{"title":"bad"}}]"#).unwrap().is_empty());
        assert!(gsi::parse(b"{}").is_err());
        assert!(abr::parse(b"[]").is_err());
    }

    #[tokio::test]
    async fn sends_provider_specific_query_and_server_side_key() {
        use axum::{
            Router,
            http::{HeaderMap, Uri},
            routing::get,
        };
        for provider in ["gsi", "abr", "csis"] {
            let app = Router::new().route(
                "/search",
                get(move |uri: Uri, headers: HeaderMap| async move {
                    assert_eq!(headers.get("x-api-key").unwrap(), "test-secret");
                    let url = Url::parse(&format!("http://localhost{uri}")).unwrap();
                    let pairs: std::collections::HashMap<_, _> =
                        url.query_pairs().into_owned().collect();
                    assert_eq!(
                        pairs
                            .get(match provider {
                                "gsi" => "q",
                                "csis" => "addr",
                                _ => "address",
                            })
                            .unwrap(),
                        "東京都千代田区"
                    );
                    assert_eq!(pairs.get("category").unwrap(), "all");
                    if provider == "abr" {
                        assert_eq!(pairs.get("limit").unwrap(), "5");
                    }
                    if provider == "csis" {
                        assert_eq!(pairs.get("charset").unwrap(), "UTF8");
                        assert_eq!(pairs.get("series").unwrap(), "ADDRESS");
                        assert_eq!(
                            url.query_pairs().filter(|(key, _)| key == "addr").count(),
                            1
                        );
                    }
                    if provider == "gsi" {
                        "[]"
                    } else if provider == "csis" {
                        "<results><geodetic>wgs1984</geodetic></results>"
                    } else {
                        "{\"features\":[]}"
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!(
                "http://{}/search?category=all&addr=old&charset=Shift_JIS&series=GAIKU",
                listener.local_addr().unwrap()
            );
            let task = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let config =
                GeocoderConfig::from_values(Some(provider), Some(&url), Some("test-secret"))
                    .unwrap();
            assert!(
                config
                    .search(&GeocoderConfig::client(), "東京都千代田区")
                    .await
                    .unwrap()
                    .is_empty()
            );
            task.abort();
        }
    }

    #[test]
    fn candidates_without_usable_coordinates_do_not_hide_valid_candidates() {
        let features = serde_json::json!([
            {"geometry":null,"properties":{"title":"missing", "matched_address":"missing", "match_level":"machiaza"}},
            {"geometry":{"type":"Point","coordinates":[139,35]},"properties":{"title":"first", "matched_address":"first", "match_level":"machiaza"}},
            {"geometry":{"type":"Point","coordinates":[999,35]},"properties":{"title":"invalid", "matched_address":"invalid", "match_level":"machiaza"}},
            {"geometry":{"type":"Point","coordinates":[133,34]},"properties":{"title":"second", "matched_address":"second", "match_level":"machiaza"}}
        ]);
        let gsi = gsi::parse(&serde_json::to_vec(&features).unwrap()).unwrap();
        let abr =
            abr::parse(&serde_json::to_vec(&serde_json::json!({"features":features})).unwrap())
                .unwrap();
        for results in [gsi, abr] {
            assert_eq!(
                results
                    .iter()
                    .map(|result| result.address.as_str())
                    .collect::<Vec<_>>(),
                ["first", "second"]
            );
            assert_eq!((results[1].latitude, results[1].longitude), (34.0, 133.0));
        }
    }
}
