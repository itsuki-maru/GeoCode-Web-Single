//! 複数回の走査を伴う取り込みの全体進捗を、各工程の所要時間の比率から推定する。
//! 処理量と直近の処理速度は工程ごとに集計する。
use serde_json::{Value, json};

pub(crate) struct Estimate {
    stages: Vec<(&'static str, f64)>,
    reference_seconds: Option<f64>,
    stage: String,
    sample_time: f64,
    sample_fraction: f64,
    rate: Option<f64>,
}

impl Estimate {
    // 初期配分の根拠にした地域別・全国の実測値は docs/LOCAL_TILES.md に記載。
    pub(crate) fn import(
        standard: bool,
        land: bool,
        elevation_cells: u64,
        contours: bool,
        bytes: u64,
    ) -> Self {
        let mut stages = vec![("Validating", 0.05)];
        if standard {
            let nationwide = (bytes as f64 / 2_573_762_684.).min(1.);
            let blend = |regional, national| regional + (national - regional) * nationwide;
            stages.extend([
                ("ImportPass1", blend(1.2, 0.5)),
                ("ImportPass2", blend(13., 6.)),
                ("ImportPass3", blend(19., 11.)),
                ("BuildingGeometry", blend(46., 55.)),
            ]);
            if land {
                stages.push(("ImportLandmask", 6.));
            }
            if elevation_cells > 0 {
                // 愛媛では10 MBのPBFを約21秒で取り込み、標高格子1枚（1125×750セル）の追加に約1秒かかった。
                // ZIP・フォルダー・マニフェストのいずれも、事前検査で得たセル数を使い、資料の再読み込みを省く。
                let terrain =
                    (elevation_cells as f64 / 843_750.) * (10_093_947. / bytes.max(1) as f64);
                stages.extend([
                    ("ImportElevation", 1.8 * terrain),
                    ("ElevationPyramid", 0.5 * terrain),
                ]);
                if contours {
                    stages.push(("BuildingContours", 2.2 * terrain));
                }
            }
            stages.push(("PreparingStore", 2.));
            stages.push(("FinalValidation", 18.5));
        } else {
            stages.extend([
                ("ImportPass1", 15.),
                ("ImportPass2", 16.5),
                ("BuildingGeometry", 40.),
                ("FinalValidation", 28.),
            ]);
        }
        stages.extend([("Publishing", 0.1), ("Registering", 0.1)]);
        Self::new(stages, None)
    }

    pub(crate) fn routing(bytes: u64) -> Self {
        // 初回の所要時間は、リリース版で測った四国と全国の構築時間からPBF容量に応じて推定する。
        let seconds = 52.53 * (bytes as f64 / 92_174_430.).powf(1.29);
        Self::new(
            vec![
                ("ways", 18.2),
                ("nodes", 12.8),
                ("restrictions", 0.5),
                ("index", 47.7),
                ("sql_indexes", 7.9),
                ("validate", 12.8),
                ("publish_graph", 0.1),
            ],
            Some(seconds),
        )
    }

