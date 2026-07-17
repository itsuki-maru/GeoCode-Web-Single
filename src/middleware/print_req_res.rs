use axum::{extract::Request, middleware::Next, response::Response};
use std::time::Instant;
use tracing::info;

pub async fn print_request_response(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let started_at = Instant::now();

    let res = next.run(req).await;
    let status = res.status();
    let elapsed_ms = started_at.elapsed().as_millis();
    info!(%method, %uri, %status, elapsed_ms, "request completed");
    res
}
