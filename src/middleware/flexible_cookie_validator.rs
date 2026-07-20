use crate::auth::verify_access_token;
use crate::middleware::{extract_cookie_value, token_is_active};
use axum::{
    body::Body,
    http::{Request, Response},
};
use sqlx::SqlitePool;
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};
use tower::{Layer, Service};
use uuid::Uuid;

#[derive(Clone)]
pub struct FlexibleCookieValidator;

impl<S> Layer<S> for FlexibleCookieValidator {
    type Service = FlexibleCookieValidatorMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        FlexibleCookieValidatorMiddleware { inner }
    }
}

#[derive(Clone)]
pub struct FlexibleCookieValidatorMiddleware<S> {
    inner: S,
}

impl<S, B> Service<Request<B>> for FlexibleCookieValidatorMiddleware<S>
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
            let mut authenticated_user_id = None;
            if let Ok(claims) = verify_access_token(token) {
                if let Some(pool) = req.extensions().get::<SqlitePool>().cloned() {
                    if token_is_active(&pool, &claims.sub, claims.auth_version).await {
                        authenticated_user_id = Some(claims.sub);
                    }
                }
            }

            req.extensions_mut()
                .insert(authenticated_user_id.unwrap_or_else(|| Uuid::now_v7().to_string()));
            inner.call(req).await
        })
    }
}
