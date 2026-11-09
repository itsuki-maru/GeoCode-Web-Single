#[allow(dead_code)]
mod common;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tower::ServiceExt;
use uuid::Uuid;

fn cookie(user: Uuid) -> String {
    format!(
        "access_token={}",
        geocode_web_single::auth::create_token(&user.to_string(), 30, "access_token", 0).unwrap()
    )
}

async fn raw(
    app: &Router,
    user: Option<Uuid>,
    method: &str,
    path: &str,
    content_type: &str,
    data: Vec<u8>,
) -> (StatusCode, Vec<u8>, bool) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", content_type);
    if let Some(user) = user {
        request = request.header("cookie", cookie(user));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(data)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let no_store = response
        .headers()
        .get("cache-control")
        .is_some_and(|v| v == "no-store");
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    (status, bytes, no_store)
}

async fn call(
    app: &Router,
    user: Option<Uuid>,
    method: &str,
    path: &str,
    data: Value,
) -> (StatusCode, Value) {
    let (status, bytes, _) = raw(
        app,
        user,
        method,
        path,
        "application/json",
        data.to_string().into_bytes(),
    )
    .await;
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
    )
}

async fn ok(app: &Router, user: Uuid, method: &str, path: &str, data: Value) -> Value {
    let (status, value) = call(app, Some(user), method, path, data).await;
    assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
    value
}

async fn fixture(pool: &SqlitePool, name: &str) -> (Router, Uuid, Uuid) {
    let user = Uuid::parse_str(&common::create_test_user(pool, name).await).unwrap();
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let layer = ok(&app, user, "POST", "/layer?name=delete-test", Value::Null).await;
    (
        app,
        user,
        Uuid::parse_str(layer["id"].as_str().unwrap()).unwrap(),
    )
}

async fn object(app: &Router, user: Uuid, layer: Uuid, kind: &str, image: bool) -> Uuid {
    let created = if kind == "marker" {
        ok(
            app,
            user,
            "POST",
            &format!("/marker?layer_id={layer}&latitude=35&longitude=139"),
            Value::Null,
        )
        .await
    } else {
        ok(app, user, "POST", "/shape", json!({"layer_id":layer,"shape_type":"polyline","name":"管路A","geojson":{"type":"Feature","properties":{"memo":"自由記述\n","style":{"weight":4,"color":"#123456"}},"geometry":{"type":"LineString","coordinates":[[139,35],[140,36]]}}})).await
    };
    let id = Uuid::parse_str(created["id"].as_str().unwrap()).unwrap();
    if kind == "marker" {
        ok(
            app,
            user,
            "PUT",
            &format!("/marker/update/{id}"),
            json!({"name":"施設A","detail":"自由記述\n","layer_id":layer}),
        )
        .await;
    }
    let mut fields = vec![json!({"id":"note","type":"text","label":"内容"})];
    if image {
        fields.push(json!({"id":"pic","type":"image","label":"写真"}));
    }
    ok(app, user, "PUT", &format!("/{kind}/{id}/form"), json!({"enabled":false,"form_title":"点検","form_description":"説明","form_schema":{"fields":fields},"password_mode":"keep"})).await;
    id
}

