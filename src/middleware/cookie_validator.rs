use crate::auth::verify_access_token;
use crate::middleware::{extract_cookie_value, token_is_active};
use axum::{
    body::Body,
    http::{Request, Response, StatusCode},
};
use serde_json::json;
use sqlx::SqlitePool;
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

    fn call(&mut self, mut req: Request<B>) -> Self::Future {
        let mut inner = self.inner.clone();
        Box::pin(async move {
            let token = extract_cookie_value(req.headers(), "access_token").unwrap_or("");
            if let Ok(claims) = verify_access_token(token) {
                if let Some(pool) = req.extensions().get::<SqlitePool>().cloned() {
                    if token_is_active(&pool, &claims.sub, claims.auth_version).await {
                        req.extensions_mut().insert(claims.sub);
                        return inner.call(req).await;
                    }
                }
            }

            Ok(Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .header("Content-Type", "application/json")
                .body(Body::from(json!({ "error": "token_expired" }).to_string()))
                .expect("valid unauthorized response"))
        })
    }
}
