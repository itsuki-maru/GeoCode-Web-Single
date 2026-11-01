//! PostgreSQLのnumeric・timestamp比較をSQLiteの読み取り接続で再現する。
use chrono::{DateTime, NaiveDateTime};
use sqlx::{Sqlite, SqlitePool, Transaction};
use std::{
    cmp::Ordering,
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering as AtomicOrdering},
    },
};

pub(super) async fn begin_read(
    pool: &SqlitePool,
) -> Result<Transaction<'static, Sqlite>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    {
        let mut handle = tx.lock_handle().await?;
        handle.create_collation("answer_numeric", compare_numbers)?;
        let times = CachedTimestampCollation::default();
        handle.create_collation("answer_time", move |a, b| times.compare(a, b))?;
        handle.create_collation("answer_name", |a, b| {
            a.to_lowercase().cmp(&b.to_lowercase())
        })?;
    }
    Ok(tx)
}

/// 遅延トランザクションからの昇格を避けるため、読み取り前に書き込み権を確保する。
pub(super) async fn begin_write(
    pool: &SqlitePool,
) -> Result<Transaction<'static, Sqlite>, sqlx::Error> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    {
        let mut handle = tx.lock_handle().await?;
        handle.create_collation("answer_time", compare_times)?;
    }
    Ok(tx)
}

/// 等価な JSON 数値表記も含め、PostgreSQL の JSONB の等価判定に合わせる。
pub(super) fn json_equal(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.to_string(), b.to_string());
            a == b
                || (decimal(&a).is_some()
                    && decimal(&b).is_some()
                    && compare_numbers(&a, &b) == Ordering::Equal)
        },
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
        },
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| json_equal(a, b)))
        },
        _ => a == b,
    }
}

