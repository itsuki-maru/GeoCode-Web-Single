use super::*;
use crate::tilegen::{
    pbf::{Member, MemberKind, Node, Relation, Way},
    test_support::Fixture,
};
use tempfile::TempDir;

fn coord(x: f64, y: f64) -> Coord {
    Coord {
        lat: 35. + y * 0.01,
        lon: 139. + x * 0.01,
    }
}
fn tag(values: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
    values.iter().map(|&(k, v)| (k.into(), v.into())).collect()
}
fn way(id: i64, nodes: &[i64], tags: &[(&str, &str)]) -> Way {
    let mut t = tag(&[("highway", "residential")]);
    t.extend(tag(tags));
    Way {
        id,
        nodes: nodes.into(),
        tags: t,
    }
}
fn fixture(nodes: &[(i64, Coord)], ways: Vec<Way>) -> Fixture {
    let mut f = Fixture::sample();
    f.ways = ways;
    f.dense = true;
    f.zlib = true;
    f.ways_first = true;
    f.relations_first = true;
    f.nodes = nodes
        .iter()
        .map(|(id, p)| Node {
            id: *id,
            lat: p.lat,
            lon: p.lon,
        })
        .collect();
    f
}
fn graph(f: &Fixture) -> Result<(TempDir, std::path::PathBuf, GraphInfo)> {
    let dir = tempfile::tempdir()?;
    let input = dir.path().join("fixture.pbf");
    let path = dir.path().join("graph.sqlite");
    f.write(&input);
    let info = build(&input, &path, || Ok(()), |_, _| {})?;
    Ok((dir, path, info))
}
fn restriction(v: &str) -> Relation {
    Relation {
        id: 100,
        tags: tag(&[("type", "restriction"), ("restriction", v)]),
        members: vec![
            Member {
                id: 1,
                kind: MemberKind::Way,
                role: "from".into(),
            },
            Member {
                id: 2,
                kind: MemberKind::Node,
                role: "via".into(),
            },
            Member {
                id: 2,
                kind: MemberKind::Way,
                role: "to".into(),
            },
        ],
    }
}
fn assert_error(result: Result<RouteResult>, expected: SearchError) {
    assert_eq!(
        result
            .unwrap_err()
            .downcast::<SearchError>()
            .unwrap()
            .to_string(),
        expected.to_string()
    );
}

#[test]
fn directed_interiors_and_failure_types() -> Result<()> {
    let f = fixture(
        &[(1, coord(0., 0.)), (2, coord(1., 0.))],
        vec![way(8, &[1, 2], &[("oneway", "-1")])],
    );
    let (_dir, path, info) = graph(&f)?;
    assert_eq!(info.edge_count, 1);
    let a = coord(0.25, 0.);
    let b = coord(0.75, 0.);
    let route = search(&path, TravelMode::Car, b, a)?;
    assert!((route.distance_m - b.distance(a)).abs() < 0.05);
    assert!(route.duration_s > 0.);
    assert_eq!(route.geometry.len(), 2);
    assert_error(search(&path, TravelMode::Car, a, b), SearchError::NoRoute);
    assert!(search(&path, TravelMode::Foot, a, b).is_ok());
    assert_error(
        search(&path, TravelMode::Foot, coord(6., 6.), b),
        SearchError::NoSnap,
    );
    Ok(())
}

#[test]
fn search_uses_each_requested_snap_radius_and_keeps_the_gui_default() -> Result<()> {
    let f = fixture(
        &[(1, coord(0., 0.)), (2, coord(1., 0.))],
        vec![way(1, &[1, 2], &[])],
    );
    let (_dir, path, _) = graph(&f)?;
    let a = coord(0.2, 0.27); // 道路から約300 m。
    let b = coord(0.8, 0.449); // 道路から約499 m。
    let outside = coord(0.8, 0.451); // 道路から約502 m。
    for mode in [TravelMode::Car, TravelMode::Foot] {
        assert!(search(&path, mode, a, b).is_ok());
        assert_error(search(&path, mode, a, outside), SearchError::NoSnap);
        assert!(search_with_radii(&path, mode, a, b, [350., 500.], || Ok(())).is_ok());
        for radii in [[250., 500.], [350., 450.]] {
            assert_error(
                search_with_radii(&path, mode, a, b, radii, || Ok(())),
                SearchError::NoSnap,
            );
        }
    }
    Ok(())
}

