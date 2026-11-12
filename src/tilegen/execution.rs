//! 世代の識別とは独立して、実行構成が検証済みかを確認する。

use std::sync::LazyLock;

#[path = "../../build_support/render_execution.rs"]
#[allow(dead_code)]
mod policy;

mod compiled {
    include!(concat!(env!("OUT_DIR"), "/render_execution.rs"));
}

#[derive(Debug, Clone)]
pub struct ExecutionStatus {
    pub verified: bool,
    pub reason: Option<String>,
    pub compiler: String,
    pub target: String,
    pub dependency_fingerprint: String,
}

pub fn execution_status() -> ExecutionStatus {
    static STATUS: LazyLock<ExecutionStatus> = LazyLock::new(|| {
        let contract = super::identity::RenderContract::for_format(1, 1);
        let series_matches = contract
            .as_ref()
            .is_some_and(|contract| contract.execution_series == compiled::SERIES);
        let reason = if !series_matches {
            Some("数値演算・ラスタ化の認定系列が一致しません。".into())
        } else {
            compiled::REASON.map(str::to_owned)
        };
        ExecutionStatus {
            verified: compiled::VERIFIED && reason.is_none(),
            reason,
            compiler: compiled::COMPILER.into(),
            target: compiled::TARGET.into(),
            dependency_fingerprint: compiled::DEPENDENCIES.into(),
        }
    });
    STATUS.clone()
}

pub fn ensure_generation_allowed() -> Result<(), String> {
    let status = execution_status();
    if status.verified {
        Ok(())
    } else {
        Err(format!(
            "新規生成を停止しています: {}",
            status
                .reason
                .unwrap_or_else(|| "実行構成が未認定です。".into())
        ))
    }
}

/// 新系列は道路系列と別に認定し、対応一覧の追加で道路の世代を変えない。
pub fn standard_execution_status() -> ExecutionStatus {
    static STATUS: LazyLock<ExecutionStatus> = LazyLock::new(|| {
        let contract = super::identity::RenderContract::for_format(2, 2);
        let series_matches = contract
            .as_ref()
            .is_some_and(|contract| contract.execution_series == compiled::STANDARD_SERIES);
        let reason = if !series_matches {
            Some("標準地図の数値演算・ラスタ化の認定系列が一致しません。".into())
        } else {
            compiled::STANDARD_REASON.map(str::to_owned)
        };
        ExecutionStatus {
            verified: compiled::STANDARD_VERIFIED && reason.is_none(),
            reason,
            compiler: compiled::COMPILER.into(),
            target: compiled::TARGET.into(),
            dependency_fingerprint: compiled::STANDARD_DEPENDENCIES.into(),
        }
    });
    STATUS.clone()
}

pub fn ensure_standard_generation_allowed() -> Result<(), String> {
    let status = standard_execution_status();
    if status.verified {
        Ok(())
    } else {
        Err(format!(
            "標準地図の新規生成を停止しています: {}",
            status
                .reason
                .unwrap_or_else(|| "実行構成が未認定です。".into())
        ))
    }
}

/// 名称付きの新描画だけにフォント・字形処理の依存を追加して認定する。
pub fn osm_execution_status() -> ExecutionStatus {
    static STATUS: LazyLock<ExecutionStatus> = LazyLock::new(|| {
        let matches = super::identity::RenderContract::for_format(3, 2)
            .is_some_and(|contract| contract.execution_series == compiled::OSM_SERIES);
        let reason = if matches {
            compiled::OSM_REASON.map(str::to_owned)
        } else {
            Some("名称付き地図の実行認定系列が一致しません。".into())
        };
        ExecutionStatus {
            verified: compiled::OSM_VERIFIED && reason.is_none(),
            reason,
            compiler: compiled::COMPILER.into(),
            target: compiled::TARGET.into(),
            dependency_fingerprint: compiled::OSM_DEPENDENCIES.into(),
        }
    });
    STATUS.clone()
}

pub fn ensure_osm_generation_allowed() -> Result<(), String> {
    let status = osm_execution_status();
    if status.verified {
        Ok(())
    } else {
        Err(format!(
            "名称付き地図の生成を停止しています: {}",
            status
                .reason
                .unwrap_or_else(|| "実行構成が未認定です。".into())
        ))
    }
}
