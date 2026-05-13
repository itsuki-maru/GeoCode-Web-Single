use crate::auth::verify_access_token;
use crate::middleware::extract_cookie_value;
use axum::response::IntoResponse;
use axum::{
    body::Body,
    http::{Request, Response, StatusCode},
};
use serde_json::json;
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};
use tower::{Layer, Service};

#[derive(Clone)]
pub struct CookieValidator;

impl<S> Layer<S> for CookieValidator {
    type Service = CookieValidatorMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        CookieValidatorMiddleware { inner }
    }
}

#[derive(Clone)]
pub struct CookieValidatorMiddleware<S> {
    inner: S,
}

impl<S, B> Service<Request<B>> for CookieValidatorMiddleware<S>
where
    S: Service<Request<B>, Response = Response<Body>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    B: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }
    // リクエストを受け取り、処理を行い、結果を返すメソッド。ここでミドルウェアの主な処理が行う
    fn call(&mut self, req: Request<B>) -> Self::Future {
        let mut inner = self.inner.clone();

        let future = async move {
            let access_token_value = extract_cookie_value(req.headers(), "access_token");

            // アクセストークンを検証し結果に応じてレスポンス
            match verify_access_token(access_token_value.unwrap_or("")) {
                // 成功時はハンドラーからユーザーIDを取り出せるよう設定
                Ok(claims) => {
                    // ユーザーIDをリクエストのExtensionとしてセット
                    let mut req = req;
                    req.extensions_mut().insert(claims.sub);
                    // 内部サービスへのリクエストを続ける
                    return inner.call(req).await;
                },
                // 検証失敗時のレスポンス
                Err(_) => {
                    let response_body = json!({
                        "error": "token_expired"
                    });
                    let response = axum::response::Response::builder()
                        .status(StatusCode::UNAUTHORIZED)
                        .header("Content-Type", "application/json")
                        .body(axum::body::Body::from(response_body.to_string()));
                    match response {
                        Ok(response) => return Ok(response),
                        Err(err) => {
                            tracing::error!("{}", err);
                            let response =
                                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error.")
                                    .into_response();
                            return Ok(response);
                        },
                    }
                },
            }
        };
        Box::pin(future)
    }
}
