//! Node IDで面の輪郭を連結し、穴の所属と交差を上限付きで検査する。

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail, ensure};

use super::model::PolygonPart;
use crate::tilegen::{
    geometry::Point,
    operation::OperationContext,
    pbf::{MemberKind, Relation},
};

const MAX_POINTS: usize = 1_000_000;
const MAX_RINGS: usize = 16_384;
const MAX_INTERSECTIONS: usize = 2_000_000;

/// 閉じたWayを、複合面と同じ検査・正規化へ渡す。
pub fn closed_way(
    points: Vec<Point>,
    mut check: impl FnMut() -> Result<()>,
) -> Result<Vec<PolygonPart>> {
    let outer = normalize_ring(points, &mut check)?;
    Ok(vec![PolygonPart {
        outer,
        holes: Vec::new(),
    }])
}

/// Shapefileの向きに依存せず、包含の深さで外周・穴・穴内の島を分類する。
pub(crate) fn polygon_from_rings(
    rings: Vec<Vec<Point>>,
    context: &OperationContext,
) -> Result<Vec<PolygonPart>> {
    ensure!(
        !rings.is_empty() && rings.len() <= MAX_RINGS,
        "面の輪郭数が上限外です"
    );
    let points = rings.iter().try_fold(0usize, |n, r| {
        n.checked_add(r.len())
            .context("面の累計点数が桁あふれしました")
    })?;
    ensure!(points <= MAX_POINTS, "面全体の点数上限を超えました");
    let rings = rings
        .into_iter()
        .map(|r| normalize_ring(r, &mut || context.check()))
        .collect::<Result<Vec<_>>>()?;
    let n = rings.len();
    let mut parents = vec![None; n];
    let area: Vec<_> = rings
        .iter()
        .map(|ring| {
            ring.windows(2)
                .map(|e| cross(ring[0], e[0], e[1]))
                .sum::<f64>()
                .abs()
        })
        .collect();
    let mut budget = MAX_INTERSECTIONS;
    for i in 0..n {
        context.check()?;
        for j in i + 1..n {
            budget = budget
                .checked_sub(1)
                .context("輪郭間検査量が上限を超えました")?;
            disjoint(&rings[i], &rings[j], &mut budget, &mut || context.check())?;
        }
        for j in 0..n {
            if i == j {
                continue;
            }
            budget = budget
                .checked_sub(1)
                .context("輪郭の包含検査量が上限を超えました")?;
            if contains(&rings[j], rings[i][0]) && parents[i].is_none_or(|p| area[j] < area[p]) {
                parents[i] = Some(j);
            }
        }
    }
    let mut depths = Vec::with_capacity(n);
    for i in 0..n {
        let (mut current, mut depth) = (parents[i], 0);
        while let Some(j) = current {
            depth += 1;
            ensure!(depth < n, "輪郭の包含関係が循環しています");
            current = parents[j];
        }
        depths.push(depth);
    }
    let mut parts = Vec::new();
    for i in 0..n {
        if depths[i] % 2 != 0 {
            continue;
        }
        let mut holes = Vec::new();
        for j in 0..n {
            if parents[j] == Some(i) && depths[j] % 2 == 1 {
                let mut h = rings[j].clone();
                h.reverse();
                holes.push(h);
            }
        }
        parts.push(PolygonPart {
            outer: rings[i].clone(),
            holes,
        });
    }
    Ok(parts)
}