async fn submit(
    app: &Router,
    pool: &SqlitePool,
    user: Uuid,
    kind: &str,
    target: Uuid,
    text: &str,
    image: bool,
) -> Uuid {
    let input = ok(
        app,
        user,
        "GET",
        &format!("/{kind}/{target}/form/input"),
        Value::Null,
    )
    .await;
    let payload = json!({"config_token":input["config_token"],"values":{"note":text}});
    let mut data = format!(
        "--delete-test\r\nContent-Disposition: form-data; name=\"submission\"\r\n\r\n{payload}\r\n"
    )
    .into_bytes();
    if image {
        let mut output = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8, 8)
            .write_to(&mut output, image::ImageFormat::Png)
            .unwrap();
        data.extend(b"--delete-test\r\nContent-Disposition: form-data; name=\"image__pic\"; filename=\"delete-test.png\"\r\nContent-Type: image/png\r\n\r\n");
        data.extend(output.into_inner());
        data.extend(b"\r\n");
    }
    data.extend(b"--delete-test--\r\n");
    let (status, bytes, _) = raw(
        app,
        Some(user),
        "POST",
        &format!("/{kind}/{target}/form/submissions"),
        "multipart/form-data; boundary=delete-test",
        data,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    let saved: String = sqlx::query_scalar(&format!(
        r#"
        SELECT id
        FROM {kind}_form_submission_model
        WHERE {kind}_id = $1
        ORDER BY create_at DESC, id DESC
        LIMIT 1
        "#
    ))
    .bind(target.to_string())
    .fetch_one(pool)
    .await
    .unwrap();
    Uuid::parse_str(&saved).unwrap()
}

