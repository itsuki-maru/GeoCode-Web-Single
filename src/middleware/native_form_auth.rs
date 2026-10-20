//! iframeへのフォーム送信に限り、認証失敗を親へ通知する。認証判定はCookieValidatorのまま。
use axum::{
    body::to_bytes,
    extract::{Query, Request},
    http::{StatusCode, header},
    middleware::Next,
    response::{Html, IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Notification {
    native_request_id: String,
    native_parent_origin: String,
}

pub async fn notify_auth_error(request: Request, next: Next) -> Response {
    let notification = Query::<Notification>::try_from_uri(request.uri())
        .ok()
        .map(|q| q.0);
    let response = next.run(request).await;
    let Some(n) = notification.filter(|n| {
        !n.native_request_id.is_empty()
            && n.native_request_id.len() <= 128
            && n.native_request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            && reqwest::Url::parse(&n.native_parent_origin).is_ok_and(|u| {
                matches!(u.scheme(), "http" | "https")
                    && u.origin().ascii_serialization() == n.native_parent_origin
            })
    }) else {
        return response;
    };
    if response.status() != StatusCode::UNAUTHORIZED {
        return response;
    }
    let (parts, body) = response.into_parts();
    let Ok(bytes) = to_bytes(body, 4096).await else {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    };
    let error = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string));
    if error.as_deref() != Some("token_expired") {
        return Response::from_parts(parts, bytes.into());
    }
    let encode = |value: Value| {
        value
            .to_string()
            .replace('<', "\\u003c")
            .replace('>', "\\u003e")
            .replace('&', "\\u0026")
    };
    let data = encode(
        json!({"type":"native-form-auth-error","requestId":n.native_request_id,"error":"token_expired"}),
    );
    let origin = encode(json!(n.native_parent_origin));
    (StatusCode::UNAUTHORIZED, [(header::CACHE_CONTROL, "no-store")],
        Html(format!("<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\"><title>認証の確認</title><p>認証を確認しています。</p><script>window.parent.postMessage({data},{origin});</script></html>"))).into_response()
}
