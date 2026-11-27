use super::*;
use crate::tilegen::test_support::Fixture;
use axum::body::{Body, to_bytes};
use serde_json::Value;
use std::{fs, net::Ipv4Addr};
use tower::ServiceExt;
use uuid::Uuid;

const QUERY: &str = "alternatives=false&steps=false&geometries=polyline&overview=simplified&annotations=false&radiuses=100;100&generate_hints=false";

pub(crate) fn app_with_graph(api_key: Option<String>) -> (tempfile::TempDir, Router) {
    let dir = tempfile::tempdir().unwrap();
    let id = Uuid::new_v4();
    let gen_dir = dir.path().join("routing").join(id.to_string());
    fs::create_dir_all(&gen_dir).unwrap();
    let pbf = dir.path().join("sample.osm.pbf");
    let mut fixture = Fixture::sample();
    fixture.ways[0].tags.insert("oneway".into(), "yes".into());
    fixture.write(&pbf);
    let info =
        crate::local_routing::build(&pbf, &gen_dir.join("graph.sqlite"), || Ok(()), |_, _| {})
            .unwrap();
    fs::write(
        gen_dir.join("generation.json"),
        serde_json::to_vec(&json!({
            "id":id, "name":"試験", "sequence":1, "created_at":"2026-01-01", "info":info
        }))
        .unwrap(),
    )
    .unwrap();
    let app = router(dir.path().to_path_buf(), "試験".into(), api_key);
    (dir, app)
}

