use axum::Router;
use serde::{Deserialize, Serialize};
use std::{env, path::Path};

/// 公開する道路網を設定JSONで明示する。受信用の秘密鍵はプロセス環境からのみ読む。
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct HttpSettings {
    pub enabled: bool,
    pub dataset: String,
}

impl HttpSettings {
    pub(crate) fn dataset_name(&self) -> Result<&str, String> {
        let name = self.dataset.trim();
        if name.is_empty() || name.chars().count() > 120 {
            return Err("local_routing_http.dataset に公開する道路網の名前（1〜120文字）を指定してください。".into());
        }
        Ok(name)
    }

    pub fn routes(&self, dataset_root: &Path) -> Result<Router, String> {
        if !self.enabled {
            return Ok(Router::new());
        }
        let name = self.dataset_name()?;
        let key = match env::var("LOCAL_ROUTING_HTTP_API_KEY") {
            Ok(key) => {
                if key.is_empty()
                    || key.len() > 4096
                    || key.trim() != key
                    || !key.bytes().all(|b| (b' '..=b'~').contains(&b))
                {
                    return Err(
                        "LOCAL_ROUTING_HTTP_API_KEY に有効なHTTPヘッダー値を指定してください。"
                            .into(),
                    );
                }
                Some(key)
            },
            Err(env::VarError::NotPresent) => None,
            Err(env::VarError::NotUnicode(_)) => {
                return Err("LOCAL_ROUTING_HTTP_API_KEY を読み取れません。".into());
            },
        };
        Ok(super::http::router(
            dataset_root.to_owned(),
            name.to_owned(),
            key,
        ))
    }
}