async fn stored(pool: &SqlitePool, kind: &str, target: Uuid) -> Value {
    // SQLiteの保存値をJSONへまとめ、更新対象以外の列も前後で比較する。
    let query = if kind == "marker" {
        r#"
        SELECT json_object(
            'id', id, 'user_id', user_id, 'layer_id', layer_id,
            'marker_name', marker_name, 'latitude', latitude, 'longitude', longitude,
            'detail', detail, 'update_at', update_at,
            'form_body_parts', json(form_body_parts)
        )
        FROM marker_info_model
        WHERE id = $1
        "#
    } else {
        r#"
        SELECT json_object(
            'id', id, 'user_id', user_id, 'layer_id', layer_id,
            'shape_type', shape_type, 'name', name, 'geojson', json(geojson),
            'created_at', created_at, 'updated_at', updated_at,
            'form_body_parts', json(form_body_parts)
        )
        FROM shape_model
        WHERE id = $1
        "#
    };
    sqlx::query_scalar(query)
        .bind(target.to_string())
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn count(pool: &SqlitePool, kind: &str, target: Uuid) -> i64 {
    sqlx::query_scalar(&format!(
        r#"
        SELECT count(*)
        FROM {kind}_form_submission_model
        WHERE {kind}_id = $1
        "#
    ))
    .bind(target.to_string())
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn body_info(app: &Router, user: Uuid, kind: &str, target: Uuid) -> Value {
    ok(
        app,
        user,
        "GET",
        &format!("/{kind}/{target}/form/body"),
        Value::Null,
    )
    .await
}

/// 所有者だけが登録を削除でき、自由記述・他の登録・対象情報・設定と出力を維持する。
#[tokio::test]
async fn delete_is_owner_only_and_preserves_objects_history_and_exports() {
    let pool = common::test_pool().await;
    let (app, user, layer) = fixture(&pool, "delete-owner").await;
    let other = Uuid::parse_str(&common::create_test_user(&pool, "delete-other").await).unwrap();
    for kind in ["marker", "shape"] {
        let target = object(&app, user, layer, kind, false).await;
        let first = submit(&app, &pool, user, kind, target, "same-content", false).await;
        let second = submit(&app, &pool, user, kind, target, "same-content", false).await;
        let latest = submit(
            &app,
            &pool,
            user,
            kind,
            target,
            "deleted-unique-content",
            false,
        )
        .await;
        let before = stored(&pool, kind, target).await;
        let config = ok(
            &app,
            user,
            "GET",
            &format!("/{kind}/{target}/form"),
            Value::Null,
        )
        .await;
        let path = format!("/form-answers/{kind}/{latest}");
        for (owner, status) in [
            (None, StatusCode::UNAUTHORIZED),
            (Some(other), StatusCode::NOT_FOUND),
        ] {
            assert_eq!(
                call(&app, owner, "DELETE", &path, json!({"revision":1}))
                    .await
                    .0,
                status
            );
        }
        assert_eq!(
            call(&app, Some(user), "DELETE", &path, json!({"revision":2}))
                .await
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(
                &app,
                Some(user),
                "DELETE",
                &format!("/form-answers/invalid/{latest}"),
                json!({"revision":1})
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(stored(&pool, kind, target).await, before);
        assert_eq!(count(&pool, kind, target).await, 3);
        let (status, bytes, no_store) = raw(
            &app,
            Some(user),
            "DELETE",
            &path,
            "application/json",
            br#"{"revision":1}"#.to_vec(),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        assert!(no_store);
        let result: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result["object"]["id"], json!(target));
        assert_eq!(count(&pool, kind, target).await, 2);
        let info = body_info(&app, user, kind, target).await;
        assert_eq!(info["sync_required"], false);
        assert!(
            !info["body"]
                .as_str()
                .unwrap()
                .contains("deleted-unique-content")
        );
        assert_eq!(info["free_text"], "自由記述\n");
        let after = stored(&pool, kind, target).await;
        for key in ["id", "user_id", "layer_id"] {
            assert_eq!(after[key], before[key]);
        }
        if kind == "shape" {
            assert_eq!(after["geojson"]["geometry"], before["geojson"]["geometry"]);
            assert_eq!(
                after["geojson"]["properties"]["style"],
                before["geojson"]["properties"]["style"]
            );
        } else {
            for key in ["marker_name", "latitude", "longitude"] {
                assert_eq!(after[key], before[key]);
            }
        }
        for mode in ["history", "latest"] {
            let page = ok(
                &app,
                user,
                "POST",
                "/form-answers/search",
                json!({"target_type":kind,"target_id":target,"mode":mode}),
            )
            .await;
            assert_eq!(page["deletion_supported"], true);
            assert_eq!(page["total"], if mode == "history" { 2 } else { 1 });
            if mode == "latest" {
                assert_eq!(page["rows"][0]["id"], json!(second));
            }
        }
        let (status, csv, _) = raw(
            &app,
            Some(user),
            "POST",
            "/form-answers/csv",
            "application/json",
            json!({"target_type":kind,"target_id":target})
                .to_string()
                .into_bytes(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            !String::from_utf8(csv)
                .unwrap()
                .contains("deleted-unique-content")
        );
        let exported = ok(
            &app,
            user,
            "GET",
            &format!("/file/export/{layer}"),
            Value::Null,
        )
        .await;
        assert!(!exported.to_string().contains("deleted-unique-content"));
        assert_eq!(
            call(&app, Some(user), "DELETE", &path, json!({"revision":1}))
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        for id in [first, second] {
            ok(
                &app,
                user,
                "DELETE",
                &format!("/form-answers/{kind}/{id}"),
                json!({"revision":1}),
            )
            .await;
        }
        let info = body_info(&app, user, kind, target).await;
        assert_eq!(info["body"], "自由記述\n");
        assert_eq!(info["sync_required"], false);
        assert_eq!(count(&pool, kind, target).await, 0);
        assert_eq!(
            ok(
                &app,
                user,
                "GET",
                &format!("/{kind}/{target}/form"),
                Value::Null
            )
            .await,
            config
        );
    }
}

/// 旧登録の曖昧な本文には確認を要求し、古い確認トークンによる削除を拒否する。
#[tokio::test]
async fn delete_missing_snapshot_and_ambiguous_body_requires_fresh_confirmation() {
    let pool = common::test_pool().await;
    let (app, user, layer) = fixture(&pool, "delete-legacy").await;
    for kind in ["marker", "shape"] {
        let target = object(&app, user, layer, kind, false).await;
        let first = submit(&app, &pool, user, kind, target, "duplicate", false).await;
        submit(&app, &pool, user, kind, target, "duplicate", false).await;
        sqlx::query(&format!(
            r#"
            UPDATE {kind}_form_submission_model
            SET form_snapshot = NULL
            WHERE id = $1
            "#
        ))
        .bind(first.to_string())
        .execute(&pool)
        .await
        .unwrap();
        let table = if kind == "marker" {
            "marker_info_model"
        } else {
            "shape_model"
        };
        sqlx::query(&format!(
            r#"
            UPDATE {table}
            SET form_body_parts = NULL
            WHERE id = $1
            "#
        ))
        .bind(target.to_string())
        .execute(&pool)
        .await
        .unwrap();
        let path = format!("/form-answers/{kind}/{first}");
        let info = body_info(&app, user, kind, target).await;
        assert_eq!(info["sync_required"], true);
        let before = stored(&pool, kind, target).await;
        assert_eq!(
            call(&app, Some(user), "DELETE", &path, json!({"revision":1}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(stored(&pool, kind, target).await, before);
        submit(
            &app,
            &pool,
            user,
            kind,
            target,
            "new-concurrent-answer",
            false,
        )
        .await;
        let payload = json!({"revision":1,"reconcile":{"free_text":"保持する自由記述\n","token":info["body_token"]}});
        assert_eq!(
            call(&app, Some(user), "DELETE", &path, payload).await.0,
            StatusCode::CONFLICT
        );
        assert_eq!(count(&pool, kind, target).await, 3);
        let fresh = body_info(&app, user, kind, target).await;
        ok(&app, user, "DELETE", &path, json!({"revision":1,"reconcile":{"free_text":"保持する自由記述\n","token":fresh["body_token"]}})).await;
        let after = body_info(&app, user, kind, target).await;
        assert_eq!(after["sync_required"], false);
        assert_eq!(after["free_text"], "保持する自由記述\n");
        assert_eq!(
            after["parts"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| p["type"] == "answer")
                .count(),
            2
        );
        assert!(
            after["body"]
                .as_str()
                .unwrap()
                .contains("new-concurrent-answer")
        );
        // 定義情報のない登録でも、既に対応が分かっていれば追加確認なしで削除できる。
        let next = submit(&app, &pool, user, kind, target, "missing-definition", false).await;
        sqlx::query(&format!(
            r#"
            UPDATE {kind}_form_submission_model
            SET form_snapshot = NULL
            WHERE id = $1
            "#
        ))
        .bind(next.to_string())
        .execute(&pool)
        .await
        .unwrap();
        ok(
            &app,
            user,
            "DELETE",
            &format!("/form-answers/{kind}/{next}"),
            json!({"revision":1}),
        )
        .await;
        assert!(
            !body_info(&app, user, kind, target).await["body"]
                .as_str()
                .unwrap()
                .contains("missing-definition")
        );
    }
}

/// 本文の保存失敗時は、登録の削除も同一トランザクションで取り消す。
#[tokio::test]
async fn delete_rolls_back_registration_when_body_cannot_be_saved() {
    let pool = common::test_pool().await;
    let (app, user, layer) = fixture(&pool, "delete-rollback").await;
    let target = object(&app, user, layer, "shape", false).await;
    let id = submit(
        &app,
        &pool,
        user,
        "shape",
        target,
        "retained-on-error",
        false,
    )
    .await;
    let before = stored(&pool, "shape", target).await;
    let info = body_info(&app, user, "shape", target).await;
    let (status, _) = call(&app, Some(user), "DELETE", &format!("/form-answers/shape/{id}"), json!({"revision":1,"reconcile":{"free_text":"あ".repeat(10001),"token":info["body_token"]}})).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(count(&pool, "shape", target).await, 1);
    assert_eq!(stored(&pool, "shape", target).await, before);
}

/// 個別削除で画像ファイルや所有者の画像使用量を減らさない。
#[tokio::test]
async fn delete_keeps_image_files_and_storage_usage() {
    let pool = common::test_pool().await;
    let (app, user, layer) = fixture(&pool, "delete-image").await;
    for kind in ["marker", "shape"] {
        let target = object(&app, user, layer, kind, true).await;
        let id = submit(&app, &pool, user, kind, target, "with-image", true).await;
        let values: Value = sqlx::query_scalar(&format!(
            r#"
            SELECT submitted_values
            FROM {kind}_form_submission_model
            WHERE id = $1
            "#
        ))
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        let filename = values["pic"]["url"]
            .as_str()
            .unwrap()
            .trim_start_matches("/static/images/");
        let path = common::test_files_dir().join(&filename[..5]).join(filename);
        assert!(path.exists());
        let usage: (i64, i64) = sqlx::query_as(
            r#"
            SELECT count(*), COALESCE(sum(stored_bytes), 0)
            FROM marker_form_image_model
            WHERE owner_id = $1
            "#,
        )
        .bind(user.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        ok(
            &app,
            user,
            "DELETE",
            &format!("/form-answers/{kind}/{id}"),
            json!({"revision":1}),
        )
        .await;
        let after: (i64, i64) = sqlx::query_as(
            r#"
            SELECT count(*), COALESCE(sum(stored_bytes), 0)
            FROM marker_form_image_model
            WHERE owner_id = $1
            "#,
        )
        .bind(user.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(usage, after);
        assert!(path.exists());
        assert_eq!(count(&pool, kind, target).await, 0);
    }
}

/// 複数接続の一時SQLiteで、削除・編集・新規投稿を直列化して本文を保全する。
#[tokio::test]
async fn delete_serializes_with_other_deletes_updates_and_new_submissions() {
    let (pool, database_path) = common::file_test_pool().await;
    let (app, user, layer) = fixture(&pool, "delete-concurrent").await;
    for kind in ["marker", "shape"] {
        let target = object(&app, user, layer, kind, false).await;
        let id = submit(&app, &pool, user, kind, target, "remove-me", false).await;
        let path = format!("/form-answers/{kind}/{id}");
        let request = json!({"revision":1});
        let (deleted, _) = tokio::join!(
            call(&app, Some(user), "DELETE", &path, request.clone()),
            submit(&app, &pool, user, kind, target, "concurrent-kept", false)
        );
        assert_eq!(deleted.0, StatusCode::OK);
        let info = body_info(&app, user, kind, target).await;
        assert_eq!(info["sync_required"], false);
        assert_eq!(info["free_text"], "自由記述\n");
        assert!(info["body"].as_str().unwrap().contains("concurrent-kept"));
        assert!(!info["body"].as_str().unwrap().contains("remove-me"));
        let id = submit(&app, &pool, user, kind, target, "double-delete", false).await;
        let path = format!("/form-answers/{kind}/{id}");
        let (a, b) = tokio::join!(
            call(&app, Some(user), "DELETE", &path, request.clone()),
            call(&app, Some(user), "DELETE", &path, request)
        );
        assert!(matches!(
            (a.0, b.0),
            (StatusCode::OK, StatusCode::NOT_FOUND) | (StatusCode::NOT_FOUND, StatusCode::OK)
        ));
        assert_eq!(count(&pool, kind, target).await, 1);
        let id = submit(&app, &pool, user, kind, target, "edit-race", false).await;
        let path = format!("/form-answers/{kind}/{id}");
        let edit = format!(
            "--delete-edit\r\nContent-Disposition: form-data; name=\"submission\"\r\n\r\n{}\r\n--delete-edit--\r\n",
            json!({"revision":1,"values":{"note":"edited-race"}})
        );
        let (deleted, edited) = tokio::join!(
            call(&app, Some(user), "DELETE", &path, json!({"revision":1})),
            raw(
                &app,
                Some(user),
                "PUT",
                &path,
                "multipart/form-data; boundary=delete-edit",
                edit.into_bytes()
            )
        );
        assert!(matches!(
            (deleted.0, edited.0),
            (StatusCode::OK, StatusCode::NOT_FOUND) | (StatusCode::CONFLICT, StatusCode::OK)
        ));
        let info = body_info(&app, user, kind, target).await;
        assert_eq!(info["sync_required"], false);
        assert_eq!(info["free_text"], "自由記述\n");
        assert!(info["body"].as_str().unwrap().contains("concurrent-kept"));
    }
    drop(app);
    common::close_file_test_pool(pool, database_path).await;
}
