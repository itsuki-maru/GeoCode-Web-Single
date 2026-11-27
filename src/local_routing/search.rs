use super::{
    Coord, RouteResult, SNAP_RADIUS_M, SearchError, TravelMode, open, restrictions::TurnRules,
};
use anyhow::{Context, Result};
use rusqlite::{Connection, Row, params};
use std::{
    cmp::Ordering,
    collections::{BinaryHeap, HashMap, VecDeque},
    path::Path,
};

#[derive(Clone, Copy)]
struct Edge {
    id: i64,
    way: i64,
    a: i64,
    b: i64,
    start: Coord,
    end: Coord,
    meters: f64,
    speeds: [f64; 2],
    shape: [bool; 2],
    passable: [bool; 2],
}

const EDGE_COLUMNS: &str = "e.id,e.a,e.b,a.lat,a.lon,b.lat,b.lon,e.meters,e.car_f,e.car_b,e.foot_f,e.foot_b,a.shape,b.shape,a.car,b.car,a.foot,b.foot,e.way";
const NODE_JOINS: &str = "JOIN nodes a ON a.id=e.a JOIN nodes b ON b.id=e.b";

impl Edge {
    fn read(row: &Row, mode: TravelMode) -> rusqlite::Result<Self> {
        let offset = if mode == TravelMode::Car { 8 } else { 10 };
        let node_offset = if mode == TravelMode::Car { 14 } else { 16 };
        Ok(Self {
            id: row.get(0)?,
            way: row.get(18)?,
            a: row.get(1)?,
            b: row.get(2)?,
            start: Coord {
                lat: row.get(3)?,
                lon: row.get(4)?,
            },
            end: Coord {
                lat: row.get(5)?,
                lon: row.get(6)?,
            },
            meters: row.get(7)?,
            speeds: [row.get(offset)?, row.get(offset + 1)?],
            shape: [
                mode == TravelMode::Car && row.get(12)?,
                mode == TravelMode::Car && row.get(13)?,
            ],
            passable: [row.get(node_offset)?, row.get(node_offset + 1)?],
        })
    }
    fn cost(self, fraction: f64, direction: usize) -> Option<(f64, f64)> {
        let speed = self.speeds[direction];
        if speed <= 0. {
            return None;
        }
        let meters = self.meters * fraction;
        Some((meters * 3.6 / speed, meters))
    }

    fn directed(self, direction: usize) -> i64 {
        if direction == 0 { self.id } else { -self.id }
    }

    fn entry(self, direction: usize) -> Entry {
        Entry::arrival(
            self.id,
            self.passable[1 - direction],
            self.shape[1 - direction],
        )
    }
}

#[derive(Clone, Copy)]
struct Snap {
    edge: Edge,
    t: f64,
    point: Coord,
}

fn wrap_lon(d: f64) -> f64 {
    if d > 180. {
        d - 360.
    } else if d < -180. {
        d + 360.
    } else {
        d
    }
}

fn project(point: Coord, edge: Edge) -> Snap {
    let scale = point.lat.to_radians().cos();
    let dx = wrap_lon(edge.end.lon - edge.start.lon) * scale;
    let dy = edge.end.lat - edge.start.lat;
    let px = wrap_lon(point.lon - edge.start.lon) * scale;
    let py = point.lat - edge.start.lat;
    let denominator = dx * dx + dy * dy;
    let t = if denominator > 0. {
        ((px * dx + py * dy) / denominator).clamp(0., 1.)
    } else {
        0.
    };
    let point = if t == 0. {
        edge.start
    } else if t == 1. {
        edge.end
    } else {
        Coord {
            lat: edge.start.lat + t * dy,
            lon: wrap_lon(edge.start.lon + t * wrap_lon(edge.end.lon - edge.start.lon)),
        }
    };
    Snap { edge, t, point }
}

