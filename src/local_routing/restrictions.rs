//! OSM の from/via/to を有向辺列に解決する。via-way の途中では進入履歴を保つ。
use super::TravelMode;
use crate::tilegen::pbf::{MemberKind, Relation};
use anyhow::{Result, ensure};
use rusqlite::{Connection, params};
use std::collections::{HashMap, HashSet, VecDeque};

pub(super) fn stage(db: &Connection, rel: &Relation) -> Result<()> {
    if rel
        .tags
        .get("type")
        .is_some_and(|v| v == "restriction" || v.starts_with("restriction:"))
    {
        db.prepare_cached("INSERT INTO relations VALUES(?,?)")?
            .execute(params![rel.id, serde_json::to_string(rel)?])?;
    }
    Ok(())
}

fn restriction(rel: &Relation, mode: TravelMode, conditional: bool) -> Option<&str> {
    let keys: &[&str] = match mode {
        TravelMode::Car => &[
            "restriction:motorcar",
            "restriction:motor_vehicle",
            "restriction:vehicle",
            "restriction",
        ],
        TravelMode::Foot => &["restriction:foot"],
    };
    for key in keys {
        let v = if conditional {
            rel.tags.get(&format!("{key}:conditional"))
        } else {
            rel.tags.get(*key)
        };
        if let Some(v) = v {
            return Some(v);
        }
    }
    if mode == TravelMode::Foot
        && rel
            .tags
            .get("type")
            .is_some_and(|v| v == "restriction:foot")
    {
        return rel
            .tags
            .get(if conditional {
                "restriction:conditional"
            } else {
                "restriction"
            })
            .map(String::as_str);
    }
    None
}

fn applies(rel: &Relation, mode: TravelMode) -> bool {
    let applies_to = |v: &str| match mode {
        TravelMode::Car => matches!(v, "motorcar" | "motor_vehicle" | "vehicle"),
        TravelMode::Foot => v == "foot",
    };
    let kind = rel.tags.get("type").map(String::as_str).unwrap_or("");
    (kind == "restriction" || kind.strip_prefix("restriction:").is_some_and(applies_to))
        && !rel
            .tags
            .get("except")
            .is_some_and(|v| v.split(';').any(|s| applies_to(s.trim())))
}

#[derive(Clone, Copy)]
struct Link {
    id: i64,
    a: i64,
    b: i64,
}

