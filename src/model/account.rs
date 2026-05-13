use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// Account用のユーザー構造体
#[derive(Serialize, Deserialize, FromRow)]
pub struct UserAccountModel {
    pub id: String,
    pub username: String,
    pub password: String,
    pub create_at: String,
    pub is_superuser: bool,
    pub failed_count: i64,
    pub next_challenge_time: String,
    pub is_locked: bool,
    pub is_private: bool,
    pub is_basic_authed: bool,
    pub is_basic_authed_at: String,
    pub totp_secret: String,
    pub totp_temp_secret: String,
}

// サインアップ情報構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct SignupPayload {
    pub username: String,
    pub password: String,
}

// ログイン情報構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct LoginPayload {
    pub username: String,
    pub password: String,
}

// トークン構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct Token {
    pub token_type: String,
    pub exp: usize,
    pub sub: String,
}

// アクセストークンとリフレッシュトークンの両者
#[derive(Debug, Serialize, Deserialize)]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
}

// ユーザー名とIDを返す構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthenticatedUser {
    pub id: String,
    pub username: String,
}

// アカウントプライバシー設定取得構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct AccountPrivacyInfo {
    pub is_private: bool,
    pub totp_secret: String,
}

// アカウントのプライバシー設定構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateAccountPrivacyPayload {
    pub is_private: bool,
}

// ユーザーパスワード更新構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateAccountPasswordPayload {
    pub new_password: String,
}
// TOTPによるログイン情報構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct TotpLoginPayload {
    pub totp_token: String,
    pub user_id: String,
}

// TOTPセットアップ構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct TotpSetupResponse {
    pub otpauth_url: String,
    pub secret_base32: String,
}

// ユーザー名取得構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct GetUserNameFromDb {
    pub username: String,
}

// TOTP有効化リクエスト構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct TotpVerifyRequest {
    pub token: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TotpTempSecret {
    pub totp_temp_secret: String,
}