#[test]
fn routing_respects_turns_at_partial_destinations_and_mode_exceptions() -> Result<()> {
    let nodes = [
        (1, coord(-1., 0.)),
        (2, coord(0., 0.)),
        (3, coord(0., 1.)),
        (4, coord(0., -1.)),
    ];
    let mut f = fixture(
        &nodes,
        vec![
            way(1, &[1, 2], &[("oneway", "yes")]),
            way(2, &[2, 3], &[("oneway", "yes")]),
            way(3, &[2, 4], &[("oneway", "yes")]),
        ],
    );
    for rule in ["no_left_turn", "only_right_turn"] {
        let mut rel = restriction(rule);
        if rule == "only_right_turn" {
            rel.members[2].id = 3;
        }
        f.relations = vec![rel];
        let (_dir, path, info) = graph(&f)?;
        assert_eq!(info.restriction_count, 1);
        assert_error(
            search(&path, TravelMode::Car, coord(-0.5, 0.), coord(0., 0.5)),
            SearchError::NoRoute,
        );
        assert!(search(&path, TravelMode::Foot, coord(-0.5, 0.), coord(0., 0.5)).is_ok());
        assert!(search(&path, TravelMode::Car, coord(-0.5, 0.), coord(0., -0.5)).is_ok());
    }
    let mut rel = restriction("no_left_turn");
    rel.tags.insert("except".into(), "bus;motorcar".into());
    f.relations = vec![rel];
    let (_dir, path, _) = graph(&f)?;
    assert!(search(&path, TravelMode::Car, coord(-0.5, 0.), coord(0., 0.5)).is_ok());
    Ok(())
}

#[test]
fn car_shape_chains_match_dijkstra_for_full_and_partial_travel_in_both_directions() -> Result<()> {
    let nodes = [
        (1, coord(0., 0.)),
        (2, coord(1., 0.)),
        (3, coord(2., 0.25)),
        (4, coord(3., 0.)),
        (5, coord(4., -0.5)),
        (6, coord(5., 0.)),
        (7, coord(6., 0.)),
    ];
    let f = fixture(&nodes, vec![way(1, &[1, 2, 3, 4, 5, 6, 7], &[])]);
    let (_dir, path, _) = graph(&f)?;
    for (origin, destination, points) in [
        (nodes[0].1, nodes[6].1, 7),
        (coord(0.5, 0.), coord(5.5, 0.), 7),
        (coord(0.5, 0.), coord(3.5, -0.25), 5),
        (nodes[3].1, nodes[6].1, 4),
    ] {
        for (a, b) in [(origin, destination), (destination, origin)] {
            let actual = search(&path, TravelMode::Car, a, b)?;
            let reference = super::search::solve(
                &path,
                TravelMode::Car,
                a,
                b,
                [SNAP_RADIUS_M; 2],
                f64::INFINITY,
                &mut || Ok(()),
            )?;
            assert_eq!(actual.geometry.len(), points);
            assert_eq!(actual.geometry, reference.geometry);
            assert_eq!(actual.distance_m, reference.distance_m);
            assert_eq!(actual.duration_s, reference.duration_s);
        }
    }
    Ok(())
}

#[test]
fn crossings_and_node_barriers() -> Result<()> {
    let nodes = [
        (1, coord(-1., 0.)),
        (2, coord(1., 0.)),
        (3, coord(0., -1.)),
        (4, coord(0., 1.)),
        (5, coord(1., 1.)),
        (6, coord(2., 1.)),
    ];
    let mut f = fixture(
        &nodes,
        vec![
            way(1, &[1, 2], &[("bridge", "yes")]),
            way(2, &[3, 4, 5, 6], &[]),
        ],
    );
    f.node_tags.insert(5, tag(&[("barrier", "bollard")]));
    let (_dir, path, _) = graph(&f)?;
    assert_error(
        search(&path, TravelMode::Car, coord(-0.75, 0.), coord(0., 0.8)),
        SearchError::NoRoute,
    );
    assert_error(
        search(&path, TravelMode::Car, coord(0., 0.8), coord(1.8, 1.)),
        SearchError::NoRoute,
    );
    // 車止めは5番ノード。両側の家までの区間は車でも通行できる。
    assert!(search(&path, TravelMode::Car, coord(0.1, 1.), coord(0.99, 1.)).is_ok());
    assert!(search(&path, TravelMode::Car, coord(1.1, 1.), coord(1.9, 1.)).is_ok());
    assert_error(
        search(&path, TravelMode::Car, coord(0.99, 1.), coord(1.01, 1.)),
        SearchError::NoRoute,
    );
    assert!(search(&path, TravelMode::Foot, coord(0., 0.8), coord(1.8, 1.)).is_ok());
    Ok(())
}