/// 欠損innerだけを落とすと塗り潰し事故になるため、常に面全体を成功か失敗にする。
pub fn relation(
    relation: &Relation,
    mut load_way: impl FnMut(i64) -> Result<Vec<i64>>,
    mut load_node: impl FnMut(i64) -> Result<Point>,
    mut check: impl FnMut() -> Result<()>,
) -> Result<Vec<PolygonPart>> {
    ensure!(!relation.members.is_empty(), "面Relationのmemberが空です");
    let (mut outer, mut inner) = (BTreeMap::new(), BTreeMap::new());
    let mut unique = BTreeSet::new();
    let mut total = 0usize;
    for member in &relation.members {
        check()?;
        ensure!(
            member.kind == MemberKind::Way,
            "面RelationのNode・入れ子Relationには対応していません"
        );
        ensure!(
            unique.insert(member.id),
            "面Relationに同じWayが重複しています"
        );
        let target = match member.role.as_str() {
            "outer" | "" => &mut outer,
            "inner" => &mut inner,
            _ => bail!("面Relationの未知のroleです"),
        };
        let nodes = load_way(member.id)
            .with_context(|| format!("面のmember Way {}がありません", member.id))?;
        ensure!(nodes.len() >= 2, "面memberの点数が不足しています");
        total = total
            .checked_add(nodes.len())
            .context("面の点数が桁あふれしました")?;
        ensure!(total <= MAX_POINTS, "面全体の点数上限を超えました");
        target.insert(member.id, nodes);
    }
    let mut outers = stitch(outer, &mut check)?;
    let mut inners = stitch(inner, &mut check)?;
    ensure!(!outers.is_empty(), "面の外周がありません");
    let mut convert = |ids: Vec<i64>| -> Result<Vec<Point>> {
        let mut points = Vec::with_capacity(ids.len());
        for (index, id) in ids.into_iter().enumerate() {
            if index.is_multiple_of(1024) {
                check()?;
            }
            points.push(load_node(id)?);
        }
        normalize_ring(points, &mut check)
    };
    let outers = outers
        .drain(..)
        .map(&mut convert)
        .collect::<Result<Vec<_>>>()?;
    let inners = inners
        .drain(..)
        .map(&mut convert)
        .collect::<Result<Vec<_>>>()?;
    let mut budget = MAX_INTERSECTIONS;
    for i in 0..outers.len() {
        for j in i + 1..outers.len() {
            check()?;
            disjoint(&outers[i], &outers[j], &mut budget, &mut check)?;
            ensure!(
                !contains(&outers[i], outers[j][0]) && !contains(&outers[j], outers[i][0]),
                "外周が重複または入れ子です。空roleの穴にも対応していません"
            );
        }
    }
    let mut parts: Vec<_> = outers
        .into_iter()
        .map(|outer| PolygonPart {
            outer,
            holes: Vec::new(),
        })
        .collect();
    for mut hole in inners {
        check()?;
        let owner: Vec<_> = parts
            .iter()
            .enumerate()
            .filter(|(_, p)| contains(&p.outer, hole[0]))
            .map(|(i, _)| i)
            .collect();
        ensure!(owner.len() == 1, "穴が外周1つに所属していません");
        let part = &mut parts[owner[0]];
        disjoint(&part.outer, &hole, &mut budget, &mut check)?;
        for previous in &part.holes {
            disjoint(previous, &hole, &mut budget, &mut check)?;
            ensure!(
                !contains(previous, hole[0]) && !contains(&hole, previous[0]),
                "穴が重複または入れ子です"
            );
        }
        hole.reverse();
        part.holes.push(hole);
    }
    parts.sort_by(|a, b| {
        a.outer[0]
            .x
            .total_cmp(&b.outer[0].x)
            .then(a.outer[0].y.total_cmp(&b.outer[0].y))
    });
    Ok(parts)
}

