//! GUI・サーバー・管理CLIを、設定やTauriを初期化する前に振り分ける。

#[derive(Debug, PartialEq, Eq)]
pub enum LaunchMode {
    Desktop,
    Server(String),
    LocalTiles(Vec<String>),
    TileManager(Option<std::path::PathBuf>),
    TileWorker(std::path::PathBuf),
    Help,
}

pub fn parse(args: &[String]) -> Result<LaunchMode, String> {
    let Some(first) = args.first().map(String::as_str) else {
        return Ok(LaunchMode::Desktop);
    };
    match first {
        "local-tiles" if args.get(1).is_some_and(|value| value == "gui") => {
            match &args[2..] {
                [] => Ok(LaunchMode::TileManager(None)),
                [help] if matches!(help.as_str(), "--help" | "-h") => Ok(LaunchMode::Help),
                [option, path] if option == "--config" && std::path::Path::new(path).is_absolute() =>
                    Ok(LaunchMode::TileManager(Some(path.into()))),
                _ => Err("使用方法: local-tiles gui [--config ABSOLUTE_JSON_PATH]".into()),
            }
        },
        "local-tiles" if args.get(1).is_some_and(|value| value == "worker") => {
            match &args[2..] {
                [option, path] if option == "--request" && std::path::Path::new(path).is_absolute() =>
                    Ok(LaunchMode::TileWorker(path.into())),
                _ => Err("workerには受付ファイルの絶対パスが必要です。".into()),
            }
        },
        "local-tiles" => Ok(LaunchMode::LocalTiles(args[1..].to_vec())),
        "--help" | "-h" if args.len() == 1 => Ok(LaunchMode::Help),
        "-s" if args.len() <= 2 => {
            let address = args.get(1).map(String::as_str).unwrap_or("0.0.0.0");
            if let Ok(address) = address.parse::<std::net::SocketAddr>() {
                return Ok(LaunchMode::Server(address.to_string()));
            }
            let address = address.parse::<std::net::IpAddr>()
                .map_err(|_| "-sにはIPアドレス、またはIPアドレス:ポートを指定してください。".to_string())?;
            Ok(LaunchMode::Server(std::net::SocketAddr::new(address, 3000).to_string()))
        },
        _ => Err("起動引数が不正です。引数なし、-s [IP:PORT]、local-tiles ... のいずれかを指定してください。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn selects_modes_from_the_first_argument_and_rejects_mixed_modes() {
        assert_eq!(parse(&[]).unwrap(), LaunchMode::Desktop);
        assert_eq!(
            parse(&arguments(&["-s"])).unwrap(),
            LaunchMode::Server("0.0.0.0:3000".into())
        );
        assert_eq!(
            parse(&arguments(&["-s", "127.0.0.1:9090"])).unwrap(),
            LaunchMode::Server("127.0.0.1:9090".into())
        );
        assert_eq!(
            parse(&arguments(&["-s", "::1"])).unwrap(),
            LaunchMode::Server("[::1]:3000".into())
        );
        for args in [
            &["unknown"][..],
            &["-s", "127.0.0.1", "extra"],
            &["-s", "local-tiles"],
            &["--help", "extra"],
        ] {
            assert!(parse(&arguments(args)).is_err());
        }
        assert_eq!(
            parse(&arguments(&["local-tiles", "import", "--input", "-s"])).unwrap(),
            LaunchMode::LocalTiles(arguments(&["import", "--input", "-s"]))
        );
    }

    #[test]
    fn parses_tile_manager_and_worker_modes_independently_of_desktop_mode() {
        assert_eq!(
            parse(&arguments(&["local-tiles", "gui"])).unwrap(),
            LaunchMode::TileManager(None)
        );
        let absolute = std::env::current_dir().unwrap().join("設定 日本語.json");
        let path = absolute.to_str().unwrap();
        assert_eq!(
            parse(&arguments(&["local-tiles", "gui", "--config", path])).unwrap(),
            LaunchMode::TileManager(Some(absolute.clone()))
        );
        assert_eq!(
            parse(&arguments(&["local-tiles", "worker", "--request", path])).unwrap(),
            LaunchMode::TileWorker(absolute.clone())
        );
        for args in [
            &["local-tiles", "gui", "-s"][..],
            &["local-tiles", "gui", "--config", "relative.json"],
            &["local-tiles", "gui", "--config", path, "extra"],
            &["local-tiles", "worker"],
            &["local-tiles", "worker", "--request", "relative.json"],
        ] {
            assert!(parse(&arguments(args)).is_err(), "{args:?}");
        }
    }
}
