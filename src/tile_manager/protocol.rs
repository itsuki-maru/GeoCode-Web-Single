use super::message;
use crate::{
    local_tiles::jobs::{ImportRequest, PrecomputeRequest},
    tilegen::render_spec::RenderSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "action",
    content = "payload",
    rename_all = "lowercase",
    deny_unknown_fields
)]
pub(super) enum Operation {
    Import(ImportRequest),
    Register(Register),
    Prepare(Prepare),
    Precompute(PrecomputeRequest),
    Resume(Job),
    Background(Background),
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Register {
    pub database: PathBuf,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Prepare {
    pub dataset: String,
    #[serde(default)]
    pub spec: Option<RenderSpec>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Job {
    pub job: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Background {
    pub dataset: String,
    #[serde(default)]
    pub render: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

impl Operation {
    pub fn parse(action: &str, payload: Value, id: &str) -> Result<Self, String> {
        let mut value: Self =
            serde_json::from_value(serde_json::json!({"action":action,"payload":payload}))
                .map_err(|error| format!("未対応の操作または入力条件が不正です: {error}"))?;
        if let Self::Import(request) = &mut value {
            if request
                .request_id
                .as_deref()
                .is_some_and(|saved| saved != id)
            {
                return Err("受付IDと取り込み条件のrequest_idが一致しません。".into());
            }
            request.request_id = Some(id.to_owned());
            absolute(Path::new(&request.input_path))?;
            for input in [&request.elevation_input, &request.landmask_input]
                .into_iter()
                .flatten()
            {
                absolute(Path::new(input))?;
            }
        }
        if let Self::Register(request) = &value {
            absolute(&request.database)?;
        }
        if let Self::Prepare(request) = &mut value {
            if let Some(spec) = request.spec {
                spec.validate().map_err(message)?;
                request.spec = Some(spec.normalized());
            }
        }
        Ok(value)
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::Import(_) => "import",
            Self::Register(_) => "register",
            Self::Prepare(_) => "prepare",
            Self::Precompute(_) => "precompute",
            Self::Resume(_) => "resume",
            Self::Background(_) => "background",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub version: u32,
    pub id: String,
    pub config_path: PathBuf,
    pub config_sha256: String,
    pub executable: PathBuf,
    pub executable_sha256: String,
    pub operation: Operation,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Receipt {
    pub id: String,
    pub action: String,
    #[serde(default)]
    pub request_sha256: String,
    pub state: String,
    pub job_id: Option<String>,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub log_path: PathBuf,
    pub created_at: String,
    pub updated_at: String,
    pub worker_pid: Option<u32>,
}
impl Receipt {
    pub fn new(id: String, action: &str, log_path: PathBuf) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id,
            action: action.into(),
            request_sha256: String::new(),
            state: "starting".into(),
            job_id: None,
            result: None,
            error: None,
            log_path,
            created_at: now.clone(),
            updated_at: now,
            worker_pid: None,
        }
    }
    pub fn update(&mut self, state: &str) {
        self.state = state.into();
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}
pub(super) fn absolute(path: &Path) -> Result<(), String> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err("ファイル・フォルダーは絶対パスで指定してください。".into())
    }
}
pub(super) fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(message)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(message)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub(super) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let meta = fs::symlink_metadata(path).map_err(message)?;
    if !meta.is_file() || is_link(&meta) || meta.len() > 1024 * 1024 {
        return Err("管理ファイルの形式・容量が不正です。".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(message)?).map_err(message)
}
pub(super) fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if path.exists() && is_link(&fs::symlink_metadata(path).map_err(message)?) {
        return Err("管理ファイルにリンクは使用できません。".into());
    }
    let parent = path.parent().ok_or("管理ファイルの保存先が不正です。")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(message)?;
    serde_json::to_writer_pretty(&mut file, value).map_err(message)?;
    file.write_all(b"\n").map_err(message)?;
    file.as_file().sync_all().map_err(message)?;
    file.persist(path).map_err(message)?;
    Ok(())
}
pub(super) fn is_link(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
