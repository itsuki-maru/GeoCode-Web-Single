use crate::{error::AppError, tile_settings::ManagedTileUpstream};
use axum::http::StatusCode;
use image::{ImageFormat, ImageReader, Limits};
use once_cell::sync::Lazy;
use reqwest::{
    Client, Url,
    dns::{Name, Resolve, Resolving},
    redirect::Policy,
};
use std::{
    io::{self, Cursor},
    net::IpAddr,
    sync::Arc,
    time::Duration,
};

pub const TILE_PROXY_MAX_ZOOM: u32 = 19;
const MAX_TILE_BYTES: usize = 4 * 1024 * 1024;

// 運用者はLANのオリジンを明示的に許可できる。管理画面で入力した公開オリジンには、
// HTTPSと、許可されたソケットアドレスを返す名前解決処理を使用する。
static TRUSTED_ORIGINS: Lazy<Vec<String>> = Lazy::new(|| {
    std::env::var("TILE_PROXY_ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| match Url::parse(entry) {
            Ok(url)
                if matches!(url.scheme(), "http" | "https")
                    && url.origin().ascii_serialization() == entry =>
            {
                Some(entry.to_owned())
            },
            _ => {
                tracing::warn!("Ignoring invalid TILE_PROXY_ALLOWED_ORIGINS entry");
                None
            },
        })
        .collect()
});

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => match ip.octets() {
            [0 | 10 | 127 | 224..=255, ..]
            | [100, 64..=127, ..]
            | [169, 254, ..]
            | [172, 16..=31, ..]
            | [192, 168, ..]
            | [192, 0, 0 | 2, _]
            | [192, 88, 99, _]
            | [198, 18 | 19, ..]
            | [198, 51, 100, _]
            | [203, 0, 113, _] => false,
            _ => true,
        },
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_ip(mapped.into());
            }
            let [prefix, second, ..] = ip.segments();
            (0x2000..0x4000).contains(&prefix)
                && prefix != 0x2002
                && prefix != 0x3fff
                && !(prefix == 0x2001 && (second < 0x0200 || second == 0x0db8))
        },
    }
}

struct PublicDns;

impl Resolve for PublicDns {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addresses: Vec<_> = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .filter(|address| is_public_ip(address.ip()))
                .collect();
            if addresses.is_empty() {
                return Err(io::Error::other("Tile upstream has no permitted address").into());
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
}

static PUBLIC_CLIENT: Lazy<Client> = Lazy::new(|| {
    client_builder()
        .dns_resolver(Arc::new(PublicDns))
        .build()
        .expect("managed public tile HTTP client")
});
static TRUSTED_CLIENT: Lazy<Client> = Lazy::new(|| {
    client_builder()
        .build()
        .expect("managed trusted tile HTTP client")
});

pub fn validate_managed_base_url(raw: &str) -> Result<Url, AppError> {
    validate_base_url(raw, &TRUSTED_ORIGINS)
}

fn validate_base_url(raw: &str, trusted: &[String]) -> Result<Url, AppError> {
    let invalid = || {
        AppError::Validation(
            "上流URLにはクエリや認証情報のないHTTPSベースURLを指定してください。".into(),
        )
    };
    if raw.len() > 4096
        || raw.trim() != raw
        || raw.contains('\\')
        || raw.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let mut url = Url::parse(raw).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }

    if !trusted.contains(&url.origin().ascii_serialization()) {
        if url.scheme() != "https" {
            return Err(invalid());
        }
        let host = url
            .host_str()
            .expect("validated URL host")
            .trim_matches(['[', ']']);
        if host.eq_ignore_ascii_case("localhost")
            || host.parse::<IpAddr>().is_ok_and(|ip| !is_public_ip(ip))
        {
            return Err(AppError::Validation(
                "この上流への接続は配備設定で明示的な許可が必要です。".into(),
            ));
        }
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url)
}

pub fn validate_coordinates(z: u32, x: u32, y: u32) -> Result<(), AppError> {
    if z > TILE_PROXY_MAX_ZOOM || x >= 1u32 << z || y >= 1u32 << z {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn fetch_managed_tile(
    upstream: &ManagedTileUpstream,
    z: u32,
    x: u32,
    y: u32,
) -> Result<Vec<u8>, AppError> {
    validate_coordinates(z, x, y)?;
    let mut url = validate_managed_base_url(upstream.base_url.as_str())?;
    let trusted = TRUSTED_ORIGINS.contains(&url.origin().ascii_serialization());
    url.path_segments_mut()
        .map_err(|_| AppError::BadGateway)?
        .pop_if_empty()
        .push(&z.to_string())
        .push(&x.to_string())
        .push(&format!("{y}.png"));
    let client = if trusted {
        &*TRUSTED_CLIENT
    } else {
        &*PUBLIC_CLIENT
    };
    let mut response = client
        .get(url)
        .header("X-API-Key", upstream.api_key.clone())
        .send()
        .await
        .map_err(|_| AppError::BadGateway)?;

    if response.status() == StatusCode::NOT_FOUND {
        return Err(AppError::NotFound);
    }
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_TILE_BYTES as u64)
    {
        return Err(AppError::BadGateway);
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| AppError::BadGateway)? {
        if bytes.len() + chunk.len() > MAX_TILE_BYTES {
            return Err(AppError::BadGateway);
        }
        bytes.extend_from_slice(&chunk);
    }
    tokio::task::spawn_blocking(move || {
        validate_png(&bytes)?;
        Ok(bytes)
    })
    .await
    .map_err(|_| AppError::BadGateway)?
}

fn validate_png(bytes: &[u8]) -> Result<(), AppError> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(2048);
    limits.max_image_height = Some(2048);
    limits.max_alloc = Some(40 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map(|_| ())
        .map_err(|_| AppError::BadGateway)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 認証情報・非公開接続先を制限し、明示的に許可したLAN接続先を受け入れる。
    #[test]
    fn restricts_credentials_and_private_destinations_to_operator_choices() {
        for url in [
            "https://user@tiles.example/",
            "https://tiles.example/?key=test",
            "https://tiles.example/#path",
            "http://tiles.example/",
            "https://127.0.0.1/",
            "https://[::ffff:127.0.0.1]/",
            "https://169.254.169.254/",
            "https://[fd00::1]/",
            "https://tiles.example\\foo",
        ] {
            assert!(validate_base_url(url, &[]).is_err(), "{url}");
        }
        assert_eq!(
            validate_base_url("https://tiles.example/xyz/", &[])
                .unwrap()
                .path(),
            "/xyz"
        );
        let allowed = ["http://127.0.0.1:8100".to_owned()];
        assert!(validate_base_url("http://127.0.0.1:8100/tile", &allowed).is_ok());
        assert!(validate_base_url("http://127.0.0.1:8101/tile", &allowed).is_err());
    }

    /// PNG以外の応答と範囲外のタイル座標を拒否する。
    #[test]
    fn rejects_non_png_and_out_of_range_tiles() {
        assert!(validate_png(b"not an image").is_err());
        assert!(validate_coordinates(19, 1, 1).is_ok());
        assert!(validate_coordinates(20, 0, 0).is_err());
        assert!(validate_coordinates(2, 4, 0).is_err());
    }
}
