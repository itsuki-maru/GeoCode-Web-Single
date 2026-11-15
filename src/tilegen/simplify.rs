use anyhow::{Result, ensure};

use crate::tilegen::geometry::Point;

/// 共有ノードを固定したまま、Way全体をDouglas-Peucker法で簡略化する。
pub fn simplify(points: &[Point], protected: &[bool], epsilon: f64) -> Result<Vec<Point>> {
    simplify_with_check(points, protected, epsilon, || Ok(()))
}

pub(crate) fn simplify_with_check(
    points: &[Point],
    protected: &[bool],
    epsilon: f64,
    mut check: impl FnMut() -> Result<()>,
) -> Result<Vec<Point>> {
    check()?;
    ensure!(
        points.len() == protected.len(),
        "protected vertex count does not match geometry"
    );
    ensure!(
        epsilon.is_finite() && epsilon >= 0.0,
        "invalid simplification tolerance"
    );
    for (index, point) in points.iter().enumerate() {
        if index.is_multiple_of(1024) {
            check()?;
        }
        ensure!(
            point.x.is_finite() && point.y.is_finite(),
            "non-finite simplification coordinate"
        );
    }
    if points.len() <= 2 {
        check()?;
        return Ok(points.to_vec());
    }
    let mut keep = protected.to_vec();
    keep[0] = true;
    keep[points.len() - 1] = true;
    if points[0] == points[points.len() - 1] {
        // 閉じたループが1点や2点へ潰れることを防ぐ。
        let far = max_checked(
            1..points.len() - 1,
            |index| distance_squared(points[index], points[0]),
            &mut check,
        )?
        .unwrap_or(1);
        keep[far] = true;
        if let Some(third) = max_checked(
            (1..points.len() - 1).filter(|i| *i != far),
            |index| segment_distance_squared(points[index], points[0], points[far]),
            &mut check,
        )? {
            keep[third] = true;
        }
    }
    let mut anchors = Vec::new();
    for (index, &yes) in keep.iter().enumerate() {
        if index.is_multiple_of(1024) {
            check()?;
        }
        if yes {
            anchors.push(index);
        }
    }
    let threshold = epsilon * epsilon;
    let mut stack = Vec::new();
    for pair in anchors.windows(2) {
        check()?;
        stack.push((pair[0], pair[1]));
        while let Some((first, last)) = stack.pop() {
            check()?;
            if last <= first + 1 {
                continue;
            }
            let mut farthest = first;
            let mut distance = threshold;
            for i in first + 1..last {
                if (i - first).is_multiple_of(1024) {
                    check()?;
                }
                let d = segment_distance_squared(points[i], points[first], points[last]);
                if d > distance {
                    distance = d;
                    farthest = i;
                }
            }
            if farthest != first {
                keep[farthest] = true;
                stack.push((first, farthest));
                stack.push((farthest, last));
            }
        }
    }
    let mut simplified = Vec::new();
    for (index, (&point, yes)) in points.iter().zip(keep).enumerate() {
        if index.is_multiple_of(1024) {
            check()?;
        }
        if yes {
            simplified.push(point);
        }
    }
    check()?;
    Ok(simplified)
}

fn max_checked(
    indexes: impl Iterator<Item = usize>,
    mut score: impl FnMut(usize) -> f64,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Option<usize>> {
    let mut best: Option<(usize, f64)> = None;
    for (offset, index) in indexes.enumerate() {
        if offset.is_multiple_of(1024) {
            check()?;
        }
        let distance = score(index);
        if best.is_none_or(|(_, value)| distance.total_cmp(&value).is_ge()) {
            best = Some((index, distance));
        }
    }
    Ok(best.map(|(index, _)| index))
}

fn distance_squared(a: Point, b: Point) -> f64 {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    dx * dx + dy * dy
}

fn segment_distance_squared(point: Point, a: Point, b: Point) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let length = dx * dx + dy * dy;
    if length == 0.0 {
        return distance_squared(point, a);
    }
    let t = (((point.x - a.x) * dx + (point.y - a.y) * dy) / length).clamp(0.0, 1.0);
    distance_squared(
        point,
        Point {
            x: a.x + t * dx,
            y: a.y + t * dy,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protects_junction_and_endpoints() {
        let points: Vec<_> = (0..5)
            .map(|i| Point {
                x: f64::from(i) * 0.2,
                y: 0.5,
            })
            .collect();
        let reduced = simplify(&points, &[false, false, true, false, false], 1.0).unwrap();
        assert_eq!(reduced, vec![points[0], points[2], points[4]]);
    }

    #[test]
    fn preserves_loop_and_large_bend() {
        let points = [
            Point { x: 0.0, y: 0.0 },
            Point { x: 1.0, y: 0.0 },
            Point { x: 1.0, y: 1.0 },
            Point { x: 0.0, y: 0.0 },
        ];
        let reduced = simplify(&points, &[false; 4], 100.0).unwrap();
        assert_eq!(reduced, points);
        let zigzag = [
            Point { x: 0.0, y: 0.0 },
            Point { x: 0.5, y: 0.25 },
            Point { x: 1.0, y: 0.0 },
        ];
        assert_eq!(simplify(&zigzag, &[false; 3], 0.2).unwrap(), zigzag);
        assert_eq!(simplify(&zigzag, &[false; 3], 0.3).unwrap().len(), 2);
    }

    #[test]
    fn validates_input() {
        assert!(simplify(&[Point { x: 0.0, y: 0.0 }], &[], 0.1).is_err());
        assert!(simplify(&[], &[], f64::NAN).is_err());
    }

    #[test]
    fn checked_simplification_interrupts_a_long_way() {
        let points: Vec<_> = (0..20_000)
            .map(|i| Point {
                x: f64::from(i) / 20_000.0,
                y: f64::from(i % 2) * 0.01,
            })
            .collect();
        let mut checks = 0;
        let error = simplify_with_check(&points, &vec![false; points.len()], 0.001, || {
            checks += 1;
            if checks == 24 {
                anyhow::bail!(crate::tilegen::cancel::Interrupted);
            }
            Ok(())
        })
        .unwrap_err();
        assert!(crate::tilegen::cancel::is_interrupted(&error));
    }
}
