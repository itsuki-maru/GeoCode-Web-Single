use crate::config::CONFIG;
use axum::{
    body::Body,
    extract::Request,
    http::{HeaderValue, Method, Response, StatusCode, header},
    middleware::Next,
};

const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self' https://cloudflareinsights.com; manifest-src 'self' https://geocode-web-mobile-app.pages.dev; frame-src 'self' https://www.youtube-nocookie.com; font-src 'self' data: https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'";

pub async fn security_headers_and_origin(req: Request, next: Next) -> Response<Body> {
    if is_state_changing(req.method()) {
        if let Some(origin) = req
            .headers()
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
        {
            let host = req
                .headers()
                .get(header::HOST)
                .and_then(|value| value.to_str().ok());
            if !origin_is_allowed(origin, host) {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(Body::from("Forbidden origin"))
                    .expect("valid forbidden response");
            }
        }
    }

    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert("X-Frame-Options", HeaderValue::from_static("SAMEORIGIN"));
    headers.insert(
        "Permissions-Policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=(self)"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    if CONFIG.secure_cookie {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    response
}

fn is_state_changing(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

fn origin_is_allowed(origin: &str, host: Option<&str>) -> bool {
    let configured = CONFIG
        .allow_origins
        .split(',')
        .map(str::trim)
        .any(|allowed| !allowed.is_empty() && allowed == origin);
    if configured {
        return true;
    }

    let Some(host) = host else {
        return false;
    };
    origin == format!("https://{host}") || origin == format!("http://{host}")
}

#[cfg(test)]
mod tests {
    use super::CONTENT_SECURITY_POLICY;

    #[test]
    fn csp_allows_same_origin_map_frames() {
        assert!(CONTENT_SECURITY_POLICY.contains("frame-src 'self'"));
    }

    #[test]
    fn csp_allows_configured_pwa_manifest_and_cloudflare_insights() {
        assert!(
            CONTENT_SECURITY_POLICY
                .contains("manifest-src 'self' https://geocode-web-mobile-app.pages.dev")
        );
        assert!(
            CONTENT_SECURITY_POLICY.contains(
                "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com"
            )
        );
        assert!(
            CONTENT_SECURITY_POLICY.contains("connect-src 'self' https://cloudflareinsights.com")
        );
    }
}