#[test]
fn missing_nodes_and_cancellation_keep_output_unpublished() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let input = dir.path().join("fixture.pbf");
    let output = dir.path().join("g.sqlite");
    let mut f = Fixture::sample();
    f.nodes.pop();
    f.write(&input);
    assert!(build(&input, &output, || Ok(()), |_, _| {}).is_err());
    assert!(!output.exists());
    let mut checks = 0;
    Fixture::sample().write(&input);
    assert!(
        build(
            &input,
            &output,
            || {
                checks += 1;
                anyhow::ensure!(checks < 6, "cancelled");
                Ok(())
            },
            |_, _| {}
        )
        .is_err()
    );
    assert!(!output.exists());
    Ok(())
}

#[test]
fn multi_via_way_restrictions_preserve_incoming_history() -> Result<()> {
    // 通行方向 1 -> 2 -> 3 -> 4 -> 5 -> 6。最初のvia-wayは逆向きのOSM形状。
    let nodes = [
        (1, coord(-1., 0.)),
        (2, coord(0., 0.)),
        (3, coord(1., 0.)),
        (4, coord(2., 0.)),
        (5, coord(3., 0.)),
        (6, coord(4., 0.)),
        (7, coord(0., -1.)),
        (8, coord(1., 1.)),
        (9, coord(3., 1.)),
        (10, coord(1.6, 0.1)),
    ];
    let forward = &[("oneway", "yes")];
    let mut f = fixture(
        &nodes,
        vec![
            way(1, &[1, 2], forward),
            way(2, &[4, 10, 3, 2], &[("oneway", "-1")]),
            way(3, &[4, 5], forward),
            way(4, &[5, 6], forward),
            way(5, &[7, 2], forward),
            way(6, &[3, 8], forward),
            way(7, &[5, 9], forward),
        ],
    );
    let mut rel = restriction("no_straight_on");
    rel.members = vec![
        Member {
            id: 1,
            kind: MemberKind::Way,
            role: "from".into(),
        },
        Member {
            id: 2,
            kind: MemberKind::Way,
            role: "via".into(),
        },
        Member {
            id: 3,
            kind: MemberKind::Way,
            role: "via".into(),
        },
        Member {
            id: 4,
            kind: MemberKind::Way,
            role: "to".into(),
        },
    ];
    f.relations = vec![rel.clone()];
    let (_dir, path, info) = graph(&f)?;
    assert_eq!(info.excluded_restriction_count, 0);
    assert_eq!(info.restriction_count, 1);
    let start = coord(-0.5, 0.);
    let end = coord(3.5, 0.);
    assert_error(
        search(&path, TravelMode::Car, start, end),
        SearchError::NoRoute,
    );
    assert!(search(&path, TravelMode::Car, coord(0., -0.6), end).is_ok());
    assert!(search(&path, TravelMode::Foot, start, end).is_ok());
    assert!(search(&path, TravelMode::Car, start, coord(1., 0.6)).is_ok());
    rel.tags
        .insert("restriction".into(), "only_straight_on".into());
    let mut alternative = rel.clone();
    alternative.id = 101;
    alternative.members.last_mut().unwrap().id = 7;
    f.relations = vec![rel, alternative];
    let (_dir, path, info) = graph(&f)?;
    assert_eq!(info.restriction_count, 2);
    assert!(search(&path, TravelMode::Car, start, end).is_ok());
    assert!(search(&path, TravelMode::Car, start, coord(3., 0.6)).is_ok());
    assert_error(
        search(&path, TravelMode::Car, start, coord(1., 0.6)),
        SearchError::NoRoute,
    );
    Ok(())
}

#[test]
fn conditional_vehicle_restriction_excludes_affected_entry_only_for_cars() -> Result<()> {
    let nodes = [
        (1, coord(-1., 0.)),
        (2, coord(0., 0.)),
        (3, coord(0., 1.)),
        (4, coord(1., 0.)),
    ];
    let mut f = fixture(
        &nodes,
        vec![
            way(1, &[1, 2], &[]),
            way(2, &[2, 3], &[]),
            way(3, &[4, 2], &[]),
        ],
    );
    let mut r = restriction("no_left_turn");
    r.tags.remove("restriction");
    r.tags.insert(
        "restriction:conditional".into(),
        "no_left_turn @ (Mo-Fr 08:00-09:00)".into(),
    );
    f.relations = vec![r];
    let (_dir, path, info) = graph(&f)?;
    assert_eq!(info.excluded_restriction_count, 1);
    assert_error(
        search(&path, TravelMode::Car, coord(-0.9, 0.), coord(0., 0.7)),
        SearchError::NoSnap,
    );
    assert!(search(&path, TravelMode::Foot, coord(-0.9, 0.), coord(0., 0.7)).is_ok());
    assert!(search(&path, TravelMode::Car, coord(0.9, 0.), coord(0., 0.7)).is_ok());
    Ok(())
}

