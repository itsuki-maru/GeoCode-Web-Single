//! GUI・サーバー・管理CLIを、設定やTauriを初期化する前に振り分ける。

#[derive(Debug, PartialEq, Eq)]
pub enum LaunchMode {
    Desktop,
    Server(String),
    LocalTiles(Vec<String>),
    Help,
}

pub fn parse(args: &[String]) -> Result<LaunchMode, String> {
    let Some(first) = args.first().map(String::as_str) else {
        return Ok(LaunchMode::Desktop);
    };
    match first {
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
    fn モードを先頭引数だけで判定し別モードの混在を拒否する() {
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
}
