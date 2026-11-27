//! 実地域のPBFを一時領域に取り込み、同じ2地点の車・徒歩を計測する。
use anyhow::{Context, Result, ensure};
use geocode_web_single::local_routing::{self, Coord, TravelMode};
use serde_json::json;
use std::{
    env, fs,
    path::Path,
    time::{Duration, Instant},
};

fn directory_bytes(dir: &Path) -> std::io::Result<u64> {
    let mut bytes = 0;
    for item in fs::read_dir(dir)? {
        let item = item?;
        let kind = item.file_type()?;
        if kind.is_file() {
            // Windowsのディレクトリ列挙は、SQLiteが開いて書き込み中のファイルサイズを
            // 古い値で返すことがある。読み取りハンドルから現在の長さを得る。
            bytes += fs::File::open(item.path())?.metadata()?.len();
        } else if kind.is_dir() {
            bytes += directory_bytes(&item.path())?;
        }
    }
    Ok(bytes)
}

fn main() -> Result<()> {
    let args: Vec<_> = env::args().skip(1).collect();
    ensure!(
        args.len() == 6,
        "使用方法: measure_local_routing PBF 作業フォルダー 出発緯度 出発経度 到着緯度 到着経度"
    );
    let source = Path::new(&args[0]);
    let work = tempfile::Builder::new()
        .prefix("route-measure-")
        .tempdir_in(&args[1])?;
    let graph = work.path().join("graph.sqlite");
    let start = Coord {
        lat: args[2].parse()?,
        lon: args[3].parse()?,
    };
    let end = Coord {
        lat: args[4].parse()?,
        lon: args[5].parse()?,
    };
    let timer = Instant::now();
    let mut high_water_bytes = 0;
    let mut previous = String::new();
    let mut last = timer;
    let info = local_routing::build(
        source,
        &graph,
        || Ok(()),
        |stage, done| {
            if stage != previous || last.elapsed() >= Duration::from_secs(10) {
                if let Ok(bytes) = directory_bytes(work.path()) {
                    high_water_bytes = high_water_bytes.max(bytes);
                }
                eprintln!("{stage} {done} ({:.1}s)", timer.elapsed().as_secs_f64());
                previous = stage.to_owned();
                last = Instant::now();
            }
        },
    )?;
    let build_seconds = timer.elapsed().as_secs_f64();
    let graph_bytes = fs::metadata(&graph)?.len();
    let mut queries = Vec::new();
    for mode in [TravelMode::Car, TravelMode::Foot] {
        let mut times_ms = Vec::new();
        let mut distance = 0.;
        let mut duration = 0.;
        for _ in 0..5 {
            let timer = Instant::now();
            let route = local_routing::search(&graph, mode, start, end)
                .with_context(|| format!("{mode:?} の検索に失敗しました"))?;
            times_ms.push(timer.elapsed().as_secs_f64() * 1000.);
            distance = route.distance_m;
            duration = route.duration_s;
        }
        queries.push(
            json!({"mode":mode,"distance_m":distance,"duration_s":duration,"search_ms":times_ms}),
        );
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "pbf_bytes": fs::metadata(source)?.len(), "build_seconds": build_seconds,
            "graph_bytes":graph_bytes, "sampled_work_bytes":high_water_bytes.max(graph_bytes),
            "graph":info, "start":start, "end":end, "queries":queries,
        }))?
    );
    Ok(())
}
