//! Node IDで面の輪郭を連結し、穴の所属と交差を上限付きで検査する。

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail, ensure};

use super::model::PolygonPart;
use crate::tilegen::{
    geometry::Point,
    operation::OperationContext,
    pbf::{MemberKind, Relation},
};

mod contacts;

const MAX_POINTS: usize = 1_000_000;
const MAX_RINGS: usize = 16_384;
const MAX_INTERSECTIONS: usize = 2_000_000;

#[derive(Debug)]
struct RingContact;
impl std::fmt::Display for RingContact {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("面の外周・穴が交差または接触しています")
    }
}
impl std::error::Error for RingContact {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RingRole {
    Outer,
    Inner,
}

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
    let indices = rings
        .iter()
        .map(|ring| EdgeIndex::new(ring, &mut || context.check()))
        .collect::<Result<Vec<_>>>()?;
    let bounds: Vec<_> = indices.iter().map(EdgeIndex::bounds).collect();
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
            if bounds[i].overlaps(bounds[j]) {
                disjoint(&indices[i], &indices[j], &mut budget, &mut || {
                    context.check()
                })?;
            }
        }
        for j in 0..n {
            if i == j {
                continue;
            }
            budget = budget
                .checked_sub(1)
                .context("輪郭の包含検査量が上限を超えました")?;
            if bounds[j].encloses(bounds[i])
                && parents[i].is_none_or(|p| area[j] < area[p])
                && indices[j].contains(rings[i][0], &mut budget, &mut || context.check())?
            {
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

/// 接点を持つ原形のLODだけに使う。非接触原形は従来の厳密な検査を維持する。
pub(crate) fn polygon_from_rings_with_contacts(
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
        .map(|ring| normalize_ring(ring, &mut || context.check()))
        .collect::<Result<Vec<_>>>()?;
    let roles = vec![None; rings.len()];
    let mut budget = MAX_INTERSECTIONS;
    contacts::assemble(rings, roles, false, &mut budget, &mut || context.check())
}

/// 原形の輪郭間接点をLODで固定する。順序は各partの外周、続いて穴。
pub(crate) fn topology_locks(
    parts: &[PolygonPart],
    context: &OperationContext,
) -> Result<Vec<Vec<bool>>> {
    contacts::locks(parts, context)
}
/// 欠損innerだけを落とすと塗り潰し事故になるため、常に面全体を成功か失敗にする。
pub fn relation(
    relation: &Relation,
    mut load_way: impl FnMut(i64) -> Result<Vec<i64>>,
    mut load_node: impl FnMut(i64) -> Result<Point>,
    mut check: impl FnMut() -> Result<()>,
) -> Result<Vec<PolygonPart>> {
    ensure!(!relation.members.is_empty(), "面Relationのmemberが空です");
    let mut ways = BTreeMap::new();
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
        let role = match member.role.as_str() {
            "outer" => Some(RingRole::Outer),
            "inner" => Some(RingRole::Inner),
            "" => None,
            _ => bail!("面Relationの未知のroleです"),
        };
        let nodes = load_way(member.id)
            .with_context(|| format!("面のmember Way {}がありません", member.id))?;
        ensure!(nodes.len() >= 2, "面memberの点数が不足しています");
        total = total
            .checked_add(nodes.len())
            .context("面の点数が桁あふれしました")?;
        ensure!(total <= MAX_POINTS, "面全体の点数上限を超えました");
        ways.insert(member.id, (nodes, role));
    }
    let stitched = stitch(ways, &mut check)?;
    ensure!(!stitched.is_empty(), "面の外周がありません");
    let mut rings = Vec::with_capacity(stitched.len());
    let mut roles = Vec::with_capacity(stitched.len());
    for (ids, role) in stitched {
        let mut points = Vec::with_capacity(ids.len());
        for (index, id) in ids.into_iter().enumerate() {
            if index.is_multiple_of(1024) {
                check()?;
            }
            points.push(load_node(id)?);
        }
        rings.push(normalize_ring(points, &mut check)?);
        roles.push(role);
    }
    let mut budget = MAX_INTERSECTIONS;
    let mut parts = match strict_relation_parts(&rings, &roles, &mut budget, &mut check) {
        Ok(parts) => parts,
        Err(error) if error.is::<RingContact>() => {
            contacts::assemble(rings, roles, true, &mut budget, &mut check)?
        },
        Err(error) => return Err(error),
    };
    parts.sort_by(|a, b| {
        a.outer[0]
            .x
            .total_cmp(&b.outer[0].x)
            .then(a.outer[0].y.total_cmp(&b.outer[0].y))
    });
    Ok(parts)
}

// 既存の成功する面は検査順、検査予算、出力順をそのまま維持する。
fn strict_relation_parts(
    rings: &[Vec<Point>],
    roles: &[Option<RingRole>],
    budget: &mut usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Vec<PolygonPart>> {
    let count = rings.len();
    let indices = rings
        .iter()
        .map(|ring| EdgeIndex::new(ring, check))
        .collect::<Result<Vec<_>>>()?;
    let bounds: Vec<_> = indices.iter().map(EdgeIndex::bounds).collect();
    let areas: Vec<_> = rings
        .iter()
        .map(|ring| {
            ring.windows(2)
                .map(|edge| cross(ring[0], edge[0], edge[1]))
                .sum::<f64>()
                .abs()
        })
        .collect();
    let mut parents = vec![None; count];
    for i in 0..count {
        for j in i + 1..count {
            check()?;
            *budget = budget
                .checked_sub(1)
                .context("輪郭間検査量が上限を超えました")?;
            if bounds[i].overlaps(bounds[j]) {
                disjoint(&indices[i], &indices[j], budget, check)?;
            }
            // 接触・交差がない輪郭だけを、最小の包含輪郭に結び付ける。
            // 外周→穴→島→島内の穴も、単一のRelation内で表現できる。
            for (child, parent) in [(i, j), (j, i)] {
                if bounds[parent].encloses(bounds[child])
                    && parents[child].is_none_or(|previous| areas[parent] < areas[previous])
                    && indices[parent].contains(rings[child][0], budget, check)?
                {
                    parents[child] = Some(parent);
                }
            }
        }
    }
    let mut depths = Vec::with_capacity(count);
    for i in 0..count {
        check()?;
        let (mut parent, mut depth) = (parents[i], 0);
        while let Some(index) = parent {
            check()?;
            depth += 1;
            ensure!(depth < count, "輪郭の包含関係が循環しています");
            parent = parents[index];
        }
        let inferred = if depth % 2 == 0 {
            RingRole::Outer
        } else {
            RingRole::Inner
        };
        ensure!(
            roles[i].is_none_or(|role| role == inferred),
            "面のmember roleと輪郭の包含関係が矛盾しています"
        );
        depths.push(depth);
    }
    let mut parts = Vec::new();
    for i in 0..count {
        check()?;
        if depths[i] % 2 != 0 {
            continue;
        }
        let mut holes = Vec::new();
        for j in 0..count {
            if parents[j] == Some(i) {
                let mut hole = rings[j].clone();
                hole.reverse();
                holes.push(hole);
            }
        }
        parts.push(PolygonPart {
            outer: rings[i].clone(),
            holes,
        });
    }
    Ok(parts)
}

fn stitch(
    mut ways: BTreeMap<i64, (Vec<i64>, Option<RingRole>)>,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Vec<(Vec<i64>, Option<RingRole>)>> {
    let mut endpoints: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
    for (&id, (nodes, _)) in &ways {
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
    while let Some((_, (mut ring, mut role))) = ways.pop_first() {
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
            let (mut nodes, next_role) = ways.remove(&next[0]).unwrap();
            ensure!(
                role.is_none() || next_role.is_none() || role == next_role,
                "1つの輪郭にouterとinnerのroleが混在しています"
            );
            role = role.or(next_role);
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
        rings.push((ring, role));
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
    a: &EdgeIndex<'_>,
    b: &EdgeIndex<'_>,
    budget: &mut usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    // 輪郭ごとに構築したindexを使い回し、小さい輪郭だけを問い合わせる。
    // 大外周を穴の数だけ再走査・再構築しない。
    let (query, index) = if a.points.len() <= b.points.len() {
        (a, b)
    } else {
        (b, a)
    };
    for edge in query.points.windows(2) {
        consume_budget(budget, "輪郭間の交差検査量が上限を超えました", check)?;
        index.ensure_disjoint(edge[0], edge[1], budget, check)?;
    }
    Ok(())
}

fn consume_budget(
    budget: &mut usize,
    message: &'static str,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    *budget = budget.checked_sub(1).context(message)?;
    if budget.is_multiple_of(1024) {
        check()?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct EdgeBounds {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

impl EdgeBounds {
    fn new(a: Point, b: Point) -> Self {
        Self {
            min_x: a.x.min(b.x),
            min_y: a.y.min(b.y),
            max_x: a.x.max(b.x),
            max_y: a.y.max(b.y),
        }
    }

    fn extend(self, other: Self) -> Self {
        Self {
            min_x: self.min_x.min(other.min_x),
            min_y: self.min_y.min(other.min_y),
            max_x: self.max_x.max(other.max_x),
            max_y: self.max_y.max(other.max_y),
        }
    }

    fn overlaps(self, other: Self) -> bool {
        self.min_x <= other.max_x
            && other.min_x <= self.max_x
            && self.min_y <= other.max_y
            && other.min_y <= self.max_y
    }

    fn encloses(self, other: Self) -> bool {
        self.min_x <= other.min_x
            && self.min_y <= other.min_y
            && self.max_x >= other.max_x
            && self.max_y >= other.max_y
    }

    fn intersects_ray(self, p: Point) -> bool {
        self.min_y <= p.y && p.y <= self.max_y && p.x <= self.max_x
    }
}

enum EdgeNode {
    Leaf {
        bounds: EdgeBounds,
        start: usize,
        end: usize,
    },
    Branch {
        bounds: EdgeBounds,
        left: usize,
        right: usize,
    },
}

impl EdgeNode {
    fn bounds(&self) -> EdgeBounds {
        match self {
            Self::Leaf { bounds, .. } | Self::Branch { bounds, .. } => *bounds,
        }
    }
}

struct EdgeIndex<'a> {
    points: &'a [Point],
    order: Vec<usize>,
    nodes: Vec<EdgeNode>,
    root: usize,
}

impl<'a> EdgeIndex<'a> {
    fn new(points: &'a [Point], check: &mut impl FnMut() -> Result<()>) -> Result<Self> {
        let mut order: Vec<_> = (0..points.len() - 1).collect();
        let mut nodes = Vec::new();
        let root = Self::build(points, &mut order, 0, &mut nodes, check)?;
        Ok(Self {
            points,
            order,
            nodes,
            root,
        })
    }

    fn bounds(&self) -> EdgeBounds {
        self.nodes[self.root].bounds()
    }

    fn build(
        points: &[Point],
        order: &mut [usize],
        start: usize,
        nodes: &mut Vec<EdgeNode>,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<usize> {
        check()?;
        let mut bounds = EdgeBounds::new(points[order[0]], points[order[0] + 1]);
        for (offset, &edge) in order.iter().enumerate().skip(1) {
            if offset.is_multiple_of(1024) {
                check()?;
            }
            bounds = bounds.extend(EdgeBounds::new(points[edge], points[edge + 1]));
        }
        let node = if order.len() <= 16 {
            EdgeNode::Leaf {
                bounds,
                start,
                end: start + order.len(),
            }
        } else {
            let along_x = bounds.max_x - bounds.min_x >= bounds.max_y - bounds.min_y;
            let center = |edge: usize| {
                let a = points[edge];
                let b = points[edge + 1];
                if along_x { a.x + b.x } else { a.y + b.y }
            };
            let middle = order.len() / 2;
            order.select_nth_unstable_by(middle, |&a, &b| {
                center(a).total_cmp(&center(b)).then(a.cmp(&b))
            });
            let (a, b) = order.split_at_mut(middle);
            let left = Self::build(points, a, start, nodes, check)?;
            let right = Self::build(points, b, start + middle, nodes, check)?;
            EdgeNode::Branch {
                bounds,
                left,
                right,
            }
        };
        let id = nodes.len();
        nodes.push(node);
        Ok(id)
    }

    fn ensure_disjoint(
        &self,
        a: Point,
        b: Point,
        budget: &mut usize,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<()> {
        const MESSAGE: &str = "輪郭間の交差検査量が上限を超えました";
        let bounds = EdgeBounds::new(a, b);
        if !bounds.overlaps(self.nodes[self.root].bounds()) {
            return Ok(());
        }
        let mut pending = vec![self.root];
        while let Some(id) = pending.pop() {
            consume_budget(budget, MESSAGE, check)?;
            if !bounds.overlaps(self.nodes[id].bounds()) {
                continue;
            }
            match self.nodes[id] {
                EdgeNode::Leaf { start, end, .. } => {
                    for &edge in &self.order[start..end] {
                        consume_budget(budget, MESSAGE, check)?;
                        let (c, d) = (self.points[edge], self.points[edge + 1]);
                        if bounds.overlaps(EdgeBounds::new(c, d)) {
                            ensure!(!intersects(a, b, c, d), RingContact);
                        }
                    }
                },
                EdgeNode::Branch { left, right, .. } => {
                    pending.push(right);
                    pending.push(left);
                },
            }
        }
        Ok(())
    }

    fn contains(
        &self,
        p: Point,
        budget: &mut usize,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<bool> {
        const MESSAGE: &str = "輪郭の包含検査量が上限を超えました";
        if !self.bounds().intersects_ray(p) {
            return Ok(false);
        }
        let mut inside = false;
        let mut pending = vec![self.root];
        while let Some(id) = pending.pop() {
            consume_budget(budget, MESSAGE, check)?;
            if !self.nodes[id].bounds().intersects_ray(p) {
                continue;
            }
            match self.nodes[id] {
                EdgeNode::Leaf { start, end, .. } => {
                    for &edge in &self.order[start..end] {
                        consume_budget(budget, MESSAGE, check)?;
                        let (a, b) = (self.points[edge], self.points[edge + 1]);
                        if !EdgeBounds::new(a, b).intersects_ray(p) {
                            continue;
                        }
                        if on_segment(a, b, p) {
                            return Ok(true);
                        }
                        if (a.y > p.y) != (b.y > p.y)
                            && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x
                        {
                            inside = !inside;
                        }
                    }
                },
                EdgeNode::Branch { left, right, .. } => {
                    pending.push(right);
                    pending.push(left);
                },
            }
        }
        Ok(inside)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tilegen::pbf::Member;

    type Fixture = (Relation, BTreeMap<i64, Vec<i64>>, BTreeMap<i64, Point>);

    fn ring_fixture(roles: &[&str], rings: Vec<Vec<Point>>) -> Fixture {
        assert_eq!(roles.len(), rings.len());
        let mut relation = Relation {
            id: 572505,
            tags: BTreeMap::new(),
            members: Vec::new(),
        };
        let mut ways = BTreeMap::new();
        let mut nodes = BTreeMap::new();
        for (index, (role, ring)) in roles.iter().zip(rings).enumerate() {
            let id = index as i64 + 1;
            let start = nodes.len() as i64 + 1;
            let mut ids = Vec::new();
            for (offset, point) in ring[..ring.len() - 1].iter().enumerate() {
                let node = start + offset as i64;
                nodes.insert(node, *point);
                ids.push(node);
            }
            ids.push(ids[0]);
            ways.insert(id, ids);
            relation.members.push(Member {
                id,
                kind: MemberKind::Way,
                role: (*role).into(),
            });
        }
        (relation, ways, nodes)
    }

    fn assemble(fixture: &Fixture, check: impl FnMut() -> Result<()>) -> Result<Vec<PolygonPart>> {
        relation(
            &fixture.0,
            |id| Ok(fixture.1[&id].clone()),
            |id| Ok(fixture.2[&id]),
            check,
        )
    }

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
    fn assembles_courtyards_and_reversed_outer_segments() -> Result<()> {
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
    fn rejects_open_rings_and_self_intersections() {
        let mut points = square(0.1, 0.1, 0.1);
        points.pop();
        assert!(closed_way(points, || Ok(())).is_err());
        let mut points = square(0.1, 0.1, 0.1);
        points.swap(1, 2);
        assert!(closed_way(points, || Ok(())).is_err());
    }

    #[test]
    fn assigns_islands_and_their_holes_to_the_nearest_outer_ring() -> Result<()> {
        let rings = vec![
            square(0.1, 0.1, 0.4),
            square(0.15, 0.15, 0.3),
            square(0.2, 0.2, 0.2),
            square(0.25, 0.25, 0.1),
        ];
        let fixture = ring_fixture(&["outer", "inner", "outer", "inner"], rings.clone());
        let parts = assemble(&fixture, || Ok(()))?;
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].outer, rings[0]);
        assert_eq!(parts[1].outer, rings[2]);
        for (part, mut expected_hole) in parts.iter().zip([rings[1].clone(), rings[3].clone()]) {
            expected_hole.reverse();
            assert_eq!(part.holes, vec![expected_hole]);
        }
        Ok(())
    }

    #[test]
    fn infers_empty_roles_without_changing_explicit_ring_geometry() -> Result<()> {
        let rings = vec![
            square(0.1, 0.1, 0.4),
            square(0.15, 0.15, 0.3),
            square(0.2, 0.2, 0.2),
            square(0.25, 0.25, 0.1),
            square(0.65, 0.2, 0.1),
        ];
        let expected = assemble(
            &ring_fixture(
                &["outer", "inner", "outer", "inner", "outer"],
                rings.clone(),
            ),
            || Ok(()),
        )?;
        for roles in [["", "", "", "", ""], ["outer", "", "outer", "", ""]] {
            let fixture = ring_fixture(&roles, rings.clone());
            assert_eq!(assemble(&fixture, || Ok(()))?, expected);
            let mut reversed = fixture.clone();
            reversed.0.members.reverse();
            for nodes in reversed.1.values_mut() {
                nodes.reverse();
            }
            assert_eq!(assemble(&reversed, || Ok(()))?, expected);
        }
        Ok(())
    }

    #[test]
    fn joins_empty_role_segments_but_rejects_conflicting_explicit_roles() -> Result<()> {
        let mut fixture = ring_fixture(&["outer"], vec![square(0.1, 0.1, 0.3)]);
        fixture.1.insert(1, vec![1, 2, 3]);
        fixture.1.insert(2, vec![1, 4, 3]);
        fixture.0.members.push(Member {
            id: 2,
            kind: MemberKind::Way,
            role: "".into(),
        });
        let expected = closed_way(square(0.1, 0.1, 0.3), || Ok(()))?;
        assert_eq!(assemble(&fixture, || Ok(()))?, expected);
        fixture.0.members[0].role.clear();
        fixture.0.members[1].role = "outer".into();
        assert_eq!(assemble(&fixture, || Ok(()))?, expected);
        fixture.0.members[0].role = "inner".into();
        assert!(
            assemble(&fixture, || Ok(()))
                .unwrap_err()
                .to_string()
                .contains("混在")
        );
        Ok(())
    }

    #[test]
    fn rejects_explicit_roles_that_conflict_with_containment() {
        for roles in [
            vec!["inner"],
            vec!["outer", "outer"],
            vec!["outer", "inner", "inner"],
        ] {
            let rings = (0..roles.len())
                .map(|index| {
                    square(
                        0.1 + index as f64 * 0.05,
                        0.1 + index as f64 * 0.05,
                        0.4 - index as f64 * 0.1,
                    )
                })
                .collect();
            let error = assemble(&ring_fixture(&roles, rings), || Ok(())).unwrap_err();
            assert!(error.to_string().contains("包含関係が矛盾"));
        }
    }

    #[test]
    fn still_rejects_crossing_touching_and_duplicate_rings_with_empty_roles() {
        for ring in [
            square(0.2, 0.2, 0.3),
            square(0.1, 0.2, 0.1),
            square(0.1, 0.1, 0.3),
        ] {
            let fixture = ring_fixture(&["", ""], vec![square(0.1, 0.1, 0.3), ring]);
            assert!(
                assemble(&fixture, || Ok(()))
                    .unwrap_err()
                    .to_string()
                    .contains("交差または接触")
            );
        }
    }

    #[test]
    fn propagates_cancellation_during_ring_assembly_and_containment() -> Result<()> {
        let fixture = ring_fixture(
            &["", "", ""],
            vec![
                square(0.1, 0.1, 0.4),
                square(0.15, 0.15, 0.3),
                square(0.2, 0.2, 0.2),
            ],
        );
        let mut checks = 0;
        assemble(&fixture, || {
            checks += 1;
            Ok(())
        })?;
        for cutoff in 0..checks {
            let mut current = 0;
            let result = assemble(&fixture, || {
                if current == cutoff {
                    bail!("cancelled-ring-operation");
                }
                current += 1;
                Ok(())
            });
            assert_eq!(result.unwrap_err().to_string(), "cancelled-ring-operation");
        }
        Ok(())
    }

    #[test]
    fn indexed_edge_queries_match_exhaustive_intersection_checks() -> Result<()> {
        let mut points = Vec::new();
        for step in 0..6 {
            points.push(Point {
                x: 0.2 + step as f64 * 0.1,
                y: 0.2,
            });
        }
        for step in 0..6 {
            points.push(Point {
                x: 0.8,
                y: 0.2 + step as f64 * 0.1,
            });
        }
        for step in 0..6 {
            points.push(Point {
                x: 0.8 - step as f64 * 0.1,
                y: 0.8,
            });
        }
        for step in 0..6 {
            points.push(Point {
                x: 0.2,
                y: 0.8 - step as f64 * 0.1,
            });
        }
        points.push(points[0]);
        // 長さ0の辺と、水平・垂直・斜め・端点接触も同じ精密判定に渡す。
        points.insert(4, points[4]);
        let index = EdgeIndex::new(&points, &mut || Ok(()))?;
        let coordinates = [0.0, 0.1, 0.2, 0.4, 0.6, 0.8, 0.9, 1.0];
        let endpoints: Vec<_> = coordinates
            .into_iter()
            .flat_map(|x| coordinates.into_iter().map(move |y| Point { x, y }))
            .collect();
        for &a in &endpoints {
            let mut budget = MAX_INTERSECTIONS;
            assert_eq!(
                index.contains(a, &mut budget, &mut || Ok(()))?,
                contains(&points, a),
                "ray query {a:?}"
            );
            for &b in &endpoints {
                let expected = points
                    .windows(2)
                    .all(|edge| !intersects(a, b, edge[0], edge[1]));
                let mut budget = MAX_INTERSECTIONS;
                let actual = index.ensure_disjoint(a, b, &mut budget, &mut || Ok(()));
                assert_eq!(actual.is_ok(), expected, "edge query {a:?} to {b:?}");
            }
        }
        assert!(
            index
                .ensure_disjoint(
                    Point { x: 0.0, y: 0.0 },
                    Point { x: 1.0, y: 1.0 },
                    &mut 0,
                    &mut || Ok(())
                )
                .unwrap_err()
                .to_string()
                .contains("上限")
        );
        Ok(())
    }

    #[test]
    fn assembles_dense_nested_rings_without_testing_the_full_edge_product() -> Result<()> {
        let circle = |radius: f64| {
            let mut points: Vec<_> = (0..4096)
                .map(|step| {
                    let angle = std::f64::consts::TAU * step as f64 / 4096.0;
                    Point {
                        x: 0.5 + radius * angle.cos(),
                        y: 0.5 + radius * angle.sin(),
                    }
                })
                .collect();
            points.push(points[0]);
            points
        };
        let fixture = ring_fixture(&["outer", "inner"], vec![circle(0.35), circle(0.3)]);
        let parts = assemble(&fixture, || Ok(()))?;
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].outer.len(), 4097);
        assert_eq!(parts[0].holes.len(), 1);
        assert_eq!(parts[0].holes[0].len(), 4097);
        Ok(())
    }

    #[test]
    fn assembles_many_holes_without_rescanning_the_large_outer_for_each_hole() -> Result<()> {
        let mut outer: Vec<_> = (0..6000)
            .map(|step| {
                let angle = std::f64::consts::TAU * step as f64 / 6000.0;
                Point {
                    x: 0.5 + 0.45 * angle.cos(),
                    y: 0.5 + 0.45 * angle.sin(),
                }
            })
            .collect();
        outer.push(outer[0]);
        let mut rings = vec![outer];
        for x in 0..14 {
            for y in 0..14 {
                rings.push(square(
                    0.25 + x as f64 * 0.035,
                    0.25 + y as f64 * 0.035,
                    0.01,
                ));
            }
        }
        let mut roles = vec!["inner"; rings.len()];
        roles[0] = "outer";
        let parts = assemble(&ring_fixture(&roles, rings), || Ok(()))?;
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].outer.len(), 6001);
        assert_eq!(parts[0].holes.len(), 196);
        Ok(())
    }
}
