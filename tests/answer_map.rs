#[allow(dead_code)]
mod common;
#[path = "support/popup_projection_cases.rs"]
mod popup_projection_cases;
use axum::{Form, Json, body::to_bytes, extract::Extension};
use chrono::{Duration, Utc};
use geocode_web_single::handler::{
    answer_map::{AnswerMapRequest, answer_map_handler, load_answer_map},
    form_answers::{AnswerQuery, search_answers_handler},
};
use popup_projection_cases::PopupCase;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

fn query(value: Value) -> AnswerQuery {
    serde_json::from_value(value).unwrap()
}
#[test]
fn answer_bootstrap_json_block_round_trips_script_breakout_unicode_and_property_names() {
    let text = "</ScRiPt><script id=\"bootstrap-breakout\">globalThis.breakout=true</script>&\u{2028}\u{2029}漢字𠮷🙂e\u{301}";
    let popups = json!({"marker:marker-1":{"free_text":text,"managed_markdown":format!("**{text}**"),"sync_required":false}});
    let preview = json!({"answerCount":3,"targetCount":2,"parentOrigin":"http://localhost:3000","requestId":"json-test",
        "query":{"mode":"history","as_of":"2026-10-01T00:00:00Z","target_name":text},
        "targets":["marker:marker-1","shape:shape-1"],"initialView":{"latitude":34.69,"longitude":135.5,"zoom":12}});
    let layers =
        json!({"layer-1":{"id":"layer-1","layer_name":text},"__proto__":{"polluted":"data only"}});
    let markers = json!({"marker-1":{"id":"marker-1","detail":text}});
    let shapes = json!([{"id":"shape-1","geojson":{"properties":{"memo":text}}}]);
    let tiles = json!({});
    let overlays = json!([]);
    let mut context = tera::Context::new();
    context.insert("popupBodies", &popups);
    context.insert("answerPreview", &preview);
    context.insert("layersFromAxum", &layers);
    context.insert("markersFromAxum", &markers);
    context.insert("shapesFromAxum", &shapes);
    context.insert("tileServers", &tiles);
    context.insert("tileOverlays", &overlays);
    context.insert("tileVisibilityAccountId", &"account");
    context.insert("is_cluster", &true);
    context.insert("latitude", &37.65);
    context.insert("longitude", &138.25);
    context.insert("zoom", &6);
    // Keep the production filter and render the current source template, so
    // this test does not depend on rebuilding the ignored embedded dist first.
    let mut templates = geocode_web_single::build_tera_from_embed().unwrap();
    templates
        .add_raw_template(
            "bootstrap-regression.html",
            include_str!("../src/templates/form-answer-map.html"),
        )
        .unwrap();
    let html = templates
        .render("bootstrap-regression.html", &context)
        .unwrap();
    let id_attribute = r#"id="geocode-map-bootstrap""#;
    assert_eq!(html.matches(id_attribute).count(), 1);
    let id_start = html.find(id_attribute).unwrap();
    let script_start = html[..id_start].rfind("<script").unwrap();
    let (opening, content) = html[script_start..].split_once('>').unwrap();
    assert!(opening.contains(r#"type="application/json""#));
    let (raw, _) = content.split_once("</script>").unwrap();
    assert!(!raw.contains('<'));
    assert!(!raw.contains('&'));
    assert!(!raw.contains('\u{2028}') && !raw.contains('\u{2029}'));
    assert!(!html.contains("<script id=\"bootstrap-breakout\">"));
    assert!(!html.contains("window.__GEOCODE_MAP_BOOTSTRAP__"));
    let parsed: Value = serde_json::from_str(raw).unwrap();
    assert_eq!(
        parsed,
        json!({"page":"form-answer-map","isCluster":true,
        "initialView":{"latitude":37.65,"longitude":138.25,"zoom":6},
        "popupBodies":popups,"answerPreview":preview,"layers":layers,"markers":markers,"shapes":shapes,
        "tileServers":tiles,"tileOverlays":overlays,"tileVisibilityAccountId":"account"})
    );
}

#[sqlx::test]
async fn answer_map_transport_restores_stored_and_ambiguous_bodies_and_keeps_fallbacks(
    pool: SqlitePool,
) {
    let user = common::create_test_user(&pool, "transport-owner").await;
    let layer = common::master_layer_id(&pool, &user).await;
    let free = "自由</ScRiPt>&\u{2028}\u{2029}漢字𠮷🙂e\u{301}\r\n".repeat(12);
    let answer_a = "**回答A🙂**\n".repeat(12);
    let answer_b = "**回答B𠮷**\n".repeat(12);
    let at = chrono::NaiveDate::from_ymd_opt(2026, 10, 1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap();
    for kind in ["marker", "shape"] {
        for index in 0..5u128 {
            let target = Uuid::from_u128(300_000 + index);
            let ids = [
                Uuid::from_u128(400_000 + index * 2),
                Uuid::from_u128(400_001 + index * 2),
            ];
            let (body, answers, parts) = match index {
                0 => (
                    format!("{free}{answer_a}{answer_b}"),
                    [answer_a.as_str(), answer_b.as_str()],
                    Some(json!([
                        {"type":"text","text":free},{"type":"answer","id":ids[0]},{"type":"answer","id":ids[1]}
                    ])),
                ),
                // Ambiguous legacy text still has sync_required=true. Exact
                // normal == managed is enough for transport, not for adopting parts.
                1 => (
                    format!("{answer_a}{answer_a}"),
                    [answer_a.as_str(), answer_a.as_str()],
                    None,
                ),
                2 => (
                    format!("{free}{answer_b}middle{answer_a}"),
                    [answer_a.as_str(), answer_b.as_str()],
                    Some(json!([
                        {"type":"text","text":free},{"type":"answer","id":ids[1]},
                        {"type":"text","text":"middle"},{"type":"answer","id":ids[0]}
                    ])),
                ),
                3 => (
                    "ab".into(),
                    ["a", "b"],
                    Some(json!([
                        {"type":"answer","id":ids[0]},{"type":"answer","id":ids[1]}
                    ])),
                ),
                _ => (
                    format!("{answer_a}{answer_a}{answer_a}"),
                    [answer_a.as_str(), answer_a.as_str()],
                    None,
                ),
            };
            if kind == "marker" {
                sqlx::query(
                    r#"
                    INSERT INTO marker_info_model (
                        id,
                        user_id,
                        layer_id,
                        marker_name,
                        latitude,
                        longitude,
                        detail,
                        create_at,
                        update_at,
                        form_body_parts
                    ) VALUES (
                        $1,
                        $2,
                        $3,
                        'transport',
                        35,
                        139,
                        $4,
                        CURRENT_TIMESTAMP,
                        CURRENT_TIMESTAMP,
                        $5
                    )
                    "#,
                )
                .bind(target.to_string())
                .bind(user.to_string())
                .bind(layer.to_string())
                .bind(&body)
                .bind(&parts)
                .execute(&pool)
                .await
                .unwrap();
            } else {
                sqlx::query(
                    r#"
                    INSERT INTO shape_model (
                        id,
                        user_id,
                        layer_id,
                        shape_type,
                        name,
                        geojson,
                        created_at,
                        updated_at,
                        form_body_parts
                    ) VALUES (
                        $1,
                        $2,
                        $3,
                        'polyline',
                        'transport',
                        $4,
                        CURRENT_TIMESTAMP,
                        CURRENT_TIMESTAMP,
                        $5
                    )
                    "#,
                )
                    .bind(target.to_string()).bind(user.to_string()).bind(layer.to_string()).bind(json!({"type":"Feature","properties":{"memo":body,"normalBodyReferences":{"version":"user data"}},"geometry":{"type":"LineString","coordinates":[[139,35],[140,36]]}}))
                    .bind(&parts).execute(&pool).await.unwrap();
            }
            for i in 0..2 {
                sqlx::query(&format!(
                    r#"
                    INSERT INTO {kind}_form_submission_model (
                        id,
                        {kind}_id,
                        create_at,
                        submitted_values,
                        rendered_markdown
                    ) VALUES ($1, $2, $3, $4, $5)
                    "#,
                ))
                .bind(ids[i].to_string())
                .bind(target.to_string())
                .bind(at + Duration::seconds(i as i64))
                .bind(json!({"n":i}))
                .bind(answers[i])
                .execute(&pool)
                .await
                .unwrap();
            }
        }
    }
    let q = query(json!({"limit":1,"as_of":"2026-10-02T00:00:00Z"}));
    let canonical = load_answer_map(&pool, &user.to_string(), &q).await.unwrap();
    assert_eq!((canonical.answer_count, canonical.target_count), (20, 10));
    let expected_markers: Value = canonical
        .markers
        .iter()
        .map(|m| (m.id.to_string(), json!(m)))
        .collect::<serde_json::Map<_, _>>()
        .into();
    let expected_shapes = json!(canonical.shapes);
    let expected_popups = json!(canonical.popup_bodies);
    let mut templates = geocode_web_single::build_tera_from_embed().unwrap();
    templates
        .add_raw_template(
            "form-answer-map.html",
            include_str!("../src/templates/form-answer-map.html"),
        )
        .unwrap();
    let response = answer_map_handler(
        Extension(user.to_string()),
        Extension(pool),
        Extension(std::sync::Arc::new(tokio::sync::Mutex::new(templates))),
        Form(AnswerMapRequest {
            analysis: None,
            initial_view: None,
            query: serde_json::to_string(&q).unwrap(),
            parent_origin: "http://localhost:5173".into(),
            request_id: "transport".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    let html = String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let content = html
        .split_once(r#"id="geocode-map-bootstrap""#)
        .unwrap()
        .1
        .split_once('>')
        .unwrap()
        .1;
    let raw = content.split_once("</script>").unwrap().0;
    assert!(!raw.contains('<') && !raw.contains('&'));
    assert!(!raw.contains('\u{2028}') && !raw.contains('\u{2029}'));
    let mut restored: Value = serde_json::from_str(raw).unwrap();
    let refs = restored
        .as_object_mut()
        .unwrap()
        .remove("normalBodyReferences")
        .unwrap();
    let expected_ids = [
        Uuid::from_u128(300_000).to_string(),
        Uuid::from_u128(300_001).to_string(),
    ];
    assert_eq!(
        refs,
        json!({"version":1,"markers":expected_ids,"shapes":expected_ids})
    );
    assert_eq!(restored["popupBodies"], expected_popups);
    for kind in ["marker", "shape"] {
        assert_eq!(
            restored["popupBodies"][format!("{kind}:{}", expected_ids[1])]["sync_required"],
            true
        );
        for id in refs[format!("{kind}s")].as_array().unwrap() {
            let id = id.as_str().unwrap();
            let popup = &restored["popupBodies"][format!("{kind}:{id}")];
            let normal = format!(
                "{}{}",
                popup["free_text"].as_str().unwrap(),
                popup["managed_markdown"].as_str().unwrap()
            );
            if kind == "marker" {
                assert!(restored["markers"][id].get("detail").is_none());
                restored["markers"][id]["detail"] = json!(normal);
            } else {
                let shape = restored["shapes"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|s| s["id"] == id)
                    .unwrap();
                assert!(shape["geojson"]["properties"].get("memo").is_none());
                shape["geojson"]["properties"]["memo"] = json!(normal);
            }
        }
    }
    assert_eq!(restored["markers"], expected_markers);
    assert_eq!(restored["shapes"], expected_shapes);
    assert_eq!(restored["answerPreview"]["answerCount"], 20);
    assert_eq!(restored["answerPreview"]["targetCount"], 10);
}

async fn insert_popup_case(
    pool: &SqlitePool,
    user: Uuid,
    layer: Uuid,
    kind: &str,
    target: Uuid,
    case: &PopupCase,
    offsets: &[i64],
    values: &[i64],
) -> Vec<Uuid> {
    let ids: Vec<_> = (0..case.markdown.len())
        .map(|i| Uuid::from_u128(target.as_u128() * 16 + i as u128 + 1))
        .collect();
    let stored = case.stored_parts(&ids);
    if kind == "marker" {
        sqlx::query(
            r#"
            INSERT INTO marker_info_model (
                id,
                user_id,
                layer_id,
                marker_name,
                latitude,
                longitude,
                detail,
                create_at,
                update_at,
                form_body_parts
            ) VALUES (
                $1,
                $2,
                $3,
                'popup',
                35,
                139,
                $4,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP,
                $5
            )
            "#,
        )
        .bind(target.to_string())
        .bind(user.to_string())
        .bind(layer.to_string())
        .bind(case.body)
        .bind(stored)
        .execute(pool)
        .await
        .unwrap();
    } else {
        sqlx::query(
            r#"
            INSERT INTO shape_model (
                id,
                user_id,
                layer_id,
                shape_type,
                name,
                geojson,
                created_at,
                updated_at,
                form_body_parts
            ) VALUES (
                $1,
                $2,
                $3,
                'polyline',
                'popup',
                $4,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP,
                $5
            )
            "#,
        )
            .bind(target.to_string()).bind(user.to_string()).bind(layer.to_string()).bind(json!({"type":"Feature","properties":{"memo":case.body},"geometry":{"type":"LineString","coordinates":[[139,35],[140,36]]}})).bind(stored).execute(pool).await.unwrap();
    }
    let base = chrono::NaiveDate::from_ymd_opt(2026, 10, 1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap();
    // Reverse insertion makes equal-time order depend on the answer ID, not insertion.
    for i in (0..ids.len()).rev() {
        let snapshot = (!case.name.starts_with("legacy")).then(|| {
            json!({
                "form_schema":{"fields":[{"id":"n","label":"n","type":"number"}]},
                "unused_snapshot_metadata":"snapshot🗾".repeat(256)
            })
        });
        sqlx::query(&format!(
            r#"
            INSERT INTO {kind}_form_submission_model (
                id,
                {kind}_id,
                create_at,
                submitted_values,
                rendered_markdown,
                form_snapshot,
                revision,
                edited_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
        ))
        .bind(ids[i].to_string())
        .bind(target.to_string())
        .bind(base + Duration::seconds(offsets[i]))
        .bind(json!({"n":values[i],"unused_payload":"使わない値".repeat(512)}))
        .bind(case.markdown[i])
        .bind(snapshot)
        .bind(i as i64 + 2)
        .bind(base + Duration::days(5))
        .execute(pool)
        .await
        .unwrap();
    }
    ids
}

async fn popup_body_response(
    app: &axum::Router,
    user: Uuid,
    kind: &str,
    target: Uuid,
) -> axum::response::Response {
    use tower::ServiceExt;
    app.clone()
        .oneshot(
            axum::http::Request::builder()
                .uri(format!("/{kind}/{target}/form/body"))
                .header(
                    "cookie",
                    format!(
                        "access_token={}",
                        geocode_web_single::auth::create_token(
                            &user.to_string(),
                            30,
                            "access_token",
                            0
                        )
                        .unwrap()
                    ),
                )
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn full_answer_popup_reference(
    app: &axum::Router,
    user: Uuid,
    kind: &str,
    target: Uuid,
) -> Value {
    let response = popup_body_response(app, user, kind, target).await;
    assert!(response.status().is_success());
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    // This existing endpoint still reads full Answer rows; no lightweight popup DTO.
    json!({"free_text":body["free_text"],"managed_markdown":body["managed_markdown"],"sync_required":body["sync_required"]})
}

#[tokio::test]
async fn popup_projection_matches_full_answer_body_for_stored_legacy_empty_and_unicode() {
    let pool = common::test_pool().await;
    let user = test_user(&pool, "popup-matrix").await;
    let other = test_user(&pool, "popup-other").await;
    let layer = test_layer(&pool, &user).await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let cases = popup_projection_cases::cases();
    let mut expected_keys = std::collections::BTreeSet::new();
    for kind in ["marker", "shape"] {
        for (index, case) in cases.iter().enumerate() {
            let target = Uuid::from_u128(10_000 + index as u128);
            let ids = insert_popup_case(
                &pool,
                user,
                layer,
                kind,
                target,
                case,
                &vec![0; case.markdown.len()],
                &(0..case.markdown.len())
                    .map(|i| if i == 0 { 1 } else { 2 })
                    .collect::<Vec<_>>(),
            )
            .await;
            let legacy = case.name.starts_with("legacy");
            let q = query(
                json!({"target_type":kind,"target_id":target,"as_of":"2026-10-02T00:00:00Z","limit":1,
                "conditions":[{"field_id":"n","field_type":if legacy {"unknown"}else{"number"},"op":if legacy {"contains"}else{"eq"},"value":"1"}]}),
            );
            let data = load_answer_map(&pool, &user.to_string(), &q).await.unwrap();
            assert_eq!(
                (data.answer_count, data.target_count),
                (1, 1),
                "{kind}: {}",
                case.name
            );
            let key = format!("{kind}:{target}");
            assert_eq!(
                data.popup_bodies[&key],
                full_answer_popup_reference(&app, user, kind, target).await,
                "{kind}: {}",
                case.name
            );
            assert_eq!(
                data.popup_bodies[&key],
                case.expected(),
                "{kind}: {}",
                case.name
            );
            let table = if kind == "marker" {
                "marker_info_model"
            } else {
                "shape_model"
            };
            let body_column = if kind == "marker" {
                "detail"
            } else {
                "geojson->'properties'->>'memo'"
            };
            let stored: (String, Option<Value>) = sqlx::query_as(&format!(
                r#"
                SELECT
                    {body_column},
                    form_body_parts
                FROM {table}
                WHERE id = $1
                "#
            ))
            .bind(target.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                stored,
                (case.body.to_owned(), case.stored_parts(&ids)),
                "Read projections must not persist adoption"
            );
            expected_keys.insert(key);
        }
    }
    let all = load_answer_map(&pool, &user.to_string(), &query(json!({"limit":1})))
        .await
        .unwrap();
    assert_eq!(
        all.popup_bodies
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        expected_keys
    );
    assert_eq!(all.target_count, cases.len() as i64 * 2);
    for kind in ["marker", "shape"] {
        let target = Uuid::from_u128(10_000);
        assert_eq!(
            popup_body_response(&app, other, kind, target)
                .await
                .status(),
            axum::http::StatusCode::NOT_FOUND
        );
        assert!(
            load_answer_map(
                &pool,
                &other.to_string(),
                &query(json!({"target_type":kind,"target_id":target}))
            )
            .await
            .is_err()
        );
    }
}

#[tokio::test]
async fn popup_projection_keeps_answers_outside_search_and_as_of_in_time_id_order() {
    let pool = common::test_pool().await;
    let user = test_user(&pool, "popup-cutoff").await;
    let layer = test_layer(&pool, &user).await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let case = PopupCase::new(
        "stored cutoff",
        vec!["過去一致A\n", "未来一致B\n", "過去不一致C\n"],
        "前未来一致B\n過去一致A\n過去不一致C\n後",
        Some(
            json!([{"type":"text","text":"前"},{"type":"answer","id":1},{"type":"answer","id":0},{"type":"answer","id":2},{"type":"text","text":"後"}]),
        ),
        "前後",
        false,
    );
    let expected = json!({"free_text":"前後","managed_markdown":"過去一致A\n過去不一致C\n未来一致B\n","sync_required":false});
    for kind in ["marker", "shape"] {
        let target = Uuid::from_u128(90_000);
        insert_popup_case(
            &pool,
            user,
            layer,
            kind,
            target,
            &case,
            &[0, 172800, 1],
            &[1, 1, 2],
        )
        .await;
        let reference = full_answer_popup_reference(&app, user, kind, target).await;
        assert_eq!(reference, expected);
        for (mode, value) in [("history", 1), ("latest", 2)] {
            let q = query(
                json!({"mode":mode,"target_type":kind,"target_id":target,"as_of":"2026-10-02T00:00:00Z","limit":1,
                "conditions":[{"field_id":"n","field_type":"number","op":"eq","value":value}]}),
            );
            let data = load_answer_map(&pool, &user.to_string(), &q).await.unwrap();
            assert_eq!((data.answer_count, data.target_count), (1, 1));
            assert_eq!(data.popup_bodies[&format!("{kind}:{target}")], reference);
        }
    }
}

#[tokio::test]
async fn matches_all_pages_deduplicates_and_preserves_owner_and_latest_rules() {
    let pool = common::test_pool().await;
    let owner = test_user(&pool, "map-owner").await;
    let other = test_user(&pool, "map-other").await;
    let layer = test_layer(&pool, &owner).await;
    let other_layer = test_layer(&pool, &other).await;
    let ids = [
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    ];
    for (id, user, group, name) in [
        (ids[0], owner, layer, "該当A"),
        (ids[1], owner, layer, "該当B"),
        (ids[2], owner, layer, "回答なし"),
        (ids[3], other, other_layer, "他人の対象"),
    ] {
        sqlx::query(
            r#"
            INSERT INTO marker_info_model (
                id,
                user_id,
                layer_id,
                marker_name,
                latitude,
                longitude,
                detail,
                create_at,
                update_at
            ) VALUES (
                $1,
                $2,
                $3,
                $4,
                35,
                139,
                '',
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            )
            "#,
        )
        .bind(id.to_string())
        .bind(user.to_string())
        .bind(group.to_string())
        .bind(name)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query(
        r#"
        INSERT INTO shape_model (
            id,
            user_id,
            layer_id,
            shape_type,
            name,
            geojson,
            created_at,
            updated_at
        ) VALUES (
            $1,
            $2,
            $3,
            'polyline',
            '該当図形',
            $4,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    ).bind(ids[0].to_string()).bind(owner.to_string()).bind(layer.to_string()).bind(json!({"type":"Feature","properties":{},"geometry":{"type":"LineString","coordinates":[[139,35],[140,36]]}})).execute(&pool).await.unwrap();
    let form = Uuid::new_v4();
    let at = (Utc::now() - Duration::days(1)).naive_utc();
    for (kind, target, n, offset) in [
        ("marker", ids[0], 1, 0),
        ("marker", ids[0], 9, 2),
        ("marker", ids[1], 1, 0),
        ("shape", ids[0], 1, 0),
        ("marker", ids[3], 1, 0),
    ] {
        sqlx::query(&format!(
            r#"
            INSERT INTO {kind}_form_submission_model (
                id,
                {kind}_id,
                create_at,
                submitted_values,
                rendered_markdown,
                source_form,
                form_snapshot
            ) VALUES ($1, $2, $3, $4, '', $5, $6)
            "#,
        ))
            .bind(Uuid::new_v4().to_string()).bind(target.to_string()).bind(at+Duration::seconds(offset)).bind(json!({"n":n})).bind(json!({"id":form,"version":1})).bind(json!({"form_title":"記録","form_schema":{"fields":[{"id":"n","label":"数値","type":"number"}]}})).execute(&pool).await.unwrap();
    }
    let base = json!({"common_form_id":form,"limit":1,"conditions":[{"field_id":"n","field_type":"number","op":"eq","value":"1"}]});
    let data = load_answer_map(&pool, &owner.to_string(), &query(base.clone()))
        .await
        .unwrap();
    assert_eq!(
        (
            data.answer_count,
            data.target_count,
            data.markers.len(),
            data.shapes.len()
        ),
        (3, 3, 2, 1)
    );
    assert_eq!(data.layers.len(), 1);
    let all = load_answer_map(&pool, &owner.to_string(), &query(json!({"limit":1})))
        .await
        .unwrap();
    assert_eq!((all.answer_count, all.target_count), (4, 3));
    let page = search_answers_handler(
        Extension(owner.to_string()),
        Extension(pool.clone()),
        Json(query(json!({"limit":1}))),
    )
    .await
    .unwrap()
    .0;
    assert_eq!((page.total, page.target_count, page.rows.len()), (4, 3, 1));
    let mut latest = base.clone();
    latest["mode"] = json!("latest");
    let data = load_answer_map(&pool, &owner.to_string(), &query(latest.clone()))
        .await
        .unwrap();
    assert_eq!((data.answer_count, data.target_count), (2, 2));
    assert_eq!(data.markers[0].id, ids[1].to_string());
    latest["as_of"] = json!((at + Duration::seconds(1)).and_utc());
    assert_eq!(
        load_answer_map(&pool, &owner.to_string(), &query(latest))
            .await
            .unwrap()
            .target_count,
        3
    );
    assert!(
        load_answer_map(
            &pool,
            &other.to_string(),
            &query(json!({"target_id":ids[0],"target_type":"marker"}))
        )
        .await
        .is_err()
    );
    let templates = geocode_web_single::build_tera_extension().unwrap();
    let response = answer_map_handler(
        Extension(owner.to_string()),
        Extension(pool.clone()),
        Extension(templates.clone()),
        Form(AnswerMapRequest {
            analysis: None,
            initial_view: None,
            query: base.to_string(),
            parent_origin: "http://localhost:5173".into(),
            request_id: "test-map".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let html = String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(html.contains("answerPreview"));
    assert!(html.contains("該当A"));
    assert!(!html.contains("他人の対象"));
    assert!(!html.contains("回答なし"));
    let normal = geocode_web_single::handler::map::map_another_get_handler(
        Extension(owner.to_string()),
        Extension(pool.clone()),
        Extension(templates.clone()),
        axum::extract::Query(geocode_web_single::model::MapAnotherWindowQueryParams {
            is_cluster: Some(true),
        }),
    )
    .await
    .unwrap();
    use axum::response::IntoResponse;
    let normal = String::from_utf8(
        to_bytes(normal.into_response().into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(!normal.contains("answerPreview:"));
    sqlx::query(
        r#"
        UPDATE marker_info_model
        SET
            latitude = 999
        WHERE id = $1
        "#,
    )
    .bind(ids[0].to_string())
    .execute(&pool)
    .await
    .unwrap();
    let invalid_position = answer_map_handler(
        Extension(owner.to_string()),
        Extension(pool.clone()),
        Extension(templates.clone()),
        Form(AnswerMapRequest {
            analysis: None,
            initial_view: None,
            query: json!({"target_id":ids[0],"target_type":"marker"}).to_string(),
            parent_origin: "http://localhost:5173".into(),
            request_id: "invalid-position".into(),
        }),
    )
    .await
    .unwrap();
    let html = String::from_utf8(
        to_bytes(invalid_position.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(html.contains("\"targetCount\":1"));
    assert!(!html.contains("該当A"));
    let response = answer_map_handler(
        Extension(owner.to_string()),
        Extension(pool),
        Extension(templates),
        Form(AnswerMapRequest {
            analysis: None,
            initial_view: None,
            query: json!({"target_name":"該当しない"}).to_string(),
            parent_origin: "http://localhost:5173".into(),
            request_id: "error-map".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 400);
    let html = String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(html.contains("地図に表示する対象がありません"));
    assert!(html.contains("answer-map-error"));
}

async fn test_user(pool: &SqlitePool, name: &str) -> Uuid {
    common::create_test_user(pool, name).await.parse().unwrap()
}
async fn test_layer(pool: &SqlitePool, user: &Uuid) -> Uuid {
    common::master_layer_id(pool, &user.to_string())
        .await
        .parse()
        .unwrap()
}

#[tokio::test]
async fn twenty_thousand_targets_support_map_and_filter_without_truncation() {
    let pool = common::test_pool().await;
    let user = test_user(&pool, "map-limits").await;
    let layer = test_layer(&pool, &user).await;
    sqlx::query(
        r#"
        WITH RECURSIVE
            n (i) AS (
                SELECT
                    1
                UNION ALL
                SELECT
                    i + 1
                FROM n
                WHERE i < 20000
            )
        INSERT INTO marker_info_model (
            id,
            user_id,
            layer_id,
            marker_name,
            latitude,
            longitude,
            detail,
            create_at,
            update_at
        )
        SELECT
            '00000000-0000-4000-8000-' || printf('%012x', i),
            $1,
            $2,
            '対象' || i,
            35,
            139,
            '',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        FROM n
        "#,
    )
    .bind(user.to_string())
    .bind(layer.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let form = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        WITH RECURSIVE
            n (i) AS (
                SELECT
                    1
                UNION ALL
                SELECT
                    i + 1
                FROM n
                WHERE i < 20000
            )
        INSERT INTO marker_form_submission_model (
            id,
            marker_id,
            create_at,
            submitted_values,
            rendered_markdown,
            source_form,
            form_snapshot
        )
        SELECT
            '00000000-0000-4000-8000-' || printf('%012x', i),
            '00000000-0000-4000-8000-' || printf('%012x', i),
            '2026-01-01 00:00:00',
            json_object('n', i),
            '',
            json_object('id', $1, 'version', 1),
            '{"form_schema":{"fields":[{"id":"n","label":"番号","type":"number"}]}}'
        FROM n
        "#,
    )
    .bind(&form)
    .execute(&pool)
    .await
    .unwrap();
    let owner = user.to_string();
    let q = query(json!({"limit":1,"as_of":"2026-10-28T00:00:00Z"}));
    let data = load_answer_map(&pool, &owner, &q).await.unwrap();
    assert_eq!(data.answer_count, 20_000);
    assert_eq!(data.target_count, 20_000);
    assert_eq!(data.markers.len(), 20_000);
    assert_eq!(data.popup_bodies.len(), 20_000);
    let expected: std::collections::BTreeSet<_> = (1..=20_000)
        .map(|i| format!("marker:00000000-0000-4000-8000-{i:012x}"))
        .collect();
    assert_eq!(
        data.markers
            .iter()
            .map(|m| format!("marker:{}", m.id))
            .collect::<std::collections::BTreeSet<_>>(),
        expected
    );
    let mut request = geocode_web_single::handler::answer_map_filter::MapFilterRequest {
        query: q,
        targets: expected.iter().cloned().collect(),
        common_form_id: Some(form),
        conditions: vec![],
        options_only: false,
    };
    let filtered =
        geocode_web_single::handler::answer_map_filter::filter_targets(&pool, &owner, &request)
            .await
            .unwrap();
    assert_eq!(filtered.answer_count, 20_000);
    assert_eq!(filtered.target_count, 20_000);
    assert_eq!(
        filtered
            .targets
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
        expected
    );
    let csv_request = serde_json::from_value(serde_json::to_value(&request).unwrap()).unwrap();
    let error = geocode_web_single::handler::answer_map_csv::check_handler(
        Extension(owner.clone()),
        Extension(pool.clone()),
        Json(csv_request),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("CSVは10,000回答"), "{error:?}");
    request.conditions = serde_json::from_value(json!([
        {"field_id":"n","field_type":"number","op":"gte","value":10001}
    ]))
    .unwrap();
    let filtered =
        geocode_web_single::handler::answer_map_filter::filter_targets(&pool, &owner, &request)
            .await
            .unwrap();
    assert_eq!(filtered.answer_count, 10_000);
    assert_eq!(filtered.target_count, 10_000);
    assert_eq!(
        filtered
            .targets
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
        (10_001..=20_000)
            .map(|i| format!("marker:00000000-0000-4000-8000-{i:012x}"))
            .collect()
    );
}

#[tokio::test]
async fn popup_snapshots_separate_all_answers_and_keep_ambiguous_legacy_read_only() {
    let pool = common::test_pool().await;
    let owner = common::create_test_user(&pool, "popup-owner").await;
    let other = common::create_test_user(&pool, "popup-other").await;
    let layer = common::master_layer_id(&pool, &owner).await;
    let other_layer = common::master_layer_id(&pool, &other).await;
    let id = Uuid::new_v4();
    let foreign = Uuid::new_v4();
    for (target, user, group) in [
        (id, owner.clone(), layer.clone()),
        (foreign, other, other_layer),
    ] {
        sqlx::query(
            r#"
            INSERT INTO marker_info_model (
                id,
                user_id,
                layer_id,
                marker_name,
                latitude,
                longitude,
                detail,
                create_at,
                update_at
            ) VALUES (
                $1,
                $2,
                $3,
                '対象',
                35,
                139,
                '自由
回答A
回答B
',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                )
            "#,
        )
        .bind(target.to_string())
        .bind(user.to_string())
        .bind(group.to_string())
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query(
        r#"
        INSERT INTO shape_model (
            id,
            user_id,
            layer_id,
            shape_type,
            name,
            geojson,
            created_at,
            updated_at
        ) VALUES (
            $1,
            $2,
            $3,
            'polyline',
            '図形',
            $4,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
        .bind(id.to_string()).bind(owner.to_string()).bind(layer.to_string()).bind(json!({"type":"Feature","properties":{"memo":"同じ回答\n同じ回答\n"},"geometry":{"type":"LineString","coordinates":[[139,35],[140,36]]}})).execute(&pool).await.unwrap();
    let at = (Utc::now() - Duration::days(1)).naive_utc();
    for (kind, target, markdown, n) in [
        ("marker", id, "回答A\n", 1),
        ("marker", id, "回答B\n", 2),
        ("shape", id, "同じ回答\n", 1),
        ("marker", foreign, "他人の秘密", 1),
    ] {
        sqlx::query(&format!(
            r#"
            INSERT INTO {kind}_form_submission_model (
                id,
                {kind}_id,
                create_at,
                submitted_values,
                rendered_markdown
            ) VALUES ($1, $2, $3, $4, $5)
            "#,
        ))
        .bind(Uuid::new_v4().to_string())
        .bind(target.to_string())
        .bind(at + Duration::seconds(n))
        .bind(json!({"n":n}))
        .bind(markdown)
        .execute(&pool)
        .await
        .unwrap();
    }
    let q = query(
        json!({"target_type":"marker","target_id":id,"conditions":[{"field_id":"n","field_type":"unknown","op":"contains","value":"1"}]}),
    );
    let data = load_answer_map(&pool, &owner, &q).await.unwrap();
    let body = &data.popup_bodies[&format!("marker:{id}")];
    assert_eq!(data.answer_count, 1);
    assert_eq!(body["free_text"], "自由\n");
    assert_eq!(body["managed_markdown"], "回答A\n回答B\n");
    assert_eq!(body["sync_required"], false);
    assert!(!data.popup_bodies.contains_key(&format!("marker:{foreign}")));
    let data = load_answer_map(&pool, &owner, &query(json!({})))
        .await
        .unwrap();
    assert_eq!(
        data.popup_bodies[&format!("shape:{id}")]["sync_required"],
        true
    );
    assert_eq!(data.popup_bodies[&format!("shape:{id}")]["free_text"], "");
    // Display projection reads do not adopt/persist old records or rewrite their bodies.
    let row: (String, bool) = sqlx::query_as(
        r#"
        SELECT
            detail,
            form_body_parts IS NULL
        FROM marker_info_model
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row, ("自由\n回答A\n回答B\n".into(), true));
}

#[test]
fn accepts_requests_without_an_initial_map_view() {
    let request: AnswerMapRequest = serde_json::from_value(json!({
        "query": "{}",
        "parent_origin": "http://localhost:5173",
        "request_id": "legacy-request"
    }))
    .unwrap();
    assert!(request.initial_view.is_none());
}

#[tokio::test]
async fn passes_valid_initial_views_to_the_map_without_changing_answer_targets() {
    let pool = common::test_pool().await;
    let owner = common::create_test_user(&pool, "initial-view-owner").await;
    let layer = common::master_layer_id(&pool, &owner).await;
    let marker = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO marker_info_model (
            id,
            user_id,
            layer_id,
            marker_name,
            latitude,
            longitude,
            detail,
            create_at,
            update_at
        ) VALUES (
            $1,
            $2,
            $3,
            '表示位置確認',
            35,
            139,
            '',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .bind(&marker)
    .bind(&owner)
    .bind(&layer)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO marker_form_submission_model (
            id,
            marker_id,
            create_at,
            submitted_values,
            rendered_markdown
        ) VALUES ($1, $2, $3, '{}', '')
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&marker)
    .bind((Utc::now() - Duration::days(1)).naive_utc())
    .execute(&pool)
    .await
    .unwrap();
    let templates = geocode_web_single::build_tera_extension().unwrap();
    let query = json!({"target_type":"marker","target_id":marker,"as_of":Utc::now()}).to_string();
    let valid = json!({"latitude": 35.6812, "longitude": 139.7671, "zoom": 14.5});
    let mut baseline: Option<Value> = None;
    for (initial_view, expected_view) in [
        (None, None),
        (Some(valid.to_string()), Some(valid)),
        (Some(String::new()), None),
        (Some("not-json".into()), None),
        (
            Some(json!({"latitude":91,"longitude":139,"zoom":14}).to_string()),
            None,
        ),
        (
            Some(json!({"latitude":35,"longitude":181,"zoom":14}).to_string()),
            None,
        ),
        (
            Some(json!({"latitude":35,"longitude":139,"zoom":31}).to_string()),
            None,
        ),
        (
            Some(json!({"latitude":"35","longitude":139,"zoom":14}).to_string()),
            None,
        ),
        (
            Some(json!({"latitude":35,"longitude":139}).to_string()),
            None,
        ),
    ] {
        let response = answer_map_handler(
            Extension(owner.clone()),
            Extension(pool.clone()),
            Extension(templates.clone()),
            Form(AnswerMapRequest {
                analysis: None,
                initial_view,
                query: query.clone(),
                parent_origin: "http://localhost:5173".into(),
                request_id: "view-contract".into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let html = String::from_utf8(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        let raw = html
            .split_once(r#"id="geocode-map-bootstrap""#)
            .and_then(|(_, tail)| tail.split_once('>'))
            .and_then(|(_, tail)| tail.split_once("</script>"))
            .map(|(json, _)| json)
            .expect("JSON bootstrap should be present");
        let mut bootstrap: Value = serde_json::from_str(raw).unwrap();
        let mut preview = bootstrap["answerPreview"].take();
        assert_eq!(
            preview.as_object_mut().unwrap().remove("initialView"),
            expected_view
        );
        assert_eq!(preview["answerCount"], 1);
        assert_eq!(preview["targetCount"], 1);
        assert_eq!(preview["targets"], json!([format!("marker:{marker}")]));
        assert_eq!(preview["query"]["target_id"], marker);
        if let Some(baseline) = &baseline {
            assert_eq!(
                &preview, baseline,
                "initial view must not change search data or message metadata"
            );
        } else {
            baseline = Some(preview);
        }
    }
}
