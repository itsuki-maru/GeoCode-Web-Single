use crate::{
    error::AppError,
    tile_upstream::{PublicDns, is_public_ip},
};
use reqwest::{Client, Url, redirect::Policy};
use std::{net::IpAddr, sync::Arc, time::Duration};

const MAX_BASE_URL_BYTES: usize = 4096;

pub(super) struct UpstreamPolicy {
    allowed_origins: Vec<String>,
    public_client: Client,
    allowed_client: Client,
}

impl UpstreamPolicy {
    pub(super) fn from_env() -> Self {
        Self::new(std::env::var("OSRM_ALLOWED_ORIGINS").ok().as_deref())
    }

    pub(super) fn new(origins: Option<&str>) -> Self {
        Self::with_timeout(origins, Duration::from_secs(10))
    }

    pub(super) fn with_timeout(origins: Option<&str>, timeout: Duration) -> Self {
        let allowed_origins = origins
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .filter_map(|entry| match Url::parse(entry) {
                Ok(url)
                    if matches!(url.scheme(), "http" | "https")
                        && url.port() != Some(0)
                        && url.origin().ascii_serialization() == entry =>
                {
                    Some(entry.to_owned())
                },
                _ => {
                    tracing::warn!("Ignoring invalid OSRM_ALLOWED_ORIGINS entry");
                    None
                },
            })
            .collect();
        let client = || {
            Client::builder()
                .no_proxy()
                .redirect(Policy::none())
                .connect_timeout(Duration::from_secs(3))
                .timeout(timeout)
        };
        Self {
            allowed_origins,
            public_client: client()
                .dns_resolver(Arc::new(PublicDns))
                .build()
                .expect("OSRM public HTTP client"),
            allowed_client: client().build().expect("OSRM allowed HTTP client"),
        }
    }

    pub(super) fn validate_base_url(&self, raw: &str) -> Result<Url, AppError> {
        let raw = raw.trim();
        if raw.len() > MAX_BASE_URL_BYTES
            || raw.contains('\\')
            || raw.chars().any(char::is_control)
            || !raw.split_once("://").is_some_and(|(scheme, rest)| {
                (scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
                    && rest
                        .split(['/', '?', '#'])
                        .next()
                        .is_some_and(|authority| !authority.is_empty() && !authority.contains('@'))
            })
        {
            return Err(invalid_url());
        }
        let mut url = Url::parse(raw).map_err(|_| invalid_url())?;
        // 旧環境変数で使った正規化を保ち、同じ接続先に結び付いた暗号文を再利用する。
        url.path_segments_mut()
            .map_err(|_| invalid_url())?
            .pop_if_empty();
        self.client(&url)?;
        Ok(url)
    }

    pub(super) fn client(&self, endpoint: &Url) -> Result<&Client, AppError> {
        let host = endpoint.host_str().ok_or_else(invalid_url)?;
        if endpoint.as_str().len() > MAX_BASE_URL_BYTES
            || !matches!(endpoint.scheme(), "http" | "https")
            || endpoint.port() == Some(0)
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(invalid_url());
        }

        if self
            .allowed_origins
            .contains(&endpoint.origin().ascii_serialization())
        {
            return Ok(&self.allowed_client);
        }

        let host = host.trim_matches(['[', ']']).trim_end_matches('.');
        if endpoint.scheme() != "https"
            || host.eq_ignore_ascii_case("localhost")
            || host.parse::<IpAddr>().is_ok_and(|ip| !is_public_ip(ip))
        {
            return Err(AppError::Validation(
                "HTTPまたは非公開のOSRM接続先は、サーバーのOSRM_ALLOWED_ORIGINSで許可してください。"
                    .into(),
            ));
        }

        Ok(&self.public_client)
    }
}

fn invalid_url() -> AppError {
    AppError::Validation(
        "認証情報、クエリ、フラグメントを含まないHTTP(S)のOSRMベースURLを入力してください。".into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_legacy_endpoint_normalization_for_api_key_scope() {
        let policy = UpstreamPolicy::new(Some("http://osrm-drive:5000"));
        assert_eq!(
            policy
                .validate_base_url(" HTTP://OSRM-DRIVE:5000/routed-car/ ")
                .unwrap()
                .as_str(),
            "http://osrm-drive:5000/routed-car"
        );
        assert_eq!(
            policy
                .validate_base_url("https://example.com:443/routed-car//")
                .unwrap()
                .as_str(),
            "https://example.com/routed-car/"
        );
    }

    #[test]
    fn rejects_ambiguous_urls_even_for_an_allowed_origin() {
        let policy = UpstreamPolicy::new(Some("http://osrm-drive:5000"));
        for invalid in [
            "http:osrm-drive:5000",
            "http:///osrm-drive:5000",
            "http://user@osrm-drive:5000/",
            "http://@osrm-drive:5000/",
            "http://osrm-drive:5000/route?key=fixture",
            "http://osrm-drive:5000/route#fragment",
            "http://osrm-drive:5000\\route",
            "http://osrm-drive:5000/a\nb",
            "https://example.com:0/",
            &format!("https://example.com/{}", "a".repeat(MAX_BASE_URL_BYTES)),
        ] {
            assert!(policy.validate_base_url(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn only_an_exact_allowed_origin_can_use_an_unrestricted_connection() {
        let policy = UpstreamPolicy::new(Some(
            "http://osrm-drive:5000, http://127.0.0.1:5000, http://osrm-drive:5001/path",
        ));
        for allowed in ["http://osrm-drive:5000/car", "http://127.0.0.1:5000/foot"] {
            let url = policy.validate_base_url(allowed).unwrap();
            assert!(std::ptr::eq(
                policy.client(&url).unwrap(),
                &policy.allowed_client
            ));
        }
        for denied in [
            "http://osrm-drive:5001",
            "http://osrm-drive.example:5000",
            "https://127.0.0.1:5000",
            "https://[::ffff:127.0.0.1]:5000",
            "https://localhost.",
        ] {
            assert!(policy.validate_base_url(denied).is_err(), "{denied}");
        }
        let public = policy
            .validate_base_url("https://example.com/osrm")
            .unwrap();
        assert!(std::ptr::eq(
            policy.client(&public).unwrap(),
            &policy.public_client
        ));
    }
}
