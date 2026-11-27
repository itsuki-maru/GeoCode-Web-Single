use axum::{extract::Request, http::Uri, middleware::Next, response::Response};
use std::time::Instant;
use tracing::info;

fn logged_uri(uri: &Uri) -> String {
    // 経路検索は座標をパスに含む。認証や入力検証に失敗した要求もマスクする。
    if uri.path() == "/local-routing" || uri.path().starts_with("/local-routing/") {
        "/local-routing/[route]".to_owned()
    } else {
        uri.to_string()
    }
}

pub async fn print_request_response(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let uri = logged_uri(req.uri());
    let started_at = Instant::now();

    let res = next.run(req).await;
    let status = res.status();
    let elapsed_ms = started_at.elapsed().as_millis();
    info!(%method, %uri, %status, elapsed_ms, "request completed");
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_route_parameters_even_for_unknown_paths() {
        for raw in [
            "/local-routing/car/route/v1/driving/139,35;138,36?radiuses=100;100",
            "/local-routing/unknown/139,35",
            "/local-routing?origin=139,35",
        ] {
            assert_eq!(logged_uri(&raw.parse().unwrap()), "/local-routing/[route]");
        }
        assert_eq!(
            logged_uri(&"/admin/osrm-settings".parse().unwrap()),
            "/admin/osrm-settings"
        );
    }
}
