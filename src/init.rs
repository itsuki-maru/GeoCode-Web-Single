use crate::model::ApplicationInitSetup;
use dirs::home_dir;
use serde::Deserialize;
use serde::Serialize;
use std::fs;
use std::io::{self};
use std::path::PathBuf;
use uuid::Uuid;

/// セットアップフォームの入力フィールド（Tauriコマンドで受け取る）
#[derive(Debug, Deserialize)]
pub struct SetupForm {
    pub app_title: String,
    pub admin_username: String,
    pub admin_password: String,
    pub failed_account_lock: String,
    pub next_challenge_minutes: String,
    pub challenge_limit_time_failed_count: String,
    pub access_token_exp_minutes: String,
    pub refresh_token_exp_minutes: String,
}

/// アプリケーションのユーザー設定ディレクトリを取得し、存在しなければ作成する。
/// 設定JSONの作成は行わない。
pub fn get_application_user_setup_path() -> PathBuf {
    let home_dir = home_dir().expect("User home directory get error.");
    let setup_file_dir = home_dir.join(".geocode-web-single");
    if !setup_file_dir.exists() {
        fs::create_dir(&setup_file_dir).expect("Directory `~/.geocode-web-single` create error.");
        let images_dir = &setup_file_dir.join("images");
        fs::create_dir(images_dir).expect("Directory `~/.geocode-web-single/images` create error.");
    }
    setup_file_dir
}

/// 設定JSONファイルを読み込んで返す。ファイルが存在しない・不正な場合は None を返す。
pub fn read_env_json(setup_dir: &PathBuf) -> Option<ApplicationInitSetup> {
    let env_json_path = setup_dir.join("geocode-web-single.env.json");
    if !env_json_path.exists() {
        return None;
    }
    read_to_json_data(&env_json_path).ok()
}

/// セットアップフォームの入力値から ApplicationInitSetup を構築し、JSONに保存する。
pub fn build_env_from_form(
    setup_dir: PathBuf,
    form: SetupForm,
) -> Result<ApplicationInitSetup, String> {
    let database_path = setup_dir.join("geocode-web.sqlite");
    let database_url = format!("sqlite:{}", database_path.to_string_lossy());
    let images_path = setup_dir.join("images");
    let secret_key = Uuid::new_v4().to_string();

    let env = ApplicationInitSetup {
        app_title: form.app_title.clone(),
        sqlite_database_path: database_path,
        database_url,
        image_file_path: images_path.to_string_lossy().into_owned(),
        upload_file_path: images_path.to_string_lossy().into_owned(),
        failed_account_lock: form.failed_account_lock,
        next_challenge_minutes: form.next_challenge_minutes,
        challenge_limit_time_failed_count: form.challenge_limit_time_failed_count,
        admin_username: form.admin_username,
        admin_passwotd: form.admin_password,
        access_token_exp_minutes: form.access_token_exp_minutes,
        refresh_token_exp_minutes: form.refresh_token_exp_minutes,
        secret_key,
        cache_control: "no-cache".to_string(),
        secure_cookie: "true".to_string(),
        service_name: form.app_title,
        rust_log: "geocode_web_single=info,tower_http=info".to_string(),
        allow_user_create_account: "false".to_string(),
        allow_user_update_password: "true".to_string(),
        allow_origins: format!("http://localhost:5173,http://127.0.0.1:3000,http://localhost:3000"),
        tile_server_base_url: None,
        tile_server_api_key: None,
    };
    let env_json_path = setup_dir.join("geocode-web-single.env.json");
    write_to_json_file(env_json_path, &env).map_err(|e| e.to_string())?;

    Ok(env)
}

fn write_to_json_file<T: Serialize>(file_path: PathBuf, data: &T) -> io::Result<()> {
    let file = fs::File::create(file_path).expect("`geocode-web-single.env.json` fs create error.");
    serde_json::to_writer_pretty(file, data).expect("`geocode-web-single.env.json` write error.");
    Ok(())
}

fn read_to_json_data<T: for<'de> Deserialize<'de>>(file_path: &PathBuf) -> io::Result<T> {
    let file = fs::File::open(file_path)?;
    let reader = io::BufReader::new(file);
    let data = serde_json::from_reader(reader)?;
    Ok(data)
}
