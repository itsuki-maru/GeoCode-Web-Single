//! PostgreSQLのnumeric・timestamp比較をSQLiteの読み取り接続で再現する。
use chrono::{DateTime, NaiveDateTime};
use sqlx::{Sqlite, SqlitePool, Transaction};
use std::cmp::Ordering;

pub(super) async fn begin_read(
    pool: &SqlitePool,
) -> Result<Transaction<'static, Sqlite>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    {
        let mut handle = tx.lock_handle().await?;
        handle.create_collation("answer_numeric", compare_numbers)?;
        handle.create_collation("answer_time", compare_times)?;
        handle.create_collation("answer_name", |a, b| {
            a.to_lowercase().cmp(&b.to_lowercase())
        })?;
    }
    Ok(tx)
}

/// Reserve the writer before reading to avoid deferred-transaction upgrades.
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

/// Match PostgreSQL JSONB equality, including equivalent JSON number spellings.
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
}
