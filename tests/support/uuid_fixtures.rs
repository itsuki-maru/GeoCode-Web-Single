//! 移植元と同じ UUID のシナリオを使い、SQLite の境界では TEXT に変換する。
#[path = "../common/mod.rs"]
mod sqlite;
pub use sqlite::test_pool;
use sqlx::SqlitePool;
use uuid::Uuid;
pub fn init_test_env() {
    sqlite::init_test_env();
}
pub async fn create_test_user(pool: &SqlitePool, name: &str) -> Uuid {
    Uuid::parse_str(&sqlite::create_test_user(pool, name).await).unwrap()
}
pub async fn master_layer_id(pool: &SqlitePool, user: &Uuid) -> Uuid {
    Uuid::parse_str(&sqlite::master_layer_id(pool, &user.to_string()).await).unwrap()
}