#[test]
fn car_turns_back_at_real_dead_end_not_first_shape_point() -> Result<()> {
    let nodes = [
        (1, coord(-1., 0.)),
        (2, coord(0., 0.)),
        (3, coord(0., 1.)),
        (4, coord(0., -0.1)),
        (5, coord(0., -1.)),
    ];
    let mut f = fixture(
        &nodes,
        vec![
            way(1, &[1, 2], &[("oneway", "yes")]),
            way(2, &[2, 3], &[("oneway", "yes")]),
            way(3, &[2, 4, 5], &[]),
        ],
    );
    f.relations = vec![restriction("no_left_turn")];
    let (_dir, path, _) = graph(&f)?;
    let car = search(&path, TravelMode::Car, coord(-0.7, 0.), coord(0., 0.7))?;
    assert!(
        car.geometry
            .iter()
            .any(|p| p.distance(coord(0., -1.)) < 0.01)
    );
    Ok(())
}

#[test]
fn incomplete_restrictions_block_local_members_and_count_external_references() -> Result<()> {
    let nodes = [
        (1, coord(-1., 0.)),
        (2, coord(0., 0.)),
        (3, coord(1., 0.)),
        (4, coord(0., 1.)),
    ];
    for role in ["via", "", "from"] {
        let mut f = fixture(&nodes, vec![way(1, &[1, 2, 3], &[]), way(2, &[2, 4], &[])]);
        let mut rel = restriction("only_straight_on");
        rel.id = 2428415;
        rel.tags.insert("except".into(), "bicycle".into());
        rel.members = vec![Member {
            id: 2,
            kind: MemberKind::Node,
            role: role.into(),
        }];
        let mut external = rel.clone();
        external.id += 1;
        external.members[0].id = 9999;
        f.relations = vec![rel, external];
        let (_dir, path, info) = graph(&f)?;
        assert_eq!(info.excluded_restriction_count, 1);
        assert_eq!(info.outside_restriction_count, 1);
        assert_error(
            search(&path, TravelMode::Car, coord(-0.05, 0.), coord(0.05, 0.)),
            SearchError::NoRoute,
        );
        assert!(search(&path, TravelMode::Foot, coord(-0.05, 0.), coord(0.05, 0.)).is_ok());
        assert!(search(&path, TravelMode::Car, coord(-0.5, 0.), coord(-0.01, 0.)).is_ok());
    }
    for role in ["via", "to", ""] {
        let mut f = fixture(&nodes, vec![way(1, &[1, 2, 3], &[]), way(2, &[2, 4], &[])]);
        let mut rel = restriction("no_right_turn");
        rel.members = vec![Member {
            id: 2,
            kind: MemberKind::Way,
            role: role.into(),
        }];
        f.relations = vec![rel];
        let (_dir, path, info) = graph(&f)?;
        assert_eq!(info.excluded_restriction_count, 1);
        assert_error(
            search(&path, TravelMode::Car, coord(0., 0.8), coord(0.8, 0.)),
            SearchError::NoSnap,
        );
        assert!(search(&path, TravelMode::Foot, coord(0., 0.8), coord(0.8, 0.)).is_ok());
    }
    Ok(())
}

#[test]
fn astar_and_dijkstra_agree_for_directional_network_and_mode_specific_costs() -> Result<()> {
    let nodes = [
        (1, coord(-1., 0.)),
        (2, coord(0., 0.)),
        (3, coord(0., 1.)),
        (4, coord(1., 0.)),
        (5, coord(1., 1.)),
    ];
    let mut f = fixture(
        &nodes,
        vec![
            way(1, &[1, 2], &[("oneway", "yes")]),
            way(2, &[2, 3], &[("maxspeed:forward", "5")]),
            way(3, &[2, 4], &[]),
            way(4, &[4, 5], &[]),
            way(5, &[5, 3], &[]),
        ],
    );
    f.relations = vec![restriction("no_left_turn")];
    let (_dir, path, _) = graph(&f)?;
    for mode in [TravelMode::Car, TravelMode::Foot] {
        for &(_, a) in &nodes {
            for &(_, b) in &nodes {
                let actual = search(&path, mode, a, b);
                let expected = super::search::solve(
                    &path,
                    mode,
                    a,
                    b,
                    [SNAP_RADIUS_M; 2],
                    f64::INFINITY,
                    &mut || Ok(()),
                );
                match (actual, expected) {
                    (Ok(x), Ok(y)) => {
                        assert!((x.duration_s - y.duration_s).abs() < 1e-6);
                    },
                    (Err(x), Err(y)) => {
                        assert_eq!(x.to_string(), y.to_string());
                    },
                    (x, y) => panic!("reference differs: {x:?} / {y:?}"),
                }
            }
        }
    }
    Ok(())
}