async fn call(
    app: &Router,
    path: &str,
    peer: Option<Ipv4Addr>,
    key: Option<&str>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().uri(path);
    if let Some(peer) = peer {
        req = req.extension(ConnectInfo(SocketAddr::new(peer.into(), 12345)));
    }
    if let Some(key) = key {
        req = req.header("X-API-Key", key);
    }
    // ループバックからの接続かどうかは、転送ヘッダーの内容に依存しない。
    let response = app
        .clone()
        .oneshot(
            req.header("x-forwarded-for", "127.0.0.1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    (
        response.status(),
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap(),
    )
}

#[tokio::test]
async fn car_and_foot_serve_the_existing_clients_and_distinguish_failures() {
    let (_dir, app) = app_with_graph(None);
    let peer = Some(Ipv4Addr::LOCALHOST);
    let car = "/local-routing/car/route/v1/driving";
    let foot = "/local-routing/foot/route/v1/foot";
    let forward = "139.699000,35.700000;139.701000,35.701000";
    let reverse = "139.701000,35.701000;139.699000,35.700000";
    for (base, segments) in [(car, forward), (foot, reverse)] {
        let (status, response) =
            call(&app, &format!("{base}/{segments}?{QUERY}"), peer, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(response["code"], "Ok");
        assert!(response["routes"][0]["distance"].as_f64().unwrap() > 200.);
        assert!(response["routes"][0]["geometry"].as_str().unwrap().len() > 8);
    }
    let (status, data) = call(&app, &format!("{car}/{reverse}?{QUERY}"), peer, None).await;
    assert_eq!(
        (status, data["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("NoRoute"))
    );
    assert_eq!(
        call(&app, &format!("{car}/{forward}?steps=true"), peer, None)
            .await
            .1["code"],
        "InvalidOptions"
    );
    for radii in ["unlimited;100", "500;501"] {
        assert_eq!(
            call(
                &app,
                &format!("{car}/{forward}?radiuses={radii}"),
                peer,
                None
            )
            .await
            .1["code"],
            "InvalidOptions"
        );
    }
    assert_eq!(
        call(&app, &format!("{car}/NaN,35;139,36"), peer, None)
            .await
            .1["code"],
        "InvalidQuery"
    );
}

#[tokio::test]
async fn both_modes_use_500_m_by_default_and_respect_smaller_requested_radii() {
    let (_dir, app) = app_with_graph(None);
    let peer = Some(Ipv4Addr::LOCALHOST);
    // 道路の端から出発地までは約300 m、目的地までは約499 m離れている。
    let near = "139.699000,35.697300;139.701000,35.705490";
    let outside = "139.699000,35.697300;139.701000,35.705510";
    for base in [
        "/local-routing/car/route/v1/driving",
        "/local-routing/foot/route/v1/foot",
    ] {
        for (coords, query, status, code) in [
            (near, "", StatusCode::OK, "Ok"),
            (near, "?radiuses=350;500", StatusCode::OK, "Ok"),
            (
                near,
                "?radiuses=100;500",
                StatusCode::BAD_REQUEST,
                "NoSegment",
            ),
            (
                near,
                "?radiuses=500;100",
                StatusCode::BAD_REQUEST,
                "NoSegment",
            ),
            (outside, "", StatusCode::BAD_REQUEST, "NoSegment"),
        ] {
            let (actual, data) = call(&app, &format!("{base}/{coords}{query}"), peer, None).await;
            assert_eq!((actual, data["code"].as_str()), (status, Some(code)));
        }
    }
}

#[tokio::test]
async fn auth_uses_the_socket_peer_or_constant_time_api_key_comparison() {
    let dir = tempfile::tempdir().unwrap();
    let path = "/local-routing/foot/route/v1/foot/139,35;139,36";
    let app = router(dir.path().to_owned(), "未公開".into(), None);
    assert_eq!(
        call(&app, path, None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let remote = Some(Ipv4Addr::new(10, 0, 0, 1));
    assert_eq!(
        call(&app, path, remote, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, path, Some(Ipv4Addr::LOCALHOST), None).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let app = router(
        dir.path().to_owned(),
        "未公開".into(),
        Some("secret".into()),
    );
    for key in [None, Some(""), Some("secrett")] {
        assert_eq!(
            call(&app, path, Some(Ipv4Addr::LOCALHOST), key).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        call(&app, path, remote, Some("secret")).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn saturated_provider_replies_429_before_opening_a_database() {
    let service = Arc::new(Service {
        root: PathBuf::new(),
        dataset_name: "試験".into(),
        api_key: None,
        searches: Arc::new(Semaphore::new(1)),
    });
    let _busy = service.searches.clone().try_acquire_owned().unwrap();
    let failure = route(
        State(service),
        Extension(TravelMode::Foot),
        Ok(Path("139,35;139,36".into())),
        Ok(Query(Options::default())),
    )
    .await
    .unwrap_err();
    assert_eq!(
        failure.into_response().status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn disconnect_and_deadline_cancel_only_their_own_worker_and_retain_its_slot() {
    let searches = Arc::new(Semaphore::new(2));
    for disconnect in [true, false] {
        let (running, started) = tokio::sync::oneshot::channel();
        let (stopped, observed) = tokio::sync::oneshot::channel();
        let (release, until_release) = std::sync::mpsc::channel();
        let slot = searches.clone().try_acquire_owned().unwrap();
        let budget = if disconnect {
            Duration::from_secs(3)
        } else {
            Duration::from_millis(200)
        };
        let task = tokio::spawn(run_search(slot, budget, move |check| {
            running.send(()).unwrap();
            while check().is_ok() {
                std::thread::sleep(Duration::from_millis(2));
            }
            stopped.send(()).unwrap();
            until_release.recv_timeout(Duration::from_secs(3)).unwrap();
            Ok(())
        }));
        started.await.unwrap();
        let other_request = searches.clone().try_acquire_owned().unwrap();
        if disconnect {
            task.abort();
            assert!(task.await.is_err());
        } else {
            assert_eq!(task.await.unwrap(), Err(Failure::Timeout));
        }
        tokio::time::timeout(Duration::from_secs(3), observed)
            .await
            .unwrap()
            .unwrap();
        assert!(searches.try_acquire().is_err());
        release.send(()).unwrap();
        let recovered = tokio::time::timeout(Duration::from_secs(3), searches.acquire())
            .await
            .unwrap()
            .unwrap();
        drop((recovered, other_request));
    }
}