fn stitch(
    mut ways: BTreeMap<i64, Vec<i64>>,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Vec<Vec<i64>>> {
    let mut endpoints: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
    for (&id, nodes) in &ways {
        if nodes.first() != nodes.last() {
            endpoints.entry(nodes[0]).or_default().push(id);
            endpoints
                .entry(*nodes.last().unwrap())
                .or_default()
                .push(id);
        }
    }
    ensure!(
        endpoints.values().all(|v| v.len() == 2),
        "面memberの端点が閉鎖されないか分岐しています"
    );
    let mut rings = Vec::new();
    while let Some((_, mut ring)) = ways.pop_first() {
        check()?;
        while ring.first() != ring.last() {
            let tail = *ring.last().context("面memberの参照が空です")?;
            let candidates = endpoints
                .get(&tail)
                .context("面を閉じるmemberがありません")?;
            let next: Vec<_> = candidates
                .iter()
                .filter(|id| ways.contains_key(id))
                .copied()
                .collect();
            ensure!(next.len() == 1, "面の端点接続が曖昧です");
            let mut nodes = ways.remove(&next[0]).unwrap();
            if nodes[0] != tail {
                nodes.reverse();
            }
            ensure!(
                ring.len() + nodes.len() - 1 <= MAX_POINTS,
                "面の点数上限を超えました"
            );
            ring.extend(nodes.into_iter().skip(1));
            check()?;
        }
        ensure!(rings.len() < MAX_RINGS, "面の輪郭数上限を超えました");
        rings.push(ring);
    }
    Ok(rings)
}

fn cross(a: Point, b: Point, c: Point) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

fn on_segment(a: Point, b: Point, p: Point) -> bool {
    cross(a, b, p) == 0.0
        && p.x >= a.x.min(b.x)
        && p.x <= a.x.max(b.x)
        && p.y >= a.y.min(b.y)
        && p.y <= a.y.max(b.y)
}

fn intersects(a: Point, b: Point, c: Point, d: Point) -> bool {
    if a.x.min(b.x) > c.x.max(d.x)
        || c.x.min(d.x) > a.x.max(b.x)
        || a.y.min(b.y) > c.y.max(d.y)
        || c.y.min(d.y) > a.y.max(b.y)
    {
        return false;
    }
    let (ab_c, ab_d, cd_a, cd_b) = (
        cross(a, b, c),
        cross(a, b, d),
        cross(c, d, a),
        cross(c, d, b),
    );
    (ab_c.signum() != ab_d.signum() && cd_a.signum() != cd_b.signum())
        || on_segment(a, b, c)
        || on_segment(a, b, d)
        || on_segment(c, d, a)
        || on_segment(c, d, b)
}

pub fn contains(ring: &[Point], p: Point) -> bool {
    let mut inside = false;
    for edge in ring.windows(2) {
        let (a, b) = (edge[0], edge[1]);
        if on_segment(a, b, p) {
            return true;
        }
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
    }
    inside
}

fn normalize_ring(
    mut points: Vec<Point>,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Vec<Point>> {
    ensure!(points.len() <= MAX_POINTS, "輪郭の点数上限を超えました");
    points.dedup();
    ensure!(
        points.len() >= 4 && points.first() == points.last(),
        "面の輪郭が閉じていないか点数が不足しています"
    );
    let mut signed_area = 0.0;
    let origin = points[0];
    for (i, edge) in points.windows(2).enumerate() {
        if i.is_multiple_of(1024) {
            check()?;
        }
        ensure!(
            [edge[0].x, edge[0].y]
                .iter()
                .all(|v| v.is_finite() && (0.0..=1.0).contains(v)),
            "面座標が不正です"
        );
        ensure!(
            (edge[0].x - edge[1].x).abs() <= 0.5,
            "日付変更線を跨ぐ面には対応していません"
        );
        signed_area += (edge[0].x - origin.x) * (edge[1].y - origin.y)
            - (edge[1].x - origin.x) * (edge[0].y - origin.y);
    }
    ensure!(signed_area != 0.0, "面の面積が0です");
    let count = points.len() - 1;
    let mut order: Vec<_> = (0..count).collect();
    order.sort_by(|&a, &b| {
        points[a]
            .x
            .min(points[a + 1].x)
            .total_cmp(&points[b].x.min(points[b + 1].x))
            .then(a.cmp(&b))
    });
    let mut budget = MAX_INTERSECTIONS;
    for (pos, &i) in order.iter().enumerate() {
        if pos.is_multiple_of(1024) {
            check()?;
        }
        for &j in &order[pos + 1..] {
            if points[j].x.min(points[j + 1].x) > points[i].x.max(points[i + 1].x) {
                break;
            }
            if i.abs_diff(j) == 1 || (i == 0 && j == count - 1) || (j == 0 && i == count - 1) {
                continue;
            }
            budget = budget
                .checked_sub(1)
                .context("面の交差検査量が上限を超えました")?;
            if budget.is_multiple_of(1024) {
                check()?;
            }
            ensure!(
                !intersects(points[i], points[i + 1], points[j], points[j + 1]),
                "面の輪郭が自己交差しています"
            );
        }
    }
    if signed_area < 0.0 {
        points.reverse();
    }
    points.pop();
    let start = (0..points.len())
        .min_by(|&a, &b| {
            points[a]
                .x
                .total_cmp(&points[b].x)
                .then(points[a].y.total_cmp(&points[b].y))
        })
        .unwrap();
    points.rotate_left(start);
    points.push(points[0]);
    Ok(points)
}

fn disjoint(
    a: &[Point],
    b: &[Point],
    budget: &mut usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    let min_x = b.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let max_x = b.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
    let min_y = b.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
    let max_y = b.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
    for edge in a.windows(2) {
        if edge[0].x.min(edge[1].x) > max_x
            || edge[0].x.max(edge[1].x) < min_x
            || edge[0].y.min(edge[1].y) > max_y
            || edge[0].y.max(edge[1].y) < min_y
        {
            continue;
        }
        for other in b.windows(2) {
            *budget = budget
                .checked_sub(1)
                .context("輪郭間の交差検査量が上限を超えました")?;
            if budget.is_multiple_of(1024) {
                check()?;
            }
            ensure!(
                !intersects(edge[0], edge[1], other[0], other[1]),
                "面の外周・穴が交差または接触しています"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tilegen::pbf::Member;

    fn square(x: f64, y: f64, size: f64) -> Vec<Point> {
        vec![
            Point { x, y },
            Point { x: x + size, y },
            Point {
                x: x + size,
                y: y + size,
            },
            Point { x, y: y + size },
            Point { x, y },
        ]
    }

    #[test]
    fn 中庭と逆向きの分割外周を組み立てる() -> Result<()> {
        let r = Relation {
            id: 9,
            tags: BTreeMap::new(),
            members: vec![
                Member {
                    id: 11,
                    kind: MemberKind::Way,
                    role: "outer".into(),
                },
                Member {
                    id: 10,
                    kind: MemberKind::Way,
                    role: "outer".into(),
                },
                Member {
                    id: 12,
                    kind: MemberKind::Way,
                    role: "inner".into(),
                },
            ],
        };
        let ways = BTreeMap::from([
            (10, vec![1, 2, 3]),
            (11, vec![1, 4, 3]),
            (12, vec![5, 6, 7, 8, 5]),
        ]);
        let nodes: BTreeMap<_, _> = (1..=4)
            .zip(square(0.1, 0.1, 0.3))
            .chain((5..=8).zip(square(0.2, 0.2, 0.05)))
            .collect();
        let parts = relation(
            &r,
            |id| Ok(ways[&id].clone()),
            |id| Ok(nodes[&id]),
            || Ok(()),
        )?;
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].holes.len(), 1);
        Ok(())
    }

    #[test]
    fn 非閉鎖と自己交差を拒否する() {
        let mut points = square(0.1, 0.1, 0.1);
        points.pop();
        assert!(closed_way(points, || Ok(())).is_err());
        let mut points = square(0.1, 0.1, 0.1);
        points.swap(1, 2);
        assert!(closed_way(points, || Ok(())).is_err());
    }
}