fn timestamp(raw: &str) -> Option<NaiveDateTime> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|v| v.naive_utc())
        .or_else(|| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f").ok())
        .or_else(|| NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f").ok())
}

fn compare_times(a: &str, b: &str) -> Ordering {
    match (timestamp(a), timestamp(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        _ => a.cmp(b),
    }
}

const TIMESTAMP_CACHE_MAX_ENTRIES: usize = 512;
const TIMESTAMP_CACHE_MAX_BYTES: usize = 32 * 1024;
const TIMESTAMP_CACHE_MAX_KEY_BYTES: usize = 256;
const TIMESTAMP_CACHE_SAMPLE_COMPARISONS: usize = 256;

#[derive(Default)]
struct TimestampCache {
    values: HashMap<String, Option<NaiveDateTime>>,
    key_bytes: usize,
    comparisons: usize,
    reused_comparisons: usize,
}

impl TimestampCache {
    fn parse(&mut self, raw: &str) -> (Option<NaiveDateTime>, bool) {
        // 極端に長い値はハッシュ化も保持も行わず、解析とフォールバックの動作は維持する。
        if raw.len() > TIMESTAMP_CACHE_MAX_KEY_BYTES {
            return (timestamp(raw), false);
        }
        if let Some(parsed) = self.values.get(raw) {
            return (*parsed, true);
        }
        let parsed = timestamp(raw);
        // キャッシュミスのたびに領域を確保せず、最初の作業用データを保持する。
        // 日時がすべて異なる場合でも、頻繁に再利用するクエリの境界値を保持できる。
        if self.values.len() < TIMESTAMP_CACHE_MAX_ENTRIES
            && raw.len() <= TIMESTAMP_CACHE_MAX_BYTES.saturating_sub(self.key_bytes)
        {
            self.values.insert(raw.to_owned(), parsed);
            self.key_bytes += raw.len();
        }
        (parsed, false)
    }

    fn unhelpful(&mut self, reused: bool) -> bool {
        self.comparisons += 1;
        self.reused_comparisons += usize::from(reused);
        if self.comparisons < TIMESTAMP_CACHE_SAMPLE_COMPARISONS {
            return false;
        }
        // 保存された日時がすべて異なっていても、as_of 境界を繰り返し使う場合には効果がある。
        // どちらかの日時を再利用する比較が全体の四分の一未満になったら停止する。
        let unhelpful = self.reused_comparisons * 4 < self.comparisons;
        self.comparisons = 0;
        self.reused_comparisons = 0;
        unhelpful
    }
}

/// 読み取りトランザクションの開始ごとに置き換える。SQLite はコミット後もプール内の接続に
/// コールバックを保持するため、項目数と保持するキーのバイト数の両方に上限を設ける。
#[derive(Default)]
struct CachedTimestampCollation {
    cache: Mutex<TimestampCache>,
    disabled: AtomicBool,
}

impl CachedTimestampCollation {
    fn compare(&self, a: &str, b: &str) -> Ordering {
        if a == b {
            return Ordering::Equal;
        }
        if self.disabled.load(AtomicOrdering::Relaxed) {
            return compare_times(a, b);
        }
        let Ok(mut cache) = self.cache.lock() else {
            self.disabled.store(true, AtomicOrdering::Relaxed);
            return compare_times(a, b);
        };
        let (parsed_a, reused_a) = cache.parse(a);
        let (parsed_b, reused_b) = cache.parse(b);
        if cache.unhelpful(reused_a || reused_b) {
            self.disabled.store(true, AtomicOrdering::Relaxed);
        }
        match (parsed_a, parsed_b) {
            (Some(a), Some(b)) => a.cmp(&b),
            _ => a.cmp(b),
        }
    }
}

// 正規化した十進数 (負かどうか、有効数字、小数点位置)。f64を経由しない。
fn decimal(raw: &str) -> Option<(bool, String, i32)> {
    // 検索値はPostgreSQL numericと同様に .5 なども許容する。
    // 保存値にはPostgreSQL版の正規表現と同じ桁数制限を適用する。
    let (query, raw) = if let Some(stored) = raw.strip_prefix("stored:") {
        (false, stored)
    } else {
        raw.strip_prefix("query:")
            .map_or((false, raw), |s| (true, s))
    };
    let (negative, unsigned) = if let Some(s) = raw.strip_prefix('-') {
        (true, s)
    } else {
        (false, raw.strip_prefix('+').unwrap_or(raw))
    };
    let mut exponent_parts = unsigned.split(['e', 'E']);
    let mantissa = exponent_parts.next()?;
    let exponent = if let Some(e) = exponent_parts.next() {
        let digits = e.strip_prefix(['+', '-']).unwrap_or(e);
        if digits.is_empty()
            || digits.len() > if query { 6 } else { 3 }
            || !digits.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        e.parse::<i32>().ok()?
    } else {
        0
    };
    if exponent_parts.next().is_some() {
        return None;
    }
    let mut parts = mantissa.split('.');
    let integer = parts.next()?;
    let fraction = parts.next().unwrap_or("");
    if (integer.is_empty() && (!query || fraction.is_empty()))
        || integer.len() > if query { 200 } else { 100 }
        || fraction.len() > if query { 200 } else { 100 }
        || parts.next().is_some()
        || !integer
            .bytes()
            .chain(fraction.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let digits = format!("{integer}{fraction}");
    let significant = digits.trim_start_matches('0');
    if significant.is_empty() {
        return Some((false, "0".into(), 0));
    }
    let position = integer.len() as i32 + exponent - (digits.len() - significant.len()) as i32;
    Some((
        negative,
        significant.trim_end_matches('0').to_owned(),
        position,
    ))
}

pub(super) fn compare_numbers(a: &str, b: &str) -> Ordering {
    match (decimal(a), decimal(b)) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some((an, ad, ap)), Some((bn, bd, bp))) => {
            if an != bn {
                return if an {
                    Ordering::Less
                } else {
                    Ordering::Greater
                };
            }
            let order = if ad == "0" {
                if bd == "0" {
                    Ordering::Equal
                } else {
                    Ordering::Less
                }
            } else if bd == "0" {
                Ordering::Greater
            } else {
                ap.cmp(&bp).then_with(|| {
                    let size = ad.len().max(bd.len());
                    ad.bytes()
                        .chain(std::iter::repeat(b'0'))
                        .take(size)
                        .cmp(bd.bytes().chain(std::iter::repeat(b'0')).take(size))
                })
            };
            if an { order.reverse() } else { order }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decimal_comparison_preserves_precision_and_rejects_invalid_values() {
        for (a, b) in [
            ("9007199254740993", "9007199254740992"),
            ("0.00000000000000000002", "0.00000000000000000001"),
            ("-1e3", "-1001"),
            ("0", "-0.01"),
        ] {
            assert_eq!(compare_numbers(a, b), Ordering::Greater);
        }
        for (a, b) in [("1.00", "1e0"), ("-0", "0"), ("0.01", "1e-2")] {
            assert_eq!(compare_numbers(a, b), Ordering::Equal);
        }
        for invalid in ["", "abc", "NaN", "Infinity", "1e1000", "1.2.3", "true"] {
            assert_eq!(compare_numbers(invalid, "-999"), Ordering::Less);
        }
    }
    #[test]
    fn times_compare_microseconds_and_offsets() {
        assert_eq!(
            compare_times(
                "2026-10-20 01:00:00.000001",
                "2026-10-20T10:00:00.000001+09:00"
            ),
            Ordering::Equal
        );
        assert_eq!(
            compare_times("2026-10-20T01:00:00.000002Z", "2026-10-20 01:00:00.000001"),
            Ordering::Greater
        );
    }

    #[test]
    fn cached_times_preserve_mixed_formats_precision_and_invalid_fallback() {
        let cached = CachedTimestampCollation::default();
        let long_invalid = "日時".repeat(TIMESTAMP_CACHE_MAX_KEY_BYTES);
        let samples = [
            "2026-10-20 01:00:00.000001",
            "2026-10-20T01:00:00.000001",
            "2026-10-20T10:00:00.000001+09:00",
            "2026-10-20T01:00:00.000002Z",
            "2026-10-19T20:00:00.000001-05:00",
            "2026-10-20T01:00:00.000001001Z",
            "2016-12-31T23:59:60Z",
            "",
            "2026-02-30 01:00:00",
            "invalid\0timestamp",
            &long_invalid,
        ];
        for _ in 0..2 {
            for a in samples {
                for b in samples {
                    assert_eq!(cached.compare(a, b), compare_times(a, b), "{a:?} / {b:?}");
                }
            }
        }
        let cache = cached.cache.lock().unwrap();
        assert_eq!(cache.values.len(), samples.len() - 1);
        assert_eq!(cache.values.get(""), Some(&None));
        assert!(!cache.values.contains_key(&long_invalid));
    }

    #[test]
    fn unique_times_remain_correct_after_cache_entry_limit() {
        let cached = CachedTimestampCollation::default();
        let start = timestamp("2026-01-01 00:00:00").unwrap();
        let boundary = "2027-01-01T00:00:00Z";
        for i in 0..TIMESTAMP_CACHE_MAX_ENTRIES * 2 {
            let raw = (start + chrono::Duration::microseconds(i as i64)).to_string();
            assert_eq!(
                cached.compare(&raw, boundary),
                compare_times(&raw, boundary)
            );
        }
        let cache = cached.cache.lock().unwrap();
        assert_eq!(cache.values.len(), TIMESTAMP_CACHE_MAX_ENTRIES);
        assert!(cache.key_bytes <= TIMESTAMP_CACHE_MAX_BYTES);
        assert!(cache.values.contains_key(boundary));
        assert!(!cached.disabled.load(AtomicOrdering::Relaxed));
    }

    #[test]
    fn cache_key_bytes_are_bounded_for_invalid_values() {
        let cached = CachedTimestampCollation::default();
        let suffix = "x".repeat(TIMESTAMP_CACHE_MAX_KEY_BYTES - 8);
        for i in 0..TIMESTAMP_CACHE_MAX_ENTRIES {
            let raw = format!("{i:08}{suffix}");
            assert_eq!(cached.compare(&raw, "invalid"), raw.as_str().cmp("invalid"));
        }
        let cache = cached.cache.lock().unwrap();
        assert!(cache.values.len() < TIMESTAMP_CACHE_MAX_ENTRIES);
        assert!(cache.key_bytes <= TIMESTAMP_CACHE_MAX_BYTES);
        assert!(cache.key_bytes + TIMESTAMP_CACHE_MAX_KEY_BYTES > TIMESTAMP_CACHE_MAX_BYTES);
    }

    #[test]
    fn poisoned_timestamp_cache_falls_back_to_original_comparison() {
        let cached = CachedTimestampCollation::default();
        let _ = std::panic::catch_unwind(|| {
            let _guard = cached.cache.lock().unwrap();
            panic!("poison the cache for fallback verification");
        });
        assert!(cached.cache.is_poisoned());
        for (a, b) in [
            ("2026-10-20T10:00:00+09:00", "2026-10-20 01:00:00"),
            ("invalid", "2026-10-20 01:00:00"),
            ("invalid", "invalid"),
        ] {
            assert_eq!(cached.compare(a, b), compare_times(a, b));
        }
    }

    #[test]
    fn unhelpful_timestamp_cache_stops_and_new_collation_starts_enabled() {
        let cached = CachedTimestampCollation::default();
        let start = timestamp("2026-01-01 00:00:00").unwrap();
        for i in 0..TIMESTAMP_CACHE_SAMPLE_COMPARISONS {
            let a = (start + chrono::Duration::microseconds(i as i64 * 2)).to_string();
            let b = (start + chrono::Duration::microseconds(i as i64 * 2 + 1)).to_string();
            assert_eq!(cached.compare(&a, &b), compare_times(&a, &b));
        }
        assert!(cached.disabled.load(AtomicOrdering::Relaxed));
        let retained = cached.cache.lock().unwrap().values.len();
        let a = "2026-10-20T10:00:00.000001+09:00";
        let b = "2026-10-20 01:00:00.000001";
        assert_eq!(cached.compare(a, b), compare_times(a, b));
        assert_eq!(cached.cache.lock().unwrap().values.len(), retained);

        // begin_read は、トランザクションごとに新しい既定のコールバックを登録する。
        let next_read = CachedTimestampCollation::default();
        assert_eq!(next_read.compare(a, b), compare_times(a, b));
        assert!(!next_read.disabled.load(AtomicOrdering::Relaxed));
        assert_eq!(next_read.cache.lock().unwrap().values.len(), 2);
    }

    /// 比較処理のみの計測とし、SQLite・SQLx・入出力・UI の処理は含めない。
    /// リリースモードで --ignored --nocapture を指定して実行する。時間のしきい値は設けない。
    #[test]
    #[ignore = "manual timestamp collation performance measurement"]
    fn timestamp_collation_performance() {
        use std::time::Instant;

        const ROWS: usize = 20_000;
        const SAMPLES: usize = 5;

        struct Measurement {
            times_ms: [f64; 2],
            matches: Vec<bool>,
            order: Vec<usize>,
            sort_comparisons: usize,
        }

        fn measure(
            rows: &[String],
            as_of: &str,
            mut compare: impl FnMut(&str, &str) -> Ordering,
        ) -> Measurement {
            let started = Instant::now();
            let matches = rows
                .iter()
                .map(|raw| compare(raw, as_of) != Ordering::Greater)
                .collect();
            let boundary_ms = started.elapsed().as_secs_f64() * 1000.0;
            let mut order: Vec<_> = (0..rows.len()).collect();
            let mut sort_comparisons = 0;
            let started = Instant::now();
            order.sort_unstable_by(|a, b| {
                sort_comparisons += 1;
                compare(&rows[*b], &rows[*a]).then_with(|| b.cmp(a))
            });
            Measurement {
                times_ms: [boundary_ms, started.elapsed().as_secs_f64() * 1000.0],
                matches,
                order,
                sort_comparisons,
            }
        }

        fn summary(times: &[[f64; 2]], phase: usize) -> String {
            let mut values: Vec<_> = times
                .iter()
                .map(|sample| match phase {
                    0 | 1 => sample[phase],
                    _ => sample[0] + sample[1],
                })
                .collect();
            values.sort_by(f64::total_cmp);
            format!(
                "median={:.3},min={:.3},max={:.3}",
                values[values.len() / 2],
                values[0],
                values[values.len() - 1]
            )
        }

        let start = timestamp("2026-01-01 00:00:00").unwrap();
        let as_of = (start + chrono::Duration::seconds(ROWS as i64)).to_string();
        for repeated in [true, false] {
            let mut rows: Vec<_> = (0..ROWS)
                .map(|i| {
                    let seconds = if repeated { i % 4 * (ROWS - 1) / 3 } else { i };
                    (start + chrono::Duration::seconds(seconds as i64))
                        .format("%Y-%m-%d %H:%M:%S%.6f")
                        .to_string()
                })
                .collect();
            // 再現可能な未整列の入力を使い、乱数への依存を避ける。
            let mut state = 0x9e3779b97f4a7c15_u64;
            for i in (1..ROWS).rev() {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                rows.swap(i, state as usize % (i + 1));
            }
            let mut original_times = Vec::with_capacity(SAMPLES);
            let mut cached_times = Vec::with_capacity(SAMPLES);
            let mut sort_comparisons = 0;
            for trial in 0..=SAMPLES {
                let measure_cached = || {
                    let cached = CachedTimestampCollation::default();
                    measure(&rows, &as_of, |a, b| cached.compare(a, b))
                };
                let (original, cached) = if trial % 2 == 0 {
                    (measure(&rows, &as_of, compare_times), measure_cached())
                } else {
                    let cached = measure_cached();
                    (measure(&rows, &as_of, compare_times), cached)
                };
                assert_eq!(original.matches, cached.matches);
                assert_eq!(original.order, cached.order);
                assert_eq!(original.sort_comparisons, cached.sort_comparisons);
                sort_comparisons = original.sort_comparisons;
                if trial > 0 {
                    original_times.push(original.times_ms);
                    cached_times.push(cached.times_ms);
                }
            }
            let scenario = if repeated {
                "four_timestamps"
            } else {
                "unique_timestamps"
            };
            println!(
                "timestamp_collation scenario={scenario} rows={ROWS} samples={SAMPLES} warmup=1 sort_comparisons={sort_comparisons}"
            );
            for (label, times) in [("original", &original_times), ("cached", &cached_times)] {
                println!(
                    "{label} as_of_ms[{}] sort_ms[{}] total_ms[{}]",
                    summary(times, 0),
                    summary(times, 1),
                    summary(times, 2)
                );
            }
        }
    }
}