fn snap(
    db: &Connection,
    point: Coord,
    mode: TravelMode,
    radius_m: f64,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Snap> {
    let dlat = radius_m / 110_000.;
    let dlon = dlat
        / (point.lat.abs() + dlat)
            .min(90.)
            .to_radians()
            .cos()
            .max(1e-10);
    let (west, east) = if point.lon - dlon < -180. || point.lon + dlon > 180. {
        (-180., 180.)
    } else {
        (point.lon - dlon, point.lon + dlon)
    };
    let sql = format!(
        "SELECT {EDGE_COLUMNS} FROM edge_rtree r JOIN edges e ON e.id=r.id {NODE_JOINS}
        WHERE r.west<=? AND r.east>=? AND r.south<=? AND r.north>=?"
    );
    let mut stmt = db.prepare_cached(&sql)?;
    let mut rows = stmt.query(params![east, west, point.lat + dlat, point.lat - dlat])?;
    let mut best: Option<(f64, Snap)> = None;
    let mut candidates = 0_u32;
    while let Some(row) = rows.next()? {
        if candidates.is_multiple_of(256) {
            check()?;
        }
        candidates += 1;
        let edge = Edge::read(row, mode)?;
        if edge.speeds == [0.; 2] {
            continue;
        }
        let s = project(point, edge);
        let d = point.distance(s.point);
        if d <= radius_m
            && best.is_none_or(|(old, prev)| d < old || (d == old && s.edge.id < prev.edge.id))
        {
            best = Some((d, s));
        }
    }
    best.map(|(_, s)| s)
        .ok_or_else(|| SearchError::NoSnap.into())
}

// 曲がれる方向はノードへの進入経路に依存する。出発地が頂点に一致するときは進入辺がない。
#[derive(Clone, Copy, Eq, PartialEq, Hash, PartialOrd, Ord)]
struct State {
    node: i64,
    history: usize,
    entry: Entry,
}

impl State {
    fn continues_along_way(self, destination_nodes: [i64; 2]) -> bool {
        matches!(self.entry, Entry::ThroughOnly(_)) && !destination_nodes.contains(&self.node)
    }
}

#[derive(Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
enum Entry {
    Free,
    ThroughOnly(i64),
    ReturnOnly(i64),
}

impl Entry {
    fn arrival(id: i64, passable: bool, shape: bool) -> Self {
        if !passable {
            Self::ReturnOnly(id)
        } else if shape {
            Self::ThroughOnly(id)
        } else {
            Self::Free
        }
    }

    fn allows(self, edge: i64) -> bool {
        match self {
            Self::Free => true,
            Self::ThroughOnly(previous) => edge != previous,
            Self::ReturnOnly(previous) => edge == previous,
        }
    }
}

#[derive(Clone, Copy)]
struct Label {
    point: Coord,
    way: i64,
    first_edge: i64,
    last_edge: i64,
    seconds: f64,
    meters: f64,
    parent: Option<State>,
}

struct QueueItem {
    estimate: f64,
    state: State,
}
impl PartialEq for QueueItem {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for QueueItem {}
impl PartialOrd for QueueItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for QueueItem {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .estimate
            .total_cmp(&self.estimate)
            .then_with(|| other.state.cmp(&self.state))
    }
}

struct Frontier {
    labels: HashMap<State, Label>,
    queue: BinaryHeap<QueueItem>,
    target: Coord,
    projection_error_m: f64,
    speed_upper_bound: f64,
}

// 辺は道路上の順番に登録されるため、同じ道路では辺IDもその順に増える。
// (way, seq) の索引を使うと、追加の並べ替えをせずにその順で読める。
struct WaySegments<'db> {
    query: rusqlite::Statement<'db>,
    ways: HashMap<i64, Vec<Edge>>,
    order: VecDeque<i64>,
    edge_count: usize,
}

impl<'db> WaySegments<'db> {
    fn new(db: &'db Connection) -> Result<Self> {
        Ok(Self {
            query: db.prepare(&format!(
                "SELECT {EDGE_COLUMNS} FROM edges e {NODE_JOINS} WHERE e.way=? ORDER BY e.seq"
            ))?,
            ways: HashMap::new(),
            order: VecDeque::new(),
            edge_count: 0,
        })
    }

