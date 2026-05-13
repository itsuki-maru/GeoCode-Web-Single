use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Serialize, Deserialize, FromRow)]
pub struct IsSuperuser {
    pub is_superuser: bool,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct ResponseUserData {
    pub id: String,
    pub username: String,
    pub password: String,
    pub create_at: String,
    pub is_superuser: bool,
    pub is_locked: bool,
}

// ユーザー情報更新構造体
#[derive(Serialize, Deserialize)]
pub struct UpdateUserData {
    pub new_password: String,
}