    fn new(stages: Vec<(&'static str, f64)>, reference_seconds: Option<f64>) -> Self {
        Self {
            stages,
            reference_seconds,
            stage: String::new(),
            sample_time: 0.,
            sample_fraction: 0.,
            rate: None,
        }
    }

    /// 過去の成功レポートには4工程の所要時間がある。標準地図では第2・第3走査をまとめ、
    /// 地形処理は地物構築に含めている。各集計が複数の工程にまたがる場合は、その中の配分比を保つ。
    pub(crate) fn use_import_report(&mut self, report: &Value) {
        let times = [
            "pass1_seconds",
            "pass2_seconds",
            "geometry_and_lod_seconds",
            "final_validation_seconds",
        ]
        .map(|key| report[key].as_f64().filter(|s| s.is_finite() && *s > 0.));
        let [Some(a), Some(b), Some(c), Some(d)] = times else {
            return;
        };
        let total = a + b + c + d;
        if total < 5. {
            return;
        }
        let group = |stage: &str| match stage {
            "ImportPass1" => Some(0),
            "ImportPass2" | "ImportPass3" => Some(1),
            "BuildingGeometry" | "ImportLandmask" | "ImportElevation" | "ElevationPyramid"
            | "BuildingContours" | "PreparingStore" => Some(2),
            "FinalValidation" | "Publishing" => Some(3),
            _ => None,
        };
        let mut sums = [0.; 4];
        for &(name, w) in &self.stages {
            if let Some(i) = group(name) {
                sums[i] += w;
            }
        }
        for (name, w) in &mut self.stages {
            if let Some(i) = group(name) {
                *w *= [a, b, c, d][i] * 100. / (total * sums[i]);
            }
        }
        self.reference_seconds = Some(total);
    }

    pub(crate) fn sample(
        &mut self,
        stage: &str,
        done: u64,
        total: Option<u64>,
        scan: Option<(u64, u64)>,
        elapsed: f64,
        stage_elapsed: f64,
    ) -> Value {
        let Some(index) = self.stages.iter().position(|(name, _)| *name == stage) else {
            return Value::Null;
        };
        if self.stage != stage {
            self.stage = stage.to_owned();
            self.sample_time = 0.;
            self.sample_fraction = 0.;
            self.rate = None;
        }
        let ratio = |d: u64, n: u64| d.min(n) as f64 / n.max(1) as f64;
        let objects = total.filter(|n| *n > 0).map(|n| ratio(done, n));
        let fraction = match scan {
            Some((bytes, size)) if size > 0 => {
                // ノード座標の解決では、圧縮データの読み取りよりDBへの書き込みに時間がかかる。
                // OSMのブロック順によって書き込みが偏るため、読み取り量と処理件数を併用する。
                let scanned = ratio(bytes, size);
                let work = if stage == "ways" {
                    // 四国の実測では、圧縮PBFの約200バイトにつき通行可能な道路が1本ある。
                    Some((done as f64 * 200. / size as f64).min(1.))
                } else {
                    objects
                };
                Some(if bytes >= size {
                    1.
                } else {
                    work.map_or(scanned, |f| 0.15 * scanned + 0.85 * f)
                })
            },
            _ => objects,
        };
        let dt = stage_elapsed - self.sample_time;
        if let Some(f) = fraction
            && dt >= 1.
            && f > self.sample_fraction
        {
            let speed = (f - self.sample_fraction) / dt;
            let alpha = 1. - (-dt / 12.).exp();
            self.rate = Some(self.rate.map_or(speed, |old| old + alpha * (speed - old)));
            self.sample_time = stage_elapsed;
            self.sample_fraction = f;
        }
        let weight = self.stages[index].1;
        let sum: f64 = self.stages.iter().map(|(_, w)| w).sum();
        let before: f64 = self.stages[..index].iter().map(|(_, w)| w).sum();
        let percent = 100. * (before + weight * fraction.unwrap_or(0.)) / sum;
        let scale = if before >= sum * 0.04 {
            Some((elapsed - stage_elapsed).max(0.) / before)
        } else {
            self.reference_seconds.map(|s| s / sum)
        };
        let mut remaining = None;
        if elapsed >= 5. {
            let later = (sum - before - weight).max(0.);
            if let (Some(f), Some(rate)) = (fraction, self.rate) {
                if stage_elapsed - self.sample_time < 30. && f < 1. {
                    let measured = (1. - f) / rate;
                    let overall_scale = scale.unwrap_or((stage_elapsed + measured) / weight);
                    // 工程の序盤はブロックごとの処理時間のばらつきが大きいため、直近の速度の比重を抑える。
                    let current = scale.map_or(measured, |s| {
                        let trust = (stage_elapsed / 20.).clamp(0.15, 0.8);
                        measured * trust + (weight * s * (1. - f)) * (1. - trust)
                    });
                    remaining = Some(current + later * overall_scale);
                }
            } else if let Some(scale) = scale {
                let expected = scale * weight;
                if stage_elapsed < expected {
                    remaining = Some(expected - stage_elapsed + later * scale);
                }
            }
        }
        json!({"percent":percent.clamp(0.,99.), "remaining_seconds":remaining, "stage_elapsed_seconds":stage_elapsed})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_bytes_and_finished_work_never_count_a_whole_pass_as_the_whole_job() {
        let mut run = Estimate::routing(92_174_430);
        let opening = run.sample("ways", 0, None, Some((70_000_000, 92_174_430)), 1., 1.);
        assert!(opening["percent"].as_f64().unwrap() < 3.);
        assert!(opening["remaining_seconds"].is_null());
        let ended = run.sample(
            "ways",
            460_000,
            None,
            Some((92_174_430, 92_174_430)),
            10.,
            10.,
        );
        let nodes = run.sample("nodes", 0, Some(4_670_000), None, 10., 0.);
        assert_eq!(ended["percent"], nodes["percent"]);
        let index = run.sample("index", 2_000, Some(4_000), None, 30., 12.);
        assert!(index["percent"].as_f64().unwrap() > 50.);
        assert!(index["remaining_seconds"].as_f64().unwrap() > 0.);
        let idle = run.sample("index", 2_000, Some(4_000), None, 80., 62.);
        assert_eq!(idle["percent"], index["percent"]);
        assert!(idle["remaining_seconds"].is_null());
        let publish = run.sample("publish_graph", 4000, None, None, 100., 0.);
        assert!(publish["percent"].as_f64().unwrap() < 100.);
    }

    #[test]
    fn terrain_share_tracks_the_cell_count_relative_to_the_map() {
        let at_elevation_start = |cells| {
            Estimate::import(true, false, cells, true, 10_093_947).sample(
                "ImportElevation",
                0,
                None,
                None,
                15.,
                0.,
            )["percent"]
                .as_f64()
                .unwrap()
        };
        assert!(at_elevation_start(843_750) > 70.);
        assert!(at_elevation_start(843_750 * 20) < 50.);
    }

    #[test]
    fn historic_import_groups_respect_options_and_preserve_stage_only_records() {
        let mut plain = Estimate::import(true, false, 0, false, 100_000_000);
        assert!(
            plain
                .sample("BuildingContours", 1, Some(2), None, 50., 1.)
                .is_null()
        );
        let mut dem = Estimate::import(true, true, 843_750, true, 100_000_000);
        dem.use_import_report(&json!({"pass1_seconds":10,"pass2_seconds":20,
            "geometry_and_lod_seconds":50,"final_validation_seconds":20}));
        let contours = dem.sample("BuildingContours", 10, Some(20), None, 70., 10.);
        let validation = dem.sample("FinalValidation", 0, None, None, 80., 0.);
        assert!(contours["percent"].as_f64().unwrap() < validation["percent"].as_f64().unwrap());
        assert!((validation["percent"].as_f64().unwrap() - 80.).abs() < 1.);
        let later = dem.sample("FinalValidation", 0, None, None, 88., 8.);
        assert_eq!(validation["percent"], later["percent"]);
    }
}
