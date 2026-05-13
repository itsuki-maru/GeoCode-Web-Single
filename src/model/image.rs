use serde::{Deserialize, Serialize};

// 画像構造体
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ImageData {
    pub id: String,
    pub user_id: String,
    pub filename: String,
    pub uuid_filename: String,
}

// 画像削除後のデータベース構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct ImageIdNameDeleted {
    pub id: String,
    pub uuid_filename: String,
}

// 画像削除後の構造体
#[derive(Debug, Serialize, Deserialize)]
pub struct DeletedImageResponse {
    pub id: String,
    pub message: String,
}

// 画像アップロード後のレスポンス
#[derive(Debug, Serialize, Deserialize)]
pub struct UploadResponseImage {
    pub new_image_id: String,
    pub user_id: String,
    pub filename: String,
    pub uuid_filename: String,
}

// サムネイル画像を返却するかハンドリングするクエリパラメータ
#[derive(Debug, Deserialize, Serialize)]
pub struct ThumbnailQueryParams {
    pub thumb: Option<bool>,
}
