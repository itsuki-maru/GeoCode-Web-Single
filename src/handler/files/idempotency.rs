//! Successful import receipts are committed atomically with the imported data.
use axum::http::HeaderMap;
use sha2::{Digest, Sha256};
use sqlx::{Executor, Sqlite};
use uuid::Uuid;

use crate::error::AppError;

const HEADER_NAME: &str = "idempotency-key";
const ACCOUNT_HEADER_NAME: &str = "x-import-account";

fn optional_uuid_header(
    headers: &HeaderMap,
    name: &'static str,
    label: &str,
) -> Result<Option<Uuid>, AppError> {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(super::validation::invalid(&format!(
            "{label}は1件だけ指定してください。"
        )));
    }
    let id = value
        .to_str()
        .ok()
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| super::validation::invalid(&format!("{label}はUUIDで指定してください。")))?;
    Ok(Some(id))
}

pub(super) fn verify_account(headers: &HeaderMap, user: &str) -> Result<(), AppError> {
    if optional_uuid_header(headers, ACCOUNT_HEADER_NAME, "X-Import-Account")?
        .is_some_and(|expected| Uuid::parse_str(user).ok() != Some(expected))
    {
        return Err(AppError::ImportAccountConflict);
    }
    Ok(())
}

#[derive(Debug)]
pub(super) struct ImportRequest {
    // SQLite stores UUIDs as TEXT, so normalize accepted UUID spellings before binding.
    id: String,
    payload_sha256: [u8; 32],
}

impl ImportRequest {
    pub(super) fn from_headers(
        headers: &HeaderMap,
        payload: &[u8],
    ) -> Result<Option<Self>, AppError> {
        let Some(id) = optional_uuid_header(headers, HEADER_NAME, "Idempotency-Key")? else {
            return Ok(None);
        };
        Ok(Some(Self {
            id: id.to_string(),
            payload_sha256: Sha256::digest(payload).into(),
        }))
    }

    fn verify_payload(&self, stored_hash: &[u8]) -> Result<(), AppError> {
        if self.payload_sha256.as_slice() != stored_hash {
            return Err(AppError::IdempotencyConflict);
        }
        Ok(())
    }
}

/// Recheck after BEGIN IMMEDIATE has acquired the writer before inserting import data.
pub(super) async fn is_completed<'e, E>(
    executor: E,
    user: &str,
    request: Option<&ImportRequest>,
) -> Result<bool, AppError>
where
    E: Executor<'e, Database = Sqlite>,
{
    let Some(request) = request else {
        return Ok(false);
    };
    let stored_hash: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT payload_sha256 FROM json_import_receipt_model WHERE user_id=$1 AND request_id=$2",
    )
    .bind(user.to_owned())
    .bind(request.id.clone())
    .fetch_optional(executor)
    .await?;
    if let Some(stored_hash) = stored_hash {
        request.verify_payload(&stored_hash)?;
        return Ok(true);
    }
    Ok(false)
}

/// Call with the same BEGIN IMMEDIATE transaction that inserts the imported data.
pub(super) async fn record_completion<'e, E>(
    executor: E,
    user: &str,
    request: Option<&ImportRequest>,
) -> Result<(), AppError>
where
    E: Executor<'e, Database = Sqlite>,
{
    let Some(request) = request else {
        return Ok(());
    };
    sqlx::query(
        "INSERT INTO json_import_receipt_model (user_id,request_id,payload_sha256) VALUES ($1,$2,$3)",
    )
    .bind(user.to_owned())
    .bind(request.id.clone())
    .bind(request.payload_sha256.to_vec())
    .execute(executor)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::HeaderValue, response::IntoResponse};

    const REQUEST_ID: &str = "a25fb7ed-f23d-4b7e-b8ce-2861f96102e8";

    fn headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(HEADER_NAME, HeaderValue::from_static(REQUEST_ID));
        headers
    }

    #[test]
    fn missing_header_preserves_non_idempotent_imports() {
        assert!(
            ImportRequest::from_headers(&HeaderMap::new(), b"{}")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn invalid_or_multiple_request_ids_are_rejected() {
        for value in [
            "",
            "not-a-uuid",
            "a25fb7ed-f23d-4b7e-b8ce-2861f96102e8,another",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(HEADER_NAME, HeaderValue::from_str(value).unwrap());
            assert!(matches!(
                ImportRequest::from_headers(&headers, b"{}"),
                Err(AppError::Validation(_))
            ));
        }
        let mut headers = headers();
        headers.append(HEADER_NAME, HeaderValue::from_static(REQUEST_ID));
        assert!(matches!(
            ImportRequest::from_headers(&headers, b"{}"),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn request_ids_are_stored_in_canonical_text_form() {
        for value in [REQUEST_ID.to_uppercase(), REQUEST_ID.replace('-', "")] {
            let mut headers = HeaderMap::new();
            headers.insert(HEADER_NAME, HeaderValue::from_str(&value).unwrap());
            let request = ImportRequest::from_headers(&headers, b"{}")
                .unwrap()
                .unwrap();
            assert_eq!(request.id, REQUEST_ID);
        }
    }

    #[test]
    fn account_header_is_optional_and_compares_uuid_values() {
        verify_account(&HeaderMap::new(), REQUEST_ID).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(ACCOUNT_HEADER_NAME, HeaderValue::from_static(REQUEST_ID));
        verify_account(&headers, REQUEST_ID).unwrap();
        verify_account(&headers, &REQUEST_ID.to_uppercase()).unwrap();
        let error = verify_account(&headers, &Uuid::nil().to_string()).unwrap_err();
        assert!(matches!(error, AppError::ImportAccountConflict));
        assert_eq!(
            error.into_response().status(),
            axum::http::StatusCode::CONFLICT
        );
    }

    #[test]
    fn invalid_or_multiple_expected_accounts_are_rejected() {
        let mut headers = HeaderMap::new();
        headers.insert(ACCOUNT_HEADER_NAME, HeaderValue::from_static("not-a-uuid"));
        assert!(matches!(
            verify_account(&headers, REQUEST_ID),
            Err(AppError::Validation(_))
        ));
        headers.insert(ACCOUNT_HEADER_NAME, HeaderValue::from_static(REQUEST_ID));
        headers.append(ACCOUNT_HEADER_NAME, HeaderValue::from_static(REQUEST_ID));
        assert!(matches!(
            verify_account(&headers, REQUEST_ID),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn hash_preserves_the_raw_json_bytes() {
        let headers = headers();
        let original = ImportRequest::from_headers(&headers, br#"{"n":9007199254740993}"#)
            .unwrap()
            .unwrap();
        let same = ImportRequest::from_headers(&headers, br#"{"n":9007199254740993}"#)
            .unwrap()
            .unwrap();
        let rounded = ImportRequest::from_headers(&headers, br#"{"n":9007199254740992}"#)
            .unwrap()
            .unwrap();
        let formatted = ImportRequest::from_headers(&headers, br#"{ "n":9007199254740993 }"#)
            .unwrap()
            .unwrap();
        original.verify_payload(&same.payload_sha256).unwrap();
        for changed in [rounded, formatted] {
            let error = original
                .verify_payload(&changed.payload_sha256)
                .unwrap_err();
            assert_eq!(
                error.into_response().status(),
                axum::http::StatusCode::CONFLICT
            );
        }
    }
}
