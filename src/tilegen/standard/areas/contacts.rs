//! 別輪郭の接点と、同じ外周に属する穴の共有境界を上限付きで扱う。
use super::*;

const CONTACT_ERROR: &str = "面の外周・穴が交差または接触しています";
const WORK_ERROR: &str = "輪郭の接触検査量が上限を超えました";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct PointKey(u64, u64);

impl PointKey {
    fn new(p: Point) -> Self {
        // 入力はnormalize_ringで有限な正規化座標と確認済み。-0と+0は同じ点。
        Self(
            if p.x == 0.0 { 0 } else { p.x.to_bits() },
            if p.y == 0.0 { 0 } else { p.y.to_bits() },
        )
    }
    fn point(self) -> Point {
        Point {
            x: f64::from_bits(self.0),
            y: f64::from_bits(self.1),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Location {
    Outside,
    Boundary,
    Inside,
}

enum Intersection {
    None,
    Crossing,
    Contact { points: Vec<Point>, shared: bool },
}

fn intersection(a: Point, b: Point, c: Point, d: Point) -> Intersection {
    if !EdgeBounds::new(a, b).overlaps(EdgeBounds::new(c, d)) {
        return Intersection::None;
    }
    let (u, v, w, z) = (
        cross(a, b, c),
        cross(a, b, d),
        cross(c, d, a),
        cross(c, d, b),
    );
    if ((u > 0.0 && v < 0.0) || (u < 0.0 && v > 0.0))
        && ((w > 0.0 && z < 0.0) || (w < 0.0 && z > 0.0))
    {
        return Intersection::Crossing;
    }
    let mut points = BTreeSet::new();
    for p in [a, b] {
        if on_segment(c, d, p) {
            points.insert(PointKey::new(p));
        }
    }
    for p in [c, d] {
        if on_segment(a, b, p) {
            points.insert(PointKey::new(p));
        }
    }
    if points.is_empty() {
        return Intersection::None;
    }
    let shared = u == 0.0 && v == 0.0 && w == 0.0 && z == 0.0 && points.len() > 1;
    Intersection::Contact {
        points: points.into_iter().map(PointKey::point).collect(),
        shared,
    }
}

impl EdgeIndex<'_> {
    fn has_same_edge(
        &self,
        a: Point,
        b: Point,
        budget: &mut usize,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<bool> {
        let mut same = false;
        self.visit_candidates(a, b, budget, check, |_, c, d| {
            same |= (a == c && b == d) || (a == d && b == c);
            Ok(())
        })?;
        Ok(same)
    }

    fn visit_candidates(
        &self,
        a: Point,
        b: Point,
        budget: &mut usize,
        check: &mut impl FnMut() -> Result<()>,
        mut visit: impl FnMut(usize, Point, Point) -> Result<()>,
    ) -> Result<()> {
        let bounds = EdgeBounds::new(a, b);
        if !bounds.overlaps(self.bounds()) {
            return Ok(());
        }
        let mut pending = vec![self.root];
        while let Some(id) = pending.pop() {
            consume_budget(budget, WORK_ERROR, check)?;
            if !bounds.overlaps(self.nodes[id].bounds()) {
                continue;
            }
            match self.nodes[id] {
                EdgeNode::Leaf { start, end, .. } => {
                    for &edge in &self.order[start..end] {
                        consume_budget(budget, WORK_ERROR, check)?;
                        let (c, d) = (self.points[edge], self.points[edge + 1]);
                        if bounds.overlaps(EdgeBounds::new(c, d)) {
                            visit(edge, c, d)?;
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

    fn location(
        &self,
        p: Point,
        budget: &mut usize,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<Location> {
        if !self.bounds().intersects_ray(p) {
            return Ok(Location::Outside);
        }
        let mut inside = false;
        let mut pending = vec![self.root];
        while let Some(id) = pending.pop() {
            consume_budget(budget, WORK_ERROR, check)?;
            if !self.nodes[id].bounds().intersects_ray(p) {
                continue;
            }
            match self.nodes[id] {
                EdgeNode::Leaf { start, end, .. } => {
                    for &edge in &self.order[start..end] {
                        consume_budget(budget, WORK_ERROR, check)?;
                        let (a, b) = (self.points[edge], self.points[edge + 1]);
                        if !EdgeBounds::new(a, b).intersects_ray(p) {
                            continue;
                        }
                        if on_segment(a, b, p) {
                            return Ok(Location::Boundary);
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
        Ok(if inside {
            Location::Inside
        } else {
            Location::Outside
        })
    }
}

#[derive(Debug, Default)]
struct PairContact {
    points: BTreeSet<PointKey>,
    shared: bool,
}
type Contacts = BTreeMap<(usize, usize), PairContact>;
type Splits = BTreeMap<(usize, usize), BTreeSet<PointKey>>;

fn scan(
    indices: &[EdgeIndex<'_>],
    total_points: usize,
    budget: &mut usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<(Contacts, Splits)> {
    let mut contacts = Contacts::new();
    let mut splits = Splits::new();
    let (mut contact_count, mut split_count) = (0usize, 0usize);
    for i in 0..indices.len() {
        for j in i + 1..indices.len() {
            check()?;
            consume_budget(budget, WORK_ERROR, check)?;
            if !indices[i].bounds().overlaps(indices[j].bounds()) {
                continue;
            }
            let (query, index, qi, ii) = if indices[i].points.len() <= indices[j].points.len() {
                (&indices[i], &indices[j], i, j)
            } else {
                (&indices[j], &indices[i], j, i)
            };
            for (ae, edge) in query.points.windows(2).enumerate() {
                consume_budget(budget, WORK_ERROR, check)?;
                let (a, b) = (edge[0], edge[1]);
                index.visit_candidates(a, b, budget, check, |be, c, d| {
                    match intersection(a, b, c, d) {
                        Intersection::None => {},
                        Intersection::Crossing => bail!(CONTACT_ERROR),
                        Intersection::Contact { points, shared } => {
                            let pair = contacts.entry((i, j)).or_default();
                            pair.shared |= shared;
                            for p in points {
                                let key = PointKey::new(p);
                                if pair.points.insert(key) {
                                    contact_count =
                                        contact_count.checked_add(1).context(WORK_ERROR)?;
                                    ensure!(
                                        contact_count <= MAX_POINTS,
                                        "接点の累計数が上限を超えました"
                                    );
                                }
                                for (ring, edge, start, end) in [(qi, ae, a, b), (ii, be, c, d)] {
                                    if p != start
                                        && p != end
                                        && splits.entry((ring, edge)).or_default().insert(key)
                                    {
                                        split_count =
                                            split_count.checked_add(1).context(WORK_ERROR)?;
                                        ensure!(
                                            total_points
                                                .checked_add(split_count)
                                                .is_some_and(|n| n <= MAX_POINTS),
                                            "面全体の点数上限を超えました"
                                        );
                                    }
                                }
                            }
                        },
                    }
                    Ok(())
                })?;
            }
        }
    }
    Ok((contacts, splits))
}

fn insert_splits(
    rings: &mut [Vec<Point>],
    splits: Splits,
    budget: &mut usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    let mut by_ring = BTreeMap::<usize, BTreeMap<usize, BTreeSet<PointKey>>>::new();
    for ((ring, edge), points) in splits {
        by_ring.entry(ring).or_default().insert(edge, points);
    }
    for (ring, cuts) in by_ring {
        let mut result = Vec::new();
        for (edge, pair) in rings[ring].windows(2).enumerate() {
            consume_budget(budget, WORK_ERROR, check)?;
            ensure!(result.len() < MAX_POINTS, "輪郭の点数上限を超えました");
            result.push(pair[0]);
            if let Some(points) = cuts.get(&edge) {
                let mut append = |p: &PointKey| -> Result<()> {
                    consume_budget(budget, WORK_ERROR, check)?;
                    ensure!(result.len() < MAX_POINTS, "輪郭の点数上限を超えました");
                    result.push(p.point());
                    Ok(())
                };
                if PointKey::new(pair[0]) < PointKey::new(pair[1]) {
                    for p in points {
                        append(p)?;
                    }
                } else {
                    for p in points.iter().rev() {
                        append(p)?;
                    }
                }
            }
        }
        ensure!(result.len() < MAX_POINTS, "輪郭の点数上限を超えました");
        result.push(result[0]);
        rings[ring] = normalize_ring(result, check)?;
    }
    Ok(())
}

fn ring_location(
    ring: &[Point],
    index: &EdgeIndex<'_>,
    budget: &mut usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Location> {
    let mut location = Location::Boundary;
    for edge in ring.windows(2) {
        consume_budget(budget, WORK_ERROR, check)?;
        let vertex = index.location(edge[0], budget, check)?;
        // noding後の同一端点ペアは、演算で求めた中点の丸めに依存せず共有境界。
        let shared =
            vertex == Location::Boundary && index.has_same_edge(edge[0], edge[1], budget, check)?;
        let midpoint = if shared {
            Location::Boundary
        } else {
            consume_budget(budget, WORK_ERROR, check)?;
            index.location(
                Point {
                    x: edge[0].x + (edge[1].x - edge[0].x) * 0.5,
                    y: edge[0].y + (edge[1].y - edge[0].y) * 0.5,
                },
                budget,
                check,
            )?
        };
        for current in [vertex, midpoint] {
            if current == Location::Boundary {
                continue;
            }
            ensure!(
                location == Location::Boundary || location == current,
                CONTACT_ERROR
            );
            location = current;
        }
    }
    ensure!(location != Location::Boundary, CONTACT_ERROR);
    Ok(location)
}

struct Analysis {
    parents: Vec<Option<usize>>,
    depths: Vec<usize>,
    contacts: Contacts,
}

fn hierarchy(
    rings: &[Vec<Point>],
    roles: &[Option<RingRole>],
    indices: &[EdgeIndex<'_>],
    contacts: Contacts,
    budget: &mut usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Analysis> {
    let areas: Vec<_> = rings.iter().map(|ring| signed_area(ring).abs()).collect();
    let mut parents = vec![None; rings.len()];
    for i in 0..rings.len() {
        for j in i + 1..rings.len() {
            check()?;
            consume_budget(budget, WORK_ERROR, check)?;
            let contact = contacts.get(&(i, j));
            let locations = if contact.is_some() {
                Some((
                    ring_location(&rings[i], &indices[j], budget, check)?,
                    ring_location(&rings[j], &indices[i], budget, check)?,
                ))
            } else {
                None
            };
            for (child, parent, location) in [
                (i, j, locations.map(|l| l.0)),
                (j, i, locations.map(|l| l.1)),
            ] {
                if !indices[parent].bounds().encloses(indices[child].bounds()) {
                    continue;
                }
                if !parents[child].is_none_or(|previous| areas[parent] < areas[previous]) {
                    continue;
                }
                let contained = match location {
                    Some(value) => value == Location::Inside,
                    None => indices[parent].contains(rings[child][0], budget, check)?,
                };
                if contained {
                    parents[child] = Some(parent);
                }
            }
        }
    }
    let mut depths = Vec::with_capacity(rings.len());
    for i in 0..rings.len() {
        let (mut current, mut depth) = (parents[i], 0);
        while let Some(parent) = current {
            consume_budget(budget, WORK_ERROR, check)?;
            depth += 1;
            ensure!(depth < rings.len(), "輪郭の包含関係が循環しています");
            current = parents[parent];
        }
        let role = if depth % 2 == 0 {
            RingRole::Outer
        } else {
            RingRole::Inner
        };
        ensure!(
            roles[i].is_none_or(|value| value == role),
            "面のmember roleと輪郭の包含関係が矛盾しています"
        );
        depths.push(depth);
    }
    Ok(Analysis {
        parents,
        depths,
        contacts,
    })
}

fn analyze(
    rings: &mut [Vec<Point>],
    roles: &[Option<RingRole>],
    budget: &mut usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Analysis> {
    let total = total_points(rings)?;
    let indices = rings
        .iter()
        .map(|r| EdgeIndex::new(r, check))
        .collect::<Result<Vec<_>>>()?;
    let (contacts, splits) = scan(&indices, total, budget, check)?;
    if splits.is_empty() {
        return hierarchy(rings, roles, &indices, contacts, budget, check);
    }
    drop(indices);
    insert_splits(rings, splits, budget, check)?;
    total_points(rings)?;
    let indices = rings
        .iter()
        .map(|r| EdgeIndex::new(r, check))
        .collect::<Result<Vec<_>>>()?;
    hierarchy(rings, roles, &indices, contacts, budget, check)
}

fn total_points(rings: &[Vec<Point>]) -> Result<usize> {
    ensure!(
        !rings.is_empty() && rings.len() <= MAX_RINGS,
        "面の輪郭数が上限外です"
    );
    let total = rings.iter().try_fold(0usize, |n, r| {
        n.checked_add(r.len())
            .context("面の累計点数が桁あふれしました")
    })?;
    ensure!(total <= MAX_POINTS, "面全体の点数上限を超えました");
    Ok(total)
}

fn signed_area(ring: &[Point]) -> f64 {
    ring.windows(2)
        .map(|edge| cross(ring[0], edge[0], edge[1]))
        .sum()
}

struct Sets {
    parent: Vec<usize>,
    rank: Vec<u8>,
}
impl Sets {
    fn new(count: usize) -> Self {
        Self {
            parent: (0..count).collect(),
            rank: vec![0; count],
        }
    }
    fn root(&mut self, mut i: usize) -> usize {
        let mut root = i;
        while self.parent[root] != root {
            root = self.parent[root];
        }
        while self.parent[i] != i {
            let next = self.parent[i];
            self.parent[i] = root;
            i = next;
        }
        root
    }
    fn join(&mut self, a: usize, b: usize) -> bool {
        let (mut a, mut b) = (self.root(a), self.root(b));
        if a == b {
            return false;
        }
        if self.rank[a] < self.rank[b] {
            std::mem::swap(&mut a, &mut b);
        }
        self.parent[b] = a;
        if self.rank[a] == self.rank[b] {
            self.rank[a] += 1;
        }
        true
    }
}

fn connected_interiors(
    analysis: &Analysis,
    budget: &mut usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    let count = analysis.parents.len();
    let owners: Vec<_> = (0..count)
        .map(|i| {
            if analysis.depths[i] % 2 == 0 {
                i
            } else {
                analysis.parents[i].unwrap()
            }
        })
        .collect();
    let mut points = BTreeMap::<(usize, PointKey), BTreeSet<usize>>::new();
    let mut links = 0usize;
    for (&(i, j), contact) in &analysis.contacts {
        ensure!(!contact.shared, CONTACT_ERROR);
        if owners[i] != owners[j] {
            continue;
        }
        for &point in &contact.points {
            consume_budget(budget, WORK_ERROR, check)?;
            let incident = points.entry((owners[i], point)).or_default();
            for ring in [i, j] {
                if incident.insert(ring) {
                    links = links.checked_add(1).context(WORK_ERROR)?;
                    ensure!(links <= MAX_POINTS, "接点の累計数が上限を超えました");
                }
            }
        }
    }
    let mut sets = Sets::new(count.checked_add(points.len()).context(WORK_ERROR)?);
    for (offset, (_, incident)) in points.into_iter().enumerate() {
        for ring in incident {
            consume_budget(budget, WORK_ERROR, check)?;
            ensure!(
                sets.join(ring, count + offset),
                "面の外周・穴が交差または接触しています（接点が内部を分断）"
            );
        }
    }
    Ok(())
}

fn union_group(
    rings: &[Vec<Point>],
    group: &[usize],
    budget: &mut usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Vec<(Vec<Point>, Option<RingRole>)>> {
    let mut points = BTreeSet::new();
    for &ring in group {
        for &p in &rings[ring] {
            consume_budget(budget, WORK_ERROR, check)?;
            points.insert(PointKey::new(p));
        }
    }
    ensure!(points.len() <= MAX_POINTS, "面全体の点数上限を超えました");
    let points: Vec<_> = points.into_iter().collect();
    let mut edges = BTreeSet::<(usize, usize)>::new();
    let mut usage = BTreeMap::<(usize, usize), u8>::new();
    for &ring in group {
        for edge in rings[ring].windows(2) {
            consume_budget(budget, WORK_ERROR, check)?;
            let (a, b) = (
                points.binary_search(&PointKey::new(edge[0])).unwrap(),
                points.binary_search(&PointKey::new(edge[1])).unwrap(),
            );
            ensure!(a != b, "面の共有境界に長さ0の辺があります");
            let used = usage.entry((a.min(b), a.max(b))).or_default();
            *used = used.checked_add(1).context(WORK_ERROR)?;
            ensure!(*used <= 2, "面の共有境界に3つ以上の輪郭が重複しています");
            if !edges.remove(&(b, a)) {
                ensure!(edges.insert((a, b)), "面の共有境界が重複しています");
            }
        }
    }
    ensure!(!edges.is_empty(), "面の共有境界を除いた輪郭がありません");
    let mut degree = vec![(0usize, 0usize); points.len()];
    for &(a, b) in &edges {
        consume_budget(budget, WORK_ERROR, check)?;
        degree[a].0 = degree[a].0.checked_add(1).context(WORK_ERROR)?;
        degree[b].1 = degree[b].1.checked_add(1).context(WORK_ERROR)?;
    }
    for (a, b) in &degree {
        consume_budget(budget, WORK_ERROR, check)?;
        ensure!(a == b, "面の共有境界を除いた端点が閉鎖されません");
    }
    drop(degree);
    let mut loops = Vec::new();
    let mut emitted = 0usize;
    let mut position = vec![usize::MAX; points.len()];
    while let Some(&(start, _)) = edges.first() {
        let mut path = vec![start];
        position[start] = 0;
        loop {
            consume_budget(budget, WORK_ERROR, check)?;
            let current = *path.last().unwrap();
            let next = edges
                .range((current, 0)..=(current, usize::MAX))
                .next()
                .copied();
            let Some(edge) = next else {
                ensure!(path.len() == 1, "面の共有境界を閉路へ分解できません");
                break;
            };
            edges.remove(&edge);
            let next = edge.1;
            if position[next] != usize::MAX {
                let from = position[next];
                let length = path.len() - from + 1;
                emitted = emitted.checked_add(length).context(WORK_ERROR)?;
                ensure!(
                    emitted <= MAX_POINTS && loops.len() < MAX_RINGS,
                    "面全体の点数・輪郭数上限を超えました"
                );
                let mut ring: Vec<_> = path[from..].iter().map(|&id| points[id].point()).collect();
                ring.push(points[next].point());
                let area = signed_area(&ring);
                ensure!(area != 0.0, "面の共有境界から面積0の輪郭が生成されました");
                let role = if area > 0.0 {
                    RingRole::Inner
                } else {
                    RingRole::Outer
                };
                loops.push((normalize_ring(ring, check)?, Some(role)));
                for &id in &path[from + 1..] {
                    position[id] = usize::MAX;
                }
                path.truncate(from + 1);
            } else {
                ensure!(path.len() < MAX_POINTS, "輪郭の点数上限を超えました");
                position[next] = path.len();
                path.push(next);
            }
        }
        for id in path {
            position[id] = usize::MAX;
        }
    }
    loops.sort_by(|a, b| PointKey::new(a.0[0]).cmp(&PointKey::new(b.0[0])));
    Ok(loops)
}

fn merge_holes(
    rings: Vec<Vec<Point>>,
    roles: Vec<Option<RingRole>>,
    analysis: &Analysis,
    budget: &mut usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<(Vec<Vec<Point>>, Vec<Option<RingRole>>)> {
    let mut sets = Sets::new(rings.len());
    for (&(i, j), contact) in &analysis.contacts {
        if !contact.shared {
            continue;
        }
        consume_budget(budget, WORK_ERROR, check)?;
        ensure!(
            analysis.depths[i] % 2 == 1
                && analysis.depths[j] % 2 == 1
                && analysis.parents[i] == analysis.parents[j],
            CONTACT_ERROR
        );
        sets.join(i, j);
    }
    let mut groups = BTreeMap::<usize, Vec<usize>>::new();
    for i in 0..rings.len() {
        groups.entry(sets.root(i)).or_default().push(i);
    }
    let mut result = Vec::new();
    let mut result_roles = Vec::new();
    let mut total = 0usize;
    for group in groups.values() {
        let values = if group.len() == 1 {
            vec![(rings[group[0]].clone(), roles[group[0]])]
        } else {
            union_group(&rings, group, budget, check)?
        };
        for (ring, role) in values {
            total = total.checked_add(ring.len()).context(WORK_ERROR)?;
            ensure!(
                total <= MAX_POINTS && result.len() < MAX_RINGS,
                "面全体の点数・輪郭数上限を超えました"
            );
            result.push(ring);
            result_roles.push(role);
        }
    }
    Ok((result, result_roles))
}

pub(super) fn assemble(
    mut rings: Vec<Vec<Point>>,
    mut roles: Vec<Option<RingRole>>,
    allow_shared: bool,
    budget: &mut usize,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Vec<PolygonPart>> {
    total_points(&rings)?;
    ensure!(rings.len() == roles.len(), "輪郭とroleの件数が一致しません");
    let mut analysis = analyze(&mut rings, &roles, budget, check)?;
    if analysis.contacts.values().any(|p| p.shared) {
        ensure!(allow_shared, CONTACT_ERROR);
        (rings, roles) = merge_holes(rings, roles, &analysis, budget, check)?;
        analysis = analyze(&mut rings, &roles, budget, check)?;
    }
    connected_interiors(&analysis, budget, check)?;
    let mut parts = Vec::new();
    for i in 0..rings.len() {
        check()?;
        if analysis.depths[i] % 2 != 0 {
            continue;
        }
        let mut holes = Vec::new();
        for j in 0..rings.len() {
            if analysis.parents[j] == Some(i) {
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

pub(super) fn locks(parts: &[PolygonPart], context: &OperationContext) -> Result<Vec<Vec<bool>>> {
    let rings: Vec<_> = parts
        .iter()
        .flat_map(|p| std::iter::once(&p.outer).chain(p.holes.iter()))
        .collect();
    ensure!(
        !rings.is_empty() && rings.len() <= MAX_RINGS,
        "面の輪郭数が上限外です"
    );
    let total = rings
        .iter()
        .try_fold(0usize, |n, r| n.checked_add(r.len()).context(WORK_ERROR))?;
    ensure!(total <= MAX_POINTS, "面全体の点数上限を超えました");
    let mut masks: Vec<_> = rings.iter().map(|r| vec![false; r.len()]).collect();
    let mut seen = BTreeMap::<PointKey, (usize, usize)>::new();
    let mut budget = MAX_INTERSECTIONS;
    for (ring, points) in rings.iter().enumerate() {
        ensure!(
            points.len() >= 4 && points.first() == points.last(),
            "面の輪郭が閉じていません"
        );
        for (vertex, &p) in points[..points.len() - 1].iter().enumerate() {
            consume_budget(&mut budget, WORK_ERROR, &mut || context.check())?;
            ensure!(
                p.x.is_finite()
                    && p.y.is_finite()
                    && (0.0..=1.0).contains(&p.x)
                    && (0.0..=1.0).contains(&p.y),
                "面座標が不正です"
            );
            if rings.len() == 1 {
                continue;
            }
            if let Some(&(other, index)) = seen.get(&PointKey::new(p)) {
                if other != ring {
                    masks[other][index] = true;
                    masks[ring][vertex] = true;
                }
            } else {
                seen.insert(PointKey::new(p), (ring, vertex));
            }
        }
    }
    for mask in &mut masks {
        let last = mask.len() - 1;
        mask[last] = mask[0];
    }
    context.check()?;
    Ok(masks)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(points: &[(u8, u8)]) -> Vec<Point> {
        points
            .iter()
            .map(|&(x, y)| Point {
                x: f64::from(x) / 16.0,
                y: f64::from(y) / 16.0,
            })
            .collect()
    }
    fn rectangle(x1: u8, y1: u8, x2: u8, y2: u8) -> Vec<Point> {
        ring(&[(x1, y1), (x2, y1), (x2, y2), (x1, y2), (x1, y1)])
    }
    fn source(rings: Vec<Vec<Point>>, roles: Vec<Option<RingRole>>) -> Result<Vec<PolygonPart>> {
        let rings = rings
            .into_iter()
            .map(|r| normalize_ring(r, &mut || Ok(())))
            .collect::<Result<Vec<_>>>()?;
        let mut budget = MAX_INTERSECTIONS;
        assemble(rings, roles, true, &mut budget, &mut || Ok(()))
    }
    fn outer() -> Vec<Point> {
        rectangle(1, 1, 9, 9)
    }
    fn filled(parts: &[PolygonPart], x: u8, y: u8) -> bool {
        let p = Point {
            x: f64::from(x) / 16.0,
            y: f64::from(y) / 16.0,
        };
        parts.iter().any(|part| {
            contains(&part.outer, p) && !part.holes.iter().any(|hole| contains(hole, p))
        })
    }

    #[test]
    fn point_touching_hole_nodes_existing_edge_and_keeps_courtyard() -> Result<()> {
        let hole = ring(&[(1, 5), (3, 3), (5, 5), (3, 7), (1, 5)]);
        let parts = source(
            vec![outer(), hole.clone()],
            vec![Some(RingRole::Outer), Some(RingRole::Inner)],
        )?;
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].outer.len(), 6);
        assert_eq!(parts[0].holes.len(), 1);
        assert!(!filled(&parts, 3, 5));
        assert!(filled(&parts, 7, 5));
        let contact = hole[0];
        assert!(parts[0].outer.contains(&contact));
        let locks = locks(&parts, &OperationContext::default())?;
        assert_eq!(locks[0].iter().filter(|&&locked| locked).count(), 1);
        assert_eq!(locks[1].iter().filter(|&&locked| locked).count(), 2);
        // 元の非接触原形のLODに使う検査の意味は緩和しない。
        assert!(
            polygon_from_rings(
                vec![parts[0].outer.clone(), hole],
                &OperationContext::default()
            )
            .is_err()
        );
        Ok(())
    }

    #[test]
    fn separate_outer_interiors_may_touch_at_two_points() -> Result<()> {
        let u = ring(&[
            (1, 1),
            (9, 1),
            (9, 9),
            (7, 9),
            (7, 3),
            (3, 3),
            (3, 9),
            (1, 9),
            (1, 1),
        ]);
        let diamond = ring(&[(3, 5), (5, 4), (7, 5), (5, 6), (3, 5)]);
        let parts = source(vec![u, diamond], vec![Some(RingRole::Outer); 2])?;
        assert_eq!(parts.len(), 2);
        assert!(parts.iter().all(|part| part.holes.is_empty()));
        assert!(filled(&parts, 5, 5));
        assert!(!filled(&parts, 5, 7));
        Ok(())
    }

    #[test]
    fn shared_holes_merge_after_partial_edge_noding_without_moving_points() -> Result<()> {
        let left = rectangle(2, 2, 4, 7);
        let right = rectangle(4, 3, 7, 6);
        let original: BTreeSet<_> = [outer(), left.clone(), right.clone()]
            .iter()
            .flatten()
            .copied()
            .map(PointKey::new)
            .collect();
        let parts = source(
            vec![outer(), left.clone(), right.clone()],
            vec![
                Some(RingRole::Outer),
                Some(RingRole::Inner),
                Some(RingRole::Inner),
            ],
        )?;
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].holes.len(), 1);
        assert!(!filled(&parts, 3, 5));
        assert!(!filled(&parts, 6, 5));
        assert!(filled(&parts, 6, 7));
        for &p in parts
            .iter()
            .flat_map(|p| std::iter::once(&p.outer).chain(p.holes.iter()))
            .flatten()
        {
            assert!(original.contains(&PointKey::new(p)));
        }
        let mut reversed_left = left;
        reversed_left.reverse();
        let mut reversed_right = right;
        reversed_right.reverse();
        let reordered = source(
            vec![outer(), reversed_right, reversed_left],
            vec![
                Some(RingRole::Outer),
                Some(RingRole::Inner),
                Some(RingRole::Inner),
            ],
        )?;
        assert_eq!(
            serde_json::to_value(parts)?,
            serde_json::to_value(reordered)?
        );
        Ok(())
    }

    #[test]
    fn shared_holes_preserve_island_enclosed_by_their_union() -> Result<()> {
        let parts = source(
            vec![
                outer(),
                rectangle(2, 2, 7, 3),
                rectangle(2, 6, 7, 7),
                rectangle(2, 3, 3, 6),
                rectangle(6, 3, 7, 6),
            ],
            vec![
                Some(RingRole::Outer),
                Some(RingRole::Inner),
                Some(RingRole::Inner),
                Some(RingRole::Inner),
                Some(RingRole::Inner),
            ],
        )?;
        assert_eq!(parts.len(), 2);
        assert_eq!(parts.iter().map(|part| part.holes.len()).sum::<usize>(), 1);
        assert!(!filled(&parts, 4, 2));
        assert!(filled(&parts, 4, 4));
        assert!(filled(&parts, 8, 4));
        Ok(())
    }

    #[test]
    fn diagonal_shared_edge_uses_exact_endpoints_despite_rounded_midpoint() -> Result<()> {
        let a = Point {
            x: 0.8001,
            y: 0.4001,
        };
        let b = Point {
            x: 0.80011,
            y: 0.40011,
        };
        let left = Point {
            x: 0.80008,
            y: 0.40012,
        };
        let right = Point {
            x: 0.80013,
            y: 0.40008,
        };
        let midpoint = Point {
            x: a.x + (b.x - a.x) * 0.5,
            y: a.y + (b.y - a.y) * 0.5,
        };
        assert_ne!(
            cross(a, b, midpoint),
            0.0,
            "この入力では中点の丸めによる非共線性を再現する"
        );
        let outside = vec![
            Point {
                x: 0.80005,
                y: 0.40005,
            },
            Point {
                x: 0.80015,
                y: 0.40005,
            },
            Point {
                x: 0.80015,
                y: 0.40015,
            },
            Point {
                x: 0.80005,
                y: 0.40015,
            },
            Point {
                x: 0.80005,
                y: 0.40005,
            },
        ];
        let parts = source(
            vec![outside, vec![a, b, left, a], vec![b, a, right, b]],
            vec![
                Some(RingRole::Outer),
                Some(RingRole::Inner),
                Some(RingRole::Inner),
            ],
        )?;
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].holes.len(), 1);
        let mut expected = normalize_ring(vec![a, right, b, left, a], &mut || Ok(()))?;
        expected.reverse();
        assert_eq!(parts[0].holes[0], expected);
        Ok(())
    }

    #[test]
    fn rejects_contact_crossing_and_contacts_that_disconnect_an_interior() {
        let crossing = ring(&[(2, 2), (5, 3), (2, 5), (1, 3), (2, 2)]);
        assert!(source(vec![rectangle(2, 2, 8, 8), crossing], vec![None; 2]).is_err());
        let divider = ring(&[(5, 1), (7, 5), (5, 9), (3, 5), (5, 1)]);
        let error = source(vec![outer(), divider], vec![None; 2]).unwrap_err();
        assert!(error.to_string().contains("内部を分断"));
        // 穴2つが1点で接するだけでは内部は分断されない。
        let a = ring(&[(1, 5), (3, 3), (5, 5), (3, 7), (1, 5)]);
        let b = ring(&[(5, 5), (7, 3), (9, 5), (7, 7), (5, 5)]);
        let error = source(vec![outer(), a, b], vec![None; 3]).unwrap_err();
        assert!(error.to_string().contains("内部を分断"));
    }

    #[test]
    fn rejects_shared_outer_boundaries_overlapping_holes_and_wrong_roles() {
        assert!(
            source(
                vec![rectangle(1, 1, 4, 7), rectangle(4, 1, 7, 7)],
                vec![Some(RingRole::Outer); 2]
            )
            .is_err()
        );
        assert!(
            source(
                vec![outer(), rectangle(2, 2, 5, 6), rectangle(3, 2, 6, 6)],
                vec![None; 3]
            )
            .is_err()
        );
        assert!(
            source(
                vec![outer(), rectangle(2, 2, 5, 6), rectangle(2, 2, 5, 6)],
                vec![None; 3]
            )
            .is_err()
        );
        let touching = ring(&[(1, 5), (3, 3), (5, 5), (3, 7), (1, 5)]);
        assert!(source(vec![outer(), touching], vec![Some(RingRole::Outer); 2]).is_err());
        let self_touch = ring(&[
            (2, 2),
            (4, 2),
            (4, 4),
            (6, 4),
            (6, 6),
            (4, 6),
            (4, 4),
            (2, 4),
            (2, 2),
        ]);
        assert!(source(vec![outer(), self_touch], vec![None; 2]).is_err());
    }

    #[test]
    fn cancellation_and_work_limit_apply_to_noding_and_boundary_reconstruction() -> Result<()> {
        let rings = [rectangle(2, 2, 4, 7), rectangle(4, 3, 7, 6)]
            .into_iter()
            .map(|r| normalize_ring(r, &mut || Ok(())))
            .collect::<Result<Vec<_>>>()?;
        let indices = rings
            .iter()
            .map(|r| EdgeIndex::new(r, &mut || Ok(())))
            .collect::<Result<Vec<_>>>()?;
        assert!(scan(&indices, 10, &mut 0, &mut || Ok(())).is_err());
        let mut scans = 0;
        let mut budget = MAX_INTERSECTIONS;
        assert!(
            scan(&indices, 10, &mut budget, &mut || {
                scans += 1;
                bail!("cancel contact")
            })
            .unwrap_err()
            .to_string()
            .contains("cancel contact")
        );
        assert_eq!(scans, 1);
        let mut budget = MAX_INTERSECTIONS;
        let (_, splits) = scan(&indices, 10, &mut budget, &mut || Ok(()))?;
        let mut noded = rings.clone();
        assert!(insert_splits(&mut noded, splits, &mut 0, &mut || Ok(())).is_err());
        assert!(union_group(&rings, &[0, 1], &mut 0, &mut || Ok(())).is_err());
        assert!(
            union_group(&rings, &[0, 1], &mut 2049, &mut || bail!("cancel union"))
                .unwrap_err()
                .to_string()
                .contains("cancel union")
        );
        Ok(())
    }

    #[test]
    fn contact_validation_rejects_invalid_numbers_and_resource_limits() {
        let context = OperationContext::default();
        let mut invalid = outer();
        invalid[1].x = f64::NAN;
        assert!(polygon_from_rings_with_contacts(vec![invalid], &context).is_err());
        assert!(polygon_from_rings_with_contacts(vec![outer(); MAX_RINGS + 1], &context).is_err());
        let over = vec![Point { x: 0.25, y: 0.25 }; MAX_POINTS + 1];
        assert!(polygon_from_rings_with_contacts(vec![over], &context).is_err());
        let mut closed = outer();
        closed[1].x = f64::INFINITY;
        assert!(
            locks(
                &[PolygonPart {
                    outer: closed,
                    holes: vec![]
                }],
                &context
            )
            .is_err()
        );
    }
}