struct Way {
    nodes: HashSet<i64>,
    edges: Vec<Link>,
}
impl Way {
    fn read(db: &Connection, id: i64) -> Result<Self> {
        let mut stmt = db.prepare_cached("SELECT id,a,b FROM edges WHERE way=? ORDER BY seq")?;
        let edges = stmt
            .query_map([id], |r| {
                Ok(Link {
                    id: r.get(0)?,
                    a: r.get(1)?,
                    b: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Self {
            nodes: edges.iter().flat_map(|e| [e.a, e.b]).collect(),
            edges,
        })
    }
    fn intersection(&self, other: &Self) -> Option<i64> {
        let mut shared = self.nodes.intersection(&other.nodes);
        let node = *shared.next()?;
        shared.next().is_none().then_some(node)
    }
    fn between(&self, a: i64, b: i64) -> Option<Vec<i64>> {
        if a == b {
            return None;
        }
        let mut nodes = Vec::new();
        nodes.push(self.edges.first()?.a);
        nodes.extend(self.edges.iter().map(|e| e.b));
        let index = |needle| {
            let mut found = nodes.iter().enumerate().filter(|(_, n)| **n == needle);
            let i = found.next()?.0;
            found.next().is_none().then_some(i)
        };
        let i = index(a)?;
        let j = index(b)?;
        if i < j {
            Some(self.edges[i..j].iter().map(|e| e.id).collect())
        } else {
            Some(self.edges[j..i].iter().rev().map(|e| -e.id).collect())
        }
    }
    fn arriving(&self, node: i64) -> Vec<i64> {
        self.edges
            .iter()
            .filter_map(|e| {
                if e.b == node {
                    Some(e.id)
                } else if e.a == node {
                    Some(-e.id)
                } else {
                    None
                }
            })
            .collect()
    }
}

struct Members {
    from: Vec<i64>,
    via_nodes: Vec<i64>,
    via_ways: Vec<i64>,
    to: Vec<i64>,
    malformed: bool,
}
impl Members {
    fn new(rel: &Relation) -> Self {
        let mut m = Self {
            from: vec![],
            via_nodes: vec![],
            via_ways: vec![],
            to: vec![],
            malformed: false,
        };
        for mem in &rel.members {
            match (mem.role.as_str(), mem.kind) {
                ("from", MemberKind::Way) => m.from.push(mem.id),
                ("via", MemberKind::Way) => m.via_ways.push(mem.id),
                ("via", MemberKind::Node) => m.via_nodes.push(mem.id),
                ("to", MemberKind::Way) => m.to.push(mem.id),
                ("via" | "from" | "to", _) => m.malformed = true,
                _ => {},
            }
        }
        m
    }
}

fn paths(db: &Connection, m: &Members, value: &str) -> Result<Option<Vec<Vec<i64>>>> {
    let known = matches!(
        value,
        "no_right_turn"
            | "no_left_turn"
            | "no_u_turn"
            | "no_straight_on"
            | "only_right_turn"
            | "only_left_turn"
            | "only_u_turn"
            | "only_straight_on"
            | "no_entry"
            | "no_exit"
    );
    if !known
        || m.malformed
        || m.from.is_empty()
        || m.to.is_empty()
        || (m.from.len() > 1 && value != "no_entry")
        || (m.to.len() > 1 && value != "no_exit")
        || m.via_ways.len() > 256
        || !(m.via_nodes.len() == 1 && m.via_ways.is_empty()
            || m.via_nodes.is_empty() && !m.via_ways.is_empty())
    {
        return Ok(None);
    }
    let via: Vec<_> = m
        .via_ways
        .iter()
        .map(|&id| Way::read(db, id))
        .collect::<Result<_>>()?;
    let mut result = vec![];
    for &from in &m.from {
        let first = Way::read(db, from)?;
        if first.edges.is_empty() {
            // この抽出範囲では、どの移動手段もこの道路から進入できない。
            continue;
        }
        for &to in &m.to {
            let last = Way::read(db, to)?;
            let mut passage = vec![];
            let (enter, exit) = if let Some(&node) = m.via_nodes.first() {
                (node, node)
            } else {
                let Some(enter) = first.intersection(&via[0]) else {
                    return Ok(None);
                };
                let mut previous = enter;
                for (i, part) in via.iter().enumerate() {
                    let Some(next) = part.intersection(via.get(i + 1).unwrap_or(&last)) else {
                        return Ok(None);
                    };
                    let Some(edges) = part.between(previous, next) else {
                        return Ok(None);
                    };
                    passage.extend(edges);
                    previous = next;
                }
                (enter, previous)
            };
            let incoming = first.arriving(enter);
            let outgoing = last.arriving(exit);
            if incoming.is_empty() || outgoing.is_empty() {
                return Ok(None);
            }
            let before = result.len();
            for a in incoming {
                for &backward in &outgoing {
                    let b = -backward;
                    if from == to && passage.is_empty() && (a == -b) != value.ends_with("_u_turn") {
                        continue;
                    }
                    let mut sequence = Vec::with_capacity(passage.len() + 2);
                    sequence.push(a);
                    sequence.extend_from_slice(&passage);
                    sequence.push(b);
                    result.push(sequence);
                }
            }
            if result.len() == before {
                return Ok(None);
            }
        }
    }
    Ok(Some(result))
}

/// 規制が参照する位置が道路網にあるかを返す。経由ノードだけの規制はその地点での通過を禁止し、
/// 両側からその手前の住所までは到達できるようにする。
fn exclude(db: &Connection, rel: &Relation, m: &Members, mode: TravelMode) -> Result<bool> {
    let location = if m.from.is_empty() {
        &rel.members[..]
    } else {
        let mut exists = false;
        for &id in &m.from {
            exists |= exclude_way(db, id, mode)?;
        }
        return Ok(exists);
    };
    let column = match mode {
        TravelMode::Car => "car",
        TravelMode::Foot => "foot",
    };
    let mut node = db.prepare_cached(&format!("UPDATE nodes SET {column}=0 WHERE id=?"))?;
    let mut exists = false;
    for &id in &m.via_nodes {
        exists |= node.execute([id])? > 0;
    }
    if exists {
        return Ok(true);
    }
    for member in location {
        match member.kind {
            MemberKind::Way => exists |= exclude_way(db, member.id, mode)?,
            MemberKind::Node => exists |= node.execute([member.id])? > 0,
            MemberKind::Relation => {},
        }
    }
    ensure!(
        exists || location.iter().any(|m| m.kind != MemberKind::Relation),
        "規制Relation {} は対象道路・地点を示す参照を持たず、適用範囲を特定できません",
        rel.id
    );
    Ok(exists)
}

fn exclude_way(db: &Connection, way: i64, mode: TravelMode) -> Result<bool> {
    let found: bool = db
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM edges WHERE way=?)")?
        .query_row([way], |r| r.get(0))?;
    if found {
        db.prepare_cached("INSERT OR IGNORE INTO blocked VALUES(?,?)")?
            .execute(params![way, mode.number()])?;
    }
    Ok(found)
}

pub(super) fn resolve(
    db: &Connection,
    check: &mut impl FnMut() -> Result<()>,
    mut progress: impl FnMut(u64, u64),
) -> Result<(u64, u64)> {
    let total = db.query_row("SELECT count(*) FROM relations", [], |r| r.get(0))?;
    let mut done = 0;
    progress(0, total);
    let mut source = db.prepare("SELECT document FROM relations ORDER BY id")?;
    let mut rows = source.query([])?;
    let mut insert = db.prepare("INSERT OR IGNORE INTO turns VALUES(?,?,?,?)")?;
    let mut excluded = 0;
    let mut outside = 0;
    while let Some(row) = rows.next()? {
        check()?;
        let rel: Relation = serde_json::from_str(&row.get::<_, String>(0)?)?;
        let m = Members::new(&rel);
        if applies(&rel, TravelMode::Car)
            && (restriction(&rel, TravelMode::Car, false).is_some()
                || restriction(&rel, TravelMode::Car, true).is_some())
        {
            for &node in &m.via_nodes {
                db.prepare_cached("UPDATE nodes SET shape=0 WHERE id=?")?
                    .execute([node])?;
            }
        }
        let mut skipped = false;
        let mut external = false;
        for mode in [TravelMode::Car, TravelMode::Foot] {
            if !applies(&rel, mode) {
                continue;
            }
            let value = restriction(&rel, mode, false);
            let conditional = restriction(&rel, mode, true);
            if value.is_none() && conditional.is_none() {
                continue;
            }
            if conditional.is_none()
                && let Some(v) = value
                && let Some(paths) = paths(db, &m, v)?
            {
                external |= paths.is_empty();
                for path in paths {
                    let blob: Vec<_> = path.iter().flat_map(|edge| edge.to_le_bytes()).collect();
                    insert.execute(params![rel.id, mode.number(), v.starts_with("only_"), blob])?;
                }
            } else {
                if exclude(db, &rel, &m, mode)? {
                    skipped = true;
                } else {
                    external = true;
                }
            }
        }
        excluded += u64::from(skipped);
        outside += u64::from(external && !skipped);
        done += 1;
        if done % 64 == 0 || done == total {
            progress(done, total);
        }
    }
    Ok((excluded, outside))
}

#[derive(Default)]
struct Prefix {
    next: HashMap<i64, usize>,
    only: HashSet<i64>,
    forbidden: bool,
    suffix: usize,
}

/// 接尾辞へのリンクを持つトライ木で通行規制を照合する。同じ進入経路に複数の only_* 規制があれば、
/// 各規制が許す進行先をすべて認める。経路の末尾に一致する別の規制も、それぞれ独立に判定する。
pub(super) struct TurnRules(Vec<Prefix>);
impl TurnRules {
    pub(super) fn read(
        db: &Connection,
        mode: TravelMode,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<Self> {
        let mut trie = vec![Prefix::default()];
        let mut stmt = db.prepare("SELECT only_turn,sequence FROM turns WHERE mode=?")?;
        let mut rows = stmt.query([mode.number()])?;
        let mut visited = 0_u64;
        while let Some(row) = rows.next()? {
            let only: bool = row.get(0)?;
            let blob = row.get_ref(1)?.as_blob()?;
            ensure!(
                blob.len() >= 16 && blob.len() % 8 == 0,
                "経路規制の有向辺列が不正です"
            );
            let mut node = 0;
            for (i, chunk) in blob.chunks_exact(8).enumerate() {
                if visited.is_multiple_of(256) {
                    check()?;
                }
                visited += 1;
                let token = i64::from_le_bytes(chunk.try_into()?);
                if i != 0 && only {
                    trie[node].only.insert(token);
                }
                let next = if let Some(&n) = trie[node].next.get(&token) {
                    n
                } else {
                    let n = trie.len();
                    trie.push(Prefix::default());
                    trie[node].next.insert(token, n);
                    n
                };
                node = next;
            }
            if !only {
                trie[node].forbidden = true;
            }
        }
        let mut queue: VecDeque<usize> = trie[0].next.values().copied().collect();
        while let Some(node) = queue.pop_front() {
            if visited.is_multiple_of(256) {
                check()?;
            }
            visited += 1;
            let children: Vec<_> = trie[node].next.iter().map(|(&t, &n)| (t, n)).collect();
            for (token, child) in children {
                let mut suffix = trie[node].suffix;
                while suffix != 0 && !trie[suffix].next.contains_key(&token) {
                    suffix = trie[suffix].suffix;
                }
                trie[child].suffix = trie[suffix].next.get(&token).copied().unwrap_or(0);
                queue.push_back(child);
            }
        }
        Ok(Self(trie))
    }

    pub(super) fn advance(&self, mut node: usize, token: i64) -> Option<usize> {
        let mut active = node;
        while active != 0 {
            let p = &self.0[active];
            if !p.only.is_empty() && !p.only.contains(&token) {
                return None;
            }
            active = p.suffix;
        }
        while node != 0 && !self.0[node].next.contains_key(&token) {
            node = self.0[node].suffix;
        }
        let next = self.0[node].next.get(&token).copied().unwrap_or(0);
        let mut active = next;
        while active != 0 {
            if self.0[active].forbidden {
                return None;
            }
            active = self.0[active].suffix;
        }
        Some(next)
    }
}
