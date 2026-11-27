//! OSRMの接続例外として許可するオリジンを、設定読込と通信で同じ規則で判定する。
use reqwest::Url;

fn entries(value: &str) -> impl Iterator<Item = Result<&str, &'static str>> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(validate_origin)
}

pub(crate) fn validate_origin(entry: &str) -> Result<&str, &'static str> {
    // 許可リスト自体は正規化しない。以前無効だった表記の許可範囲を広げない。
    let valid = !entry.contains(',')
        && Url::parse(entry).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.port() != Some(0)
                && url.origin().ascii_serialization() == entry
        });
    valid
        .then_some(entry)
        .ok_or("パス・認証情報・既定ポートを含まないHTTP(S)のオリジンを小文字で指定してください。")
}

pub(crate) fn validate(value: &str) -> Result<(), String> {
    for entry in entries(value) {
        entry?;
    }
    Ok(())
}

pub(super) fn allowed(value: &str) -> impl Iterator<Item = &str> {
    entries(value).filter_map(|entry| {
        entry
            .inspect_err(|_| tracing::warn!("Ignoring invalid OSRM_ALLOWED_ORIGINS entry"))
            .ok()
    })
}

pub(crate) fn from_legacy(value: &str) -> String {
    allowed(value).collect::<Vec<_>>().join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_existing_comma_separated_origin_format() {
        let value = " , http://127.0.0.1:3000 ,https://[::1]:8443, https://example.com, ";
        assert!(validate(value).is_ok());
        assert_eq!(
            from_legacy(value),
            "http://127.0.0.1:3000,https://[::1]:8443,https://example.com"
        );
        assert!(validate(" , ").is_ok());
        assert!(from_legacy(" , ").is_empty());
    }

    #[test]
    fn explicit_settings_reject_invalid_entries_and_migration_keeps_only_valid_ones() {
        for invalid in [
            "http://localhost/",
            "http://localhost/routing",
            "http://user:fixture-secret@localhost",
            "http://localhost?key=fixture-secret",
            "https://localhost#fragment",
            "http://localhost:80",
            "https://localhost:443",
            "http://localhost:0",
            "HTTP://LOCALHOST",
            "ftp://localhost",
        ] {
            let mixed = format!("http://127.0.0.1:3000,{invalid},https://example.com");
            let error = validate(&mixed).unwrap_err();
            assert!(!error.contains(invalid) && !error.contains("fixture-secret"));
            assert_eq!(
                from_legacy(&mixed),
                "http://127.0.0.1:3000,https://example.com"
            );
        }
    }
}