    fn segments(&mut self, way: i64, check: &mut impl FnMut() -> Result<()>) -> Result<&[Edge]> {
        if !self.ways.contains_key(&way) {
            let mut segments = Vec::new();
            let mut rows = self.query.query([way])?;
            while let Some(row) = rows.next()? {
                if segments.len().is_multiple_of(256) {
                    check()?;
                }
                segments.push(Edge::read(row, TravelMode::Car)?);
            }
            while self.edge_count + segments.len() > 65_536 {
                let Some(oldest) = self.order.pop_front() else {
                    break;
                };
                self.edge_count -= self.ways.remove(&oldest).unwrap().len();
            }
            self.edge_count += segments.len();
            self.order.push_back(way);
            self.ways.insert(way, segments);
        }
        Ok(&self.ways[&way])
    }

    fn append_geometry_backwards(
        &mut self,
        label: Label,
        geometry: &mut Vec<Coord>,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<()> {
        geometry.push(label.point);
        if label.first_edge == label.last_edge {
            return Ok(());
        }
        let segments = self.segments(label.way, check)?;
        let index = |directed: i64| {
            segments
                .binary_search_by_key(&directed.abs(), |e| e.id)
                .ok()
                .context("経路形状の辺が見つかりません")
        };
        let first = index(label.first_edge)?;
        let last = index(label.last_edge)?;
        if first < last {
            geometry.extend(segments[first..last].iter().rev().map(|e| e.end));
        } else {
            geometry.extend(segments[last + 1..=first].iter().map(|e| e.start));
        }
        Ok(())
    }
}

struct Step {
    directed: i64,
    node: i64,
    entry: Entry,
    point: Coord,
    meters: f64,
    seconds: f64,
    way: i64,
}

impl Step {
    fn read(row: &Row) -> rusqlite::Result<Self> {
        let id: i64 = row.get(0)?;
        let reverse: bool = row.get(8)?;
        let meters: f64 = row.get(4)?;
        let speed: f64 = row.get(5)?;
        Ok(Self {
            directed: if reverse { -id } else { id },
            node: row.get(1)?,
            entry: Entry::arrival(id, row.get(6)?, row.get(7)?),
            point: Coord {
                lat: row.get(2)?,
                lon: row.get(3)?,
            },
            seconds: meters * 3.6 / speed,
            meters,
            way: row.get(9)?,
        })
    }
}

impl Frontier {
    fn estimate(&self, label: Label) -> f64 {
        let lower_bound_m = (label.point.distance(self.target) - self.projection_error_m).max(0.);
        label.seconds + lower_bound_m * 3.6 / self.speed_upper_bound
    }
    fn insert(&mut self, state: State, label: Label) {
        if self
            .labels
            .get(&state)
            .is_some_and(|old| old.seconds <= label.seconds)
        {
            return;
        }
        self.labels.insert(state, label);
        self.queue.push(QueueItem {
            state,
            estimate: self.estimate(label),
        });
    }
}

struct Traversal<'rules, 'db> {
    rules: &'rules TurnRules,
    destination_nodes: [i64; 2],
    ways: WaySegments<'db>,
    compress: bool,
}

impl Traversal<'_, '_> {
    fn follow(
        &mut self,
        state: State,
        label: Label,
        step: Step,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<Option<(State, Label)>> {
        if !state.entry.allows(step.directed.abs()) {
            return Ok(None);
        }
        let Some(history) = self.rules.advance(state.history, step.directed) else {
            return Ok(None);
        };
        let mut next = State {
            node: step.node,
            history,
            entry: step.entry,
        };
        let mut route = Label {
            point: step.point,
            way: step.way,
            seconds: label.seconds + step.seconds,
            meters: label.meters + step.meters,
            parent: Some(state),
            first_edge: step.directed,
            last_edge: step.directed,
        };
        if self.compress && next.continues_along_way(self.destination_nodes) {
            self.advance_shape_chain(&mut next, &mut route, check)?;
        }
        Ok(Some((next, route)))
    }

    // 車が分岐のない道路の途中にいるとき、進める方向は一つだけ。各区間で通行規制の履歴を更新し、
    // 次の分岐点だけを探索キューに入れる。目的地を割り当てた区間の端点に着いたら、そこで通常の探索に戻る。
    fn advance_shape_chain(
        &mut self,
        state: &mut State,
        label: &mut Label,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<()> {
        let segments = self.ways.segments(label.way, check)?;
        let mut index = segments
            .binary_search_by_key(&label.first_edge.abs(), |e| e.id)
            .ok()
            .context("経路形状の辺が見つかりません")?;
        let direction = usize::from(label.first_edge < 0);
        let offset = if direction == 0 { 1 } else { -1 };
        while let Some(next) = index
            .checked_add_signed(offset)
            .filter(|&i| i < segments.len())
        {
            let edge = segments[next];
            let (from, to, point) = if direction == 0 {
                (edge.a, edge.b, edge.end)
            } else {
                (edge.b, edge.a, edge.start)
            };
            if from != state.node {
                break;
            }
            let Some((seconds, meters)) = edge.cost(1., direction) else {
                break;
            };
            let directed = edge.directed(direction);
            let Some(history) = self.rules.advance(state.history, directed) else {
                break;
            };
            if next.is_multiple_of(256) {
                check()?;
            }
            *state = State {
                node: to,
                history,
                entry: edge.entry(direction),
            };
            label.point = point;
            label.seconds += seconds;
            label.meters += meters;
            label.last_edge = directed;
            if !state.continues_along_way(self.destination_nodes) {
                break;
            }
            index = next;
        }
        Ok(())
    }
}

pub fn search(path: &Path, mode: TravelMode, start: Coord, end: Coord) -> Result<RouteResult> {
    search_with_check(path, mode, start, end, || Ok(()))
}

pub fn search_with_check(
    path: &Path,
    mode: TravelMode,
    start: Coord,
    end: Coord,
    check: impl FnMut() -> Result<()>,
) -> Result<RouteResult> {
    search_with_radii(path, mode, start, end, [SNAP_RADIUS_M; 2], check)
}

/// 出発地と目的地それぞれに、道路を探す最大距離をメートル単位で指定して検索する。
pub fn search_with_radii(
    path: &Path,
    mode: TravelMode,
    start: Coord,
    end: Coord,
    radii_m: [f64; 2],
    mut check: impl FnMut() -> Result<()>,
) -> Result<RouteResult> {
    let speed_bound = match mode {
        TravelMode::Car => 90.,
        TravelMode::Foot => 4.5,
    };
    solve(path, mode, start, end, radii_m, speed_bound, &mut check)
}

// 速度の上限を無限大にするとA*の残り時間の下限が0になり、比較用のダイクストラ法と同じ探索になる。
pub(super) fn solve(
    path: &Path,
    mode: TravelMode,
    start: Coord,
    end: Coord,
    radii_m: [f64; 2],
    speed_bound: f64,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<RouteResult> {
    start.validate()?;
    end.validate()?;
    anyhow::ensure!(
        radii_m.iter().all(|r| r.is_finite() && *r >= 0.),
        "道路検索の半径には0以上の有限値を指定してください"
    );
    check()?;
    let db = open(path)?;
    db.pragma_update(None, "cache_size", -49_152_i64)?;
    db.pragma_update(None, "mmap_size", 2_i64 * 1024 * 1024 * 1024)?;
    // 検索全体で一つのスナップショットを使い、隣接辺を読むたびにファイルロックを取り直すのを避ける。
    db.execute_batch("BEGIN DEFERRED")?;
    check()?;
    let start = snap(&db, start, mode, radii_m[0], check)?;
    let end = snap(&db, end, mode, radii_m[1], check)?;
    let rules = TurnRules::read(&db, mode, check)?;
    // 道路上の対応点は経緯度を線形補間して求めるが、部分区間の重みには測地線長の割合を使う。
    // 長い区間や高緯度でも残り時間を過大評価しないよう、この差を見込む。
    let projection_error_m = (end.edge.start.distance(end.point) - end.t * end.edge.meters)
        .max(end.edge.end.distance(end.point) - (1. - end.t) * end.edge.meters)
        .max(0.);
    let mut frontier = Frontier {
        labels: HashMap::new(),
        queue: BinaryHeap::new(),
        target: end.point,
        projection_error_m,
        speed_upper_bound: speed_bound,
    };
    let mut best: Option<(f64, f64, Option<State>)> = None;
    if start.edge.id == end.edge.id {
        let dt = end.t - start.t;
        if dt == 0. {
            best = Some((0., 0., None));
        } else if let Some((sec, m)) = start.edge.cost(dt.abs(), usize::from(dt < 0.)) {
            best = Some((sec, m, None));
        }
    }
    let edge = start.edge;
    for (node, point, fraction, dir) in [
        (edge.a, edge.start, start.t, 1),
        (edge.b, edge.end, 1. - start.t, 0),
    ] {
        if fraction == 0. {
            frontier.insert(
                State {
                    node,
                    history: 0,
                    entry: Entry::Free,
                },
                Label {
                    point,
                    way: edge.way,
                    first_edge: 0,
                    last_edge: 0,
                    seconds: 0.,
                    meters: 0.,
                    parent: None,
                },
            );
        } else if let Some((seconds, meters)) = edge.cost(fraction, dir) {
            frontier.insert(
                State {
                    node,
                    history: rules
                        .advance(0, edge.directed(dir))
                        .expect("a single edge cannot complete a turn"),
                    entry: edge.entry(dir),
                },
                Label {
                    point,
                    way: edge.way,
                    first_edge: 0,
                    last_edge: 0,
                    seconds,
                    meters,
                    parent: None,
                },
            );
        }
    }
    let (forward, backward, passable, shape) = match mode {
        TravelMode::Car => ("car_f", "car_b", "car", "n.shape"),
        TravelMode::Foot => ("foot_f", "foot_b", "foot", "0"),
    };
    // UNION ALLの各SELECTは端点の索引を使い、進行先のノードだけを読む。
    let mut adjacency = db.prepare(&format!(
        "SELECT e.id,e.b,n.lat,n.lon,e.meters,e.{forward},n.{passable},{shape},0,e.way
         FROM edges e JOIN nodes n ON n.id=e.b WHERE e.a=?1 AND e.{forward}>0
         UNION ALL
         SELECT e.id,e.a,n.lat,n.lon,e.meters,e.{backward},n.{passable},{shape},1,e.way
         FROM edges e JOIN nodes n ON n.id=e.a WHERE e.b=?1 AND e.{backward}>0
         ORDER BY 1"
    ))?;
    let mut traversal = Traversal {
        rules: &rules,
        ways: WaySegments::new(&db)?,
        destination_nodes: [end.edge.a, end.edge.b],
        compress: mode == TravelMode::Car && speed_bound.is_finite(),
    };
    let mut pops = 0_u64;
    while let Some(item) = frontier.queue.pop() {
        pops += 1;
        if pops.is_multiple_of(256) {
            check()?;
            anyhow::ensure!(
                frontier.labels.len() < 4_000_000,
                "経路探索の状態数が上限を超えました。より短い区間を指定してください"
            );
        }
        if best.is_some_and(|(s, _, _)| item.estimate >= s) {
            break;
        }
        let state = item.state;
        let label = frontier.labels[&state];
        if item.estimate > frontier.estimate(label) {
            continue;
        }
        let edge = end.edge;
        for (node, fraction, dir) in [(edge.a, end.t, 0), (edge.b, 1. - end.t, 1)] {
            if node != state.node {
                continue;
            }
            let extra = if fraction == 0. {
                Some((0., 0.))
            } else if state.entry.allows(edge.id)
                && rules.advance(state.history, edge.directed(dir)).is_some()
            {
                edge.cost(fraction, dir)
            } else {
                None
            };
            if let Some((s, m)) = extra {
                let sec = label.seconds + s;
                if best.is_none_or(|(old, _, _)| sec < old) {
                    best = Some((sec, label.meters + m, Some(state)));
                }
            }
        }
        let mut rows = adjacency.query([state.node])?;
        while let Some(row) = rows.next()? {
            if let Some((next, route)) = traversal.follow(state, label, Step::read(row)?, check)? {
                frontier.insert(next, route);
            }
        }
    }
    let (duration_s, distance_m, mut cursor) = best.ok_or(SearchError::NoRoute)?;
    let mut geometry = vec![end.point];
    while let Some(state) = cursor {
        check()?;
        let label = frontier.labels[&state];
        traversal
            .ways
            .append_geometry_backwards(label, &mut geometry, check)?;
        cursor = label.parent;
    }
    geometry.push(start.point);
    geometry.reverse();
    geometry.dedup();
    if geometry.len() == 1 {
        geometry.push(end.point);
    }
    Ok(RouteResult {
        geometry,
        distance_m,
        duration_s,
        snapped_start: start.point,
        snapped_end: end.point,
    })
}
