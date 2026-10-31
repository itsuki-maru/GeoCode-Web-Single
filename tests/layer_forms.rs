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
async fn call(
    app: &Router,
    user: Option<Uuid>,
    method: &str,
    path: &str,
    data: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(user) = user {
        req = req.header(
            "cookie",
            format!(
                "access_token={}",
                geocode_web_single::auth::create_token(&user.to_string(), 30, "access_token", 0)
                    .unwrap()
            ),
        );
    }
    let response = app
        .clone()
        .oneshot(
            req.body(
                data.map(|v| Body::from(v.to_string()))
                    .unwrap_or_else(Body::empty),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&body).unwrap_or_else(|_| json!(String::from_utf8_lossy(&body))),
    )
}
async fn ok(app: &Router, user: Uuid, method: &str, path: &str, data: Option<Value>) -> Value {
    let (status, body) = call(app, Some(user), method, path, data).await;
    assert!(status.is_success(), "{method} {path}: {status} {body}");
    body
}
fn definition(title: &str) -> Value {
    json!({"enabled":false,"form_title":title,"form_description":"説明","form_schema":{"fields":[{"id":"n","type":"number","label":"年数"},{"id":"flag","type":"checkbox","label":"確認"}]},"password_mode":"keep"})
}
async fn common_form(app: &Router, user: Uuid, title: &str) -> Value {
    ok(app, user, "POST", "/common-forms", Some(definition(title))).await
}
async fn layer(app: &Router, user: Uuid, name: &str) -> Uuid {
    Uuid::parse_str(
        ok(app, user, "POST", &format!("/layer?name={name}"), None).await["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}
async fn marker(app: &Router, user: Uuid, layer: Uuid) -> Uuid {
    Uuid::parse_str(
        ok(
            app,
            user,
            "POST",
            &format!("/marker?layer_id={layer}&latitude=35&longitude=139"),
            None,
        )
        .await["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}
async fn shape(app: &Router, user: Uuid, layer: Uuid) -> Uuid {
    Uuid::parse_str(ok(app,user,"POST","/shape",Some(json!({"layer_id":layer,"shape_type":"polyline","name":"管路","geojson":{"type":"Feature","properties":{"memo":"元のメモ","style":{"weight":4}},"geometry":{"type":"LineString","coordinates":[[139,35],[140,36]]}}}))).await["id"].as_str().unwrap()).unwrap()
}
async fn change_body(app: &Router, user: Uuid, layer: Uuid, form: Option<&Value>) -> Value {
    let meta = ok(app, user, "GET", &format!("/layer/{layer}/form"), None).await;
    json!({"name":"group","update_common_form":true,"common_form_id":form.map(|f|&f["id"]),"common_form_version":form.map(|f|&f["version"]),"form_binding_revision":meta["revision"],"form_target_count":meta["marker_count"].as_i64().unwrap()+meta["shape_count"].as_i64().unwrap()})
}
async fn bind(app: &Router, user: Uuid, layer: Uuid, form: Option<&Value>) {
    let body = change_body(app, user, layer, form).await;
    ok(
        app,
        user,
        "PUT",
        &format!("/layer/update/{layer}"),
        Some(body),
    )
    .await;
}
async fn config(app: &Router, user: Uuid, kind: &str, id: Uuid) -> Value {
    ok(app, user, "GET", &format!("/{kind}/{id}/form"), None).await
}
async fn save_config(app: &Router, user: Uuid, kind: &str, id: Uuid, mut config: Value) -> Value {
    config["password_mode"] = json!("keep");
    ok(
        app,
        user,
        "PUT",
        &format!("/{kind}/{id}/form"),
        Some(config),
    )
    .await
}
async fn revise(
    app: &Router,
    user: Uuid,
    id: &str,
    title: &str,
    mode: &str,
    password: Option<&str>,
) -> Value {
    let current = ok(app, user, "GET", &format!("/common-forms/{id}"), None).await;
    let mut p = definition(title);
    p["version"] = current["version"].clone();
    p["expected_managed_count"] = current["managed_target_count"].clone();
    p["expected_applied_count"] = current["applied_target_count"].clone();
    p["password_mode"] = json!(mode);
    p["password"] = json!(password);
    ok(app, user, "PUT", &format!("/common-forms/{id}"), Some(p)).await
}
async fn post_public(
    app: &Router,
    path: &str,
    token: Option<&str>,
    password: Option<&str>,
) -> StatusCode {
    let submission =
        json!({"config_token":token,"password":password,"values":{"n":"20","flag":false}});
    let body = format!(
        "--boundary\r\nContent-Disposition: form-data; name=\"submission\"\r\n\r\n{submission}\r\n--boundary--\r\n"
    );
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "multipart/form-data; boundary=boundary")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn managed_forms_apply_move_propagate_restrict_and_keep_history() {
    let pool = common::test_pool().await;
    let user = test_user(&pool, "layer-owner").await;
    let other = test_user(&pool, "layer-other").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let first = layer(&app, user, "first").await;
    let second = layer(&app, user, "second").await;
    let plain = layer(&app, user, "plain").await;
    let a = common_form(&app, user, "A").await;
    let b = common_form(&app, user, "B").await;
    let id = marker(&app, user, first).await;
    let sid = shape(&app, user, first).await;
    let manual = marker(&app, user, plain).await;
    let mut old = definition("old");
    old["enabled"] = json!(true);
    old["password_mode"] = json!("set");
    old["password"] = json!("old-password");
    let before = ok(&app, user, "PUT", &format!("/marker/{id}/form"), Some(old)).await;
    let mut copy = definition("manual");
    copy["source_form"] = json!({"id":a["id"],"version":a["version"]});
    save_config(&app, user, "marker", manual, copy).await;
    bind(&app, user, first, Some(&a)).await;
    bind(&app, user, second, Some(&b)).await;
    let current = config(&app, user, "marker", id).await;
    assert_eq!(current["managed_layer_id"], first.to_string());
    assert_eq!(current["form_title"], "A");
    assert_eq!(current["public_path"], before["public_path"]);
    assert_eq!(current["enabled"], true);
    assert_eq!(current["is_password_protected"], false);
    assert_eq!(
        config(&app, user, "shape", sid).await["managed_layer_id"],
        first.to_string()
    );
    let mut illegal = current.clone();
    illegal["form_title"] = json!("tampered");
    assert_eq!(
        call(
            &app,
            Some(user),
            "PUT",
            &format!("/marker/{id}/form"),
            Some(illegal)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut toggled = current.clone();
    toggled["enabled"] = json!(false);
    save_config(&app, user, "marker", id, toggled).await;
    let mut toggled = current.clone();
    toggled["enabled"] = json!(true);
    save_config(&app, user, "marker", id, toggled).await;
    let rotated = ok(
        &app,
        user,
        "POST",
        &format!("/marker/{id}/form/rotate-url"),
        None,
    )
    .await;
    assert_ne!(rotated["public_path"], current["public_path"]);
    let path = rotated["public_path"].as_str().unwrap();
    // 既存のトークンなし投稿も互換性を維持する。
    assert_eq!(post_public(&app, path, None, None).await, StatusCode::OK);
    let input = ok(&app, user, "GET", &format!("/marker/{id}/form/input"), None).await;
    let old_token = input["config_token"].as_str().unwrap();
    let (page_status, page) = call(&app, None, "GET", path, None).await;
    assert_eq!(page_status, StatusCode::OK);
    let html = page.as_str().unwrap();
    assert!(html.contains("configToken:"));
    assert!(html.contains(old_token));
    let v2 = revise(&app, user, a["id"].as_str().unwrap(), "A-new", "keep", None).await;
    assert_eq!(
        config(&app, user, "marker", id).await["form_title"],
        "A-new"
    );
    assert_eq!(
        config(&app, user, "shape", sid).await["source_form"]["version"],
        2
    );
    assert_eq!(
        config(&app, user, "marker", manual).await["form_title"],
        "manual"
    );
    assert_eq!(
        config(&app, user, "marker", manual).await["source_form"]["version"],
        1
    );
    assert_eq!(
        post_public(&app, path, Some(old_token), None).await,
        StatusCode::CONFLICT
    );
    let pwd = revise(
        &app,
        user,
        a["id"].as_str().unwrap(),
        "A-new",
        "set",
        Some("new-password"),
    )
    .await;
    assert_eq!(pwd["is_password_protected"], true);
    assert!(pwd.get("password_hash").is_none());
    assert_eq!(
        config(&app, user, "marker", manual).await["is_password_protected"],
        true
    );
    assert!(
        !post_public(&app, path, None, Some("wrong-password"))
            .await
            .is_success()
    );
    assert_eq!(
        post_public(&app, path, None, Some("new-password")).await,
        StatusCode::OK
    );
    let rows: Vec<(Value, Value)> = sqlx::query_as(
        r#"
        SELECT
            source_form,
            form_snapshot
        FROM marker_form_submission_model
        WHERE marker_id = $1
        ORDER BY create_at, id
        "#,
    )
    .bind(id.to_string())
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0["version"], 1);
    assert_eq!(rows[0].1["form_title"], "A");
    let analysis=ok(&app,user,"POST","/form-answers/search",Some(json!({"mode":"latest","common_form_id":a["id"],"conditions":[{"field_id":"n","field_type":"number","op":"gte","value":"20"}]}))).await;
    assert_eq!(analysis["total"], 1);
    let fresh = marker(&app, user, first).await;
    assert_eq!(
        config(&app, user, "marker", fresh).await["source_form"]["version"],
        3
    );
    let new_shape = shape(&app, user, first).await;
    assert_eq!(
        config(&app, user, "shape", new_shape).await["managed_layer_id"],
        first.to_string()
    );
    // 通常のレイヤ名だけの更新はフォーム設定を解除しない。
    ok(
        &app,
        user,
        "PUT",
        &format!("/layer/update/{first}"),
        Some(json!({"name":"renamed"})),
    )
    .await;
    assert_eq!(
        config(&app, user, "marker", id).await["managed_layer_id"],
        first.to_string()
    );
    // 移動先に追従し、未設定レイヤへ出た場合は個別設定として保持。
    ok(
        &app,
        user,
        "PUT",
        &format!("/marker/update/{fresh}"),
        Some(json!({"name":"moved","detail":"memo","layer_id":second})),
    )
    .await;
    assert_eq!(
        config(&app, user, "marker", fresh).await["source_form"]["id"],
        b["id"]
    );
    ok(
        &app,
        user,
        "PUT",
        &format!("/marker/update/{fresh}"),
        Some(json!({"name":"moved","detail":"memo","layer_id":plain})),
    )
    .await;
    let detached = config(&app, user, "marker", fresh).await;
    assert!(detached["managed_layer_id"].is_null());
    assert_eq!(detached["form_title"], "B");
    let mut edited = detached;
    edited["form_title"] = json!("individual");
    save_config(&app, user, "marker", fresh, edited).await;
    ok(
        &app,
        user,
        "PUT",
        &format!("/shape/{new_shape}"),
        Some(json!({"name":"moved-shape","layer_id":second})),
    )
    .await;
    assert_eq!(
        config(&app, user, "shape", new_shape).await["source_form"]["id"],
        b["id"]
    );
    ok(
        &app,
        user,
        "PUT",
        &format!("/shape/{new_shape}"),
        Some(json!({"name":"moved-shape","layer_id":plain})),
    )
    .await;
    assert!(config(&app, user, "shape", new_shape).await["managed_layer_id"].is_null());
    assert_eq!(
        call(
            &app,
            Some(user),
            "DELETE",
            &format!("/common-forms/{}", a["id"].as_str().unwrap()),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(&app, None, "GET", &format!("/layer/{first}/form"), None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            Some(other),
            "GET",
            &format!("/layer/{first}/form"),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let detail: String = sqlx::query_scalar(
        r#"
        SELECT
            detail
        FROM marker_info_model
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    bind(&app, user, first, None).await;
    let cleared = config(&app, user, "marker", id).await;
    assert_eq!(cleared["enabled"], false);
    assert_eq!(cleared["form_schema"]["fields"], json!([]));
    assert!(cleared["managed_layer_id"].is_null());
    assert_ne!(cleared["public_path"], rotated["public_path"]);
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            r#"
            SELECT
                detail
            FROM marker_info_model
            WHERE id = $1
            "#,
        )
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap(),
        detail
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM marker_form_submission_model
            WHERE marker_id = $1
            "#
        )
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap(),
        2
    );
    assert_eq!(
        post_public(&app, path, None, Some("new-password")).await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(marker(&app, user, plain).await.to_string().len(), 36);
    // 解除後は共通フォームを削除でき、過去回答は残る。
    ok(
        &app,
        user,
        "DELETE",
        &format!("/common-forms/{}", a["id"].as_str().unwrap()),
        None,
    )
    .await;
    assert_eq!(v2["version"], 2);
}

#[tokio::test]
async fn bulk_application_is_complete_conflicts_are_atomic_and_master_is_not_global() {
    let pool = common::test_pool().await;
    let user = test_user(&pool, "bulk-owner").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let master = test_master(&pool, &user).await;
    let layer = layer(&app, user, "bulk").await;
    let form = common_form(&app, user, "bulk").await;
    let actual_master = marker(&app, user, master).await;
    sqlx::query(
        r#"
        WITH RECURSIVE
            series (i) AS (
                SELECT
                    1
                UNION ALL
                SELECT
                    i + 1
                FROM series
                WHERE i < 10001
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
            printf('%08x-0000-4000-8000-%012x', i, i),
            $1,
            $2,
            'bulk',
            35,
            139,
            '',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        FROM series
        "#,
    )
    .bind(user.to_string())
    .bind(layer.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let stale = change_body(&app, user, layer, Some(&form)).await;
    let added = marker(&app, user, layer).await;
    assert_eq!(
        call(
            &app,
            Some(user),
            "PUT",
            &format!("/layer/update/{layer}"),
            Some(stale)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert!(config(&app, user, "marker", added).await["source_form"].is_null());
    bind(&app, user, layer, Some(&form)).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT
                count(*)
            FROM marker_form_config_model
            WHERE managed_layer_id = $1
            "#
        )
        .bind(layer.to_string())
        .fetch_one(&pool)
        .await
        .unwrap(),
        10002
    );
    assert!(config(&app, user, "marker", actual_master).await["managed_layer_id"].is_null());
    bind(&app, user, master, Some(&form)).await;
    assert_eq!(
        config(&app, user, "marker", actual_master).await["managed_layer_id"],
        master.to_string()
    );
    // 旧クライアントは影響件数の確認なしに一括変更できない。
    let mut update = definition("unsafe");
    update["version"] = form["version"].clone();
    assert_eq!(
        call(
            &app,
            Some(user),
            "PUT",
            &format!("/common-forms/{}", form["id"].as_str().unwrap()),
            Some(update)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        config(&app, user, "marker", added).await["form_title"],
        "bulk"
    );
    // 新規作成と共通フォーム更新が競合しても、保存完了時は全対象で最新に揃う。
    let current = ok(
        &app,
        user,
        "GET",
        &format!("/common-forms/{}", form["id"].as_str().unwrap()),
        None,
    )
    .await;
    let mut update = definition("latest");
    update["version"] = current["version"].clone();
    update["expected_managed_count"] = current["managed_target_count"].clone();
    let url = format!("/common-forms/{}", form["id"].as_str().unwrap());
    let (new_marker, (status, _)) = tokio::join!(
        marker(&app, user, layer),
        call(&app, Some(user), "PUT", &url, Some(update))
    );
    assert!(status == StatusCode::OK || status == StatusCode::CONFLICT);
    let changed = if status == StatusCode::CONFLICT {
        revise(
            &app,
            user,
            form["id"].as_str().unwrap(),
            "latest",
            "keep",
            None,
        )
        .await
    } else {
        ok(&app, user, "GET", &url, None).await
    };
    assert_eq!(
        config(&app, user, "marker", new_marker).await["source_form"]["version"],
        changed["version"]
    );
}

async fn test_user(pool: &SqlitePool, name: &str) -> uuid::Uuid {
    uuid::Uuid::parse_str(&common::create_test_user(pool, name).await).unwrap()
}
async fn test_master(pool: &SqlitePool, user: &uuid::Uuid) -> uuid::Uuid {
    uuid::Uuid::parse_str(&common::master_layer_id(pool, &user.to_string()).await).unwrap()
}
#[tokio::test]
async fn owner_input_keeps_private_forms_objects_history_and_prefill() {
    let pool = common::test_pool().await;
    let user = test_user(&pool, "owner-input").await;
    let other = test_user(&pool, "input-other").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let layer = layer(&app, user, "input").await;
    let marker = marker(&app, user, layer).await;
    let shape = shape(&app, user, layer).await;
    for (kind, id) in [("marker", marker), ("shape", shape)] {
        save_config(&app, user, kind, id, definition("private")).await;
        let path = format!("/{kind}/{id}/form/input");
        assert_eq!(
            call(&app, Some(other), "GET", &path, None).await.0,
            StatusCode::NOT_FOUND
        );
        let initial = ok(&app, user, "GET", &path, None).await;
        assert_eq!(initial["values"], json!({}));
        let send = |token: String| {
            let payload = json!({"config_token":token,"values":{"n":"0","flag":false}});
            Request::builder().method("POST").uri(format!("/{kind}/{id}/form/submissions"))
    .header("cookie",format!("access_token={}",geocode_web_single::auth::create_token(&user.to_string(),30,"access_token",0).unwrap()))
    .header("content-type","multipart/form-data; boundary=owner-boundary")
    .body(Body::from(format!("--owner-boundary\r\nContent-Disposition: form-data; name=\"submission\"\r\n\r\n{payload}\r\n--owner-boundary--\r\n"))).unwrap()
        };
        let response = app
            .clone()
            .oneshot(send(initial["config_token"].as_str().unwrap().into()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let saved: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(saved["object"]["layer_id"], layer.to_string());
        if kind == "shape" {
            assert!(saved["object"]["geojson"].is_object());
            assert_eq!(saved["object"]["geojson"]["geometry"]["type"], "LineString");
        } else {
            assert!(
                saved["object"]["detail"]
                    .as_str()
                    .unwrap()
                    .contains("フォーム投稿")
            );
        }
        let prefill = ok(&app, user, "GET", &path, None).await;
        assert_eq!(prefill["values"], json!({"n":"0","flag":false}));
        let mut changed = definition("changed");
        changed["form_schema"]["fields"][0]["label"] = json!("renamed");
        save_config(&app, user, kind, id, changed).await;
        assert_eq!(
            app.clone()
                .oneshot(send(prefill["config_token"].as_str().unwrap().into()))
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        let prefill = ok(&app, user, "GET", &path, None).await;
        assert_eq!(prefill["values"], json!({"n":"0","flag":false}));
        assert_eq!(config(&app, user, kind, id).await["enabled"], false);
    }
    let answers = ok(
        &app,
        user,
        "POST",
        "/form-answers/search",
        Some(json!({"mode":"latest","limit":100})),
    )
    .await;
    assert_eq!(answers["total"], 2);
}

#[tokio::test]
async fn layer_form_upgrade_keeps_legacy_data_and_is_idempotent() {
    let pool = common::test_pool().await;
    let user = test_user(&pool, "upgrade").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let layer = layer(&app, user, "legacy").await;
    let id = marker(&app, user, layer).await;
    let cfg = save_config(&app, user, "marker", id, definition("legacy")).await;
    sqlx::query(
        r#"
        UPDATE marker_form_config_model
        SET
            password_hash = 'legacy-hash',
            enabled = true
        WHERE marker_id = $1
        "#,
    )
    .bind(id.to_string())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO marker_form_submission_model (
            id,
            marker_id,
            submitted_values,
            rendered_markdown,
            create_at
        ) VALUES (
            $1,
            $2,
            '{"n":0,"flag":false}',
            'legacy markdown',
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(id.to_string())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        r#"
        DROP INDEX idx_layer_common_form;

        DROP INDEX idx_marker_form_managed_layer;

        DROP INDEX idx_shape_form_managed_layer;

        ALTER TABLE marker_form_config_model
        DROP COLUMN managed_layer_id;

        ALTER TABLE shape_form_config_model
        DROP COLUMN managed_layer_id;

        ALTER TABLE layer_model
        DROP COLUMN common_form_version;

        ALTER TABLE layer_model
        DROP COLUMN common_form_id;

        ALTER TABLE layer_model
        DROP COLUMN form_binding_revision;

        ALTER TABLE common_form_model
        DROP COLUMN password_hash;

        DELETE FROM schema_migrations
        WHERE version = 18;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let before: (String, String, String, bool) = sqlx::query_as(
        r#"
        SELECT
            public_id,
            form_schema,
            password_hash,
            enabled
        FROM marker_form_config_model
        WHERE marker_id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    geocode_web_single::db::run_migrations(&pool).await.unwrap();
    geocode_web_single::db::run_migrations(&pool).await.unwrap();
    let after: (String, String, String, bool) = sqlx::query_as(
        r#"
        SELECT
            public_id,
            form_schema,
            password_hash,
            enabled
        FROM marker_form_config_model
        WHERE marker_id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    let after = config(&app, user, "marker", id).await;
    assert_eq!(cfg["public_path"], after["public_path"]);
    assert!(after["managed_layer_id"].is_null());
    let answer: Value = sqlx::query_scalar(
        r#"
        SELECT
            submitted_values
        FROM marker_form_submission_model
        WHERE marker_id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(answer, json!({"n":0,"flag":false}));
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM schema_migrations
        WHERE version = 18
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}
#[tokio::test]
async fn input_policy_blocks_free_writes_but_keeps_names_moves_and_form_answers() {
    let pool = common::test_pool().await;
    let user = test_user(&pool, "policy-owner").await;
    let other = test_user(&pool, "policy-other").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let locked = layer(&app, user, "locked").await;
    let free = layer(&app, user, "free").await;
    let id = marker(&app, user, locked).await;
    let sid = shape(&app, user, locked).await;
    let policy_url = format!("/layer/{locked}/input-policy");
    let marker_url = format!("/marker/update/{id}");
    let shape_url = format!("/shape/{sid}");
    assert_eq!(
        ok(&app, user, "GET", "/layer/read/all", None).await[locked.to_string()]["restrict_free_text"],
        false
    );
    // Empty detail is valid, but a name is still required.
    ok(
        &app,
        user,
        "PUT",
        &marker_url,
        Some(json!({"name":"施設","detail":"","layer_id":locked})),
    )
    .await;
    assert_eq!(
        call(
            &app,
            Some(user),
            "PUT",
            &marker_url,
            Some(json!({"name":" ","detail":"","layer_id":locked}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let original: Value = sqlx::query_scalar(
        r#"
        SELECT
            geojson
        FROM shape_model
        WHERE id = $1
        "#,
    )
    .bind(sid.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let before = definition("元フォーム");
    for (kind, object) in [("marker", id), ("shape", sid)] {
        let mut config = before.clone();
        config["enabled"] = json!(true);
        save_config(&app, user, kind, object, config).await;
    }
    assert_eq!(
        call(
            &app,
            Some(other),
            "PUT",
            &policy_url,
            Some(json!({"restrict_free_text":true}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    for _ in 0..2 {
        ok(
            &app,
            user,
            "PUT",
            &policy_url,
            Some(json!({"restrict_free_text":true})),
        )
        .await;
    }
    assert_eq!(
        ok(&app, user, "GET", "/layer/read/all", None).await[locked.to_string()]["restrict_free_text"],
        true
    );
    // Full legacy payload with unchanged protected values remains valid.
    ok(
        &app,
        user,
        "PUT",
        &marker_url,
        Some(json!({"name":"名称変更","detail":"","layer_id":locked})),
    )
    .await;
    ok(&app,user,"PUT",&shape_url,Some(json!({"name":"図形名変更","geojson":original,"shape_type":"polyline","layer_id":locked}))).await;
    assert_eq!(
        call(
            &app,
            Some(user),
            "PUT",
            &marker_url,
            Some(json!({"name":"施設","detail":"迂回","layer_id":free}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            Some(user),
            "PUT",
            &format!("/marker/update-marker-latlng?marker_id={id}&latitude=36&longitude=140"),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    ok(
        &app,
        user,
        "PUT",
        &format!("/marker/update-marker-latlng?marker_id={id}&latitude=35&longitude=139"),
        None,
    )
    .await;
    for key in ["memo", "style", "geometry", "type"] {
        let mut body = json!({"name":"図形","layer_id":free,"geojson":original});
        match key {
            "memo" => body["geojson"]["properties"]["memo"] = json!("迂回"),
            "style" => body["geojson"]["properties"]["style"]["weight"] = json!(9),
            "geometry" => body["geojson"]["geometry"]["coordinates"][0] = json!([138, 34]),
            _ => body["shape_type"] = json!("polygon"),
        }
        assert_eq!(
            call(&app, Some(user), "PUT", &shape_url, Some(body))
                .await
                .0,
            StatusCode::BAD_REQUEST,
            "{key}"
        );
    }
    marker(&app, user, locked).await; // Initial coordinates with empty detail are allowed.
    assert_eq!(
        call(
            &app,
            Some(user),
            "POST",
            "/shape",
            Some(json!({"layer_id":locked,"shape_type":"polyline","geojson":original}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut empty = original.clone();
    empty["properties"]["memo"] = json!("");
    ok(
        &app,
        user,
        "POST",
        "/shape",
        Some(json!({"layer_id":locked,"shape_type":"polyline","geojson":empty})),
    )
    .await;
    for (kind, object) in [("marker", id), ("shape", sid)] {
        let cfg = config(&app, user, kind, object).await;
        assert_eq!(
            post_public(&app, cfg["public_path"].as_str().unwrap(), None, None).await,
            StatusCode::OK
        );
        let input = ok(
            &app,
            user,
            "GET",
            &format!("/{kind}/{object}/form/input"),
            None,
        )
        .await;
        let submission =
            json!({"config_token":input["config_token"],"values":{"n":"42","flag":true}});
        let body = format!(
            "--boundary\r\nContent-Disposition: form-data; name=\"submission\"\r\n\r\n{submission}\r\n--boundary--\r\n"
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/{kind}/{object}/form/submissions"))
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
                    .header("content-type", "multipart/form-data; boundary=boundary")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let detail: String = sqlx::query_scalar(
        r#"
        SELECT
            detail
        FROM marker_info_model
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let geojson: Value = sqlx::query_scalar(
        r#"
        SELECT
            geojson
        FROM shape_model
        WHERE id = $1
        "#,
    )
    .bind(sid.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(detail.contains("42"));
    assert!(
        geojson["properties"]["memo"]
            .as_str()
            .unwrap()
            .contains("42")
    );
    // Move alone is allowed; moving into a restricted layer also checks protected values.
    ok(
        &app,
        user,
        "PUT",
        &marker_url,
        Some(json!({"name":"施設","detail":detail,"layer_id":free})),
    )
    .await;
    assert_eq!(
        call(
            &app,
            Some(user),
            "PUT",
            &marker_url,
            Some(json!({"name":"施設","detail":"迂回","layer_id":locked}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    ok(
        &app,
        user,
        "PUT",
        &shape_url,
        Some(json!({"name":"図形","layer_id":free})),
    )
    .await;
    assert_eq!(
        call(
            &app,
            Some(user),
            "PUT",
            &shape_url,
            Some(json!({"name":"図形","layer_id":locked,"geojson":original}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let body_meta = ok(&app, user, "GET", &format!("/marker/{id}/form/body"), None).await;
    ok(
        &app,
        user,
        "PUT",
        &marker_url,
        Some(json!({"name":"施設","detail":detail,"free_text":"自由記述可","body_token":body_meta["body_token"],"layer_id":free})),
    )
    .await;
    for table in [
        "marker_form_submission_model",
        "shape_form_submission_model",
    ] {
        let total: i64 = sqlx::query_scalar(&format!(
            r#"
            SELECT
                count(*)
            FROM {table}
            "#,
        ))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(total, 2);
    }
    ok(
        &app,
        user,
        "PUT",
        &policy_url,
        Some(json!({"restrict_free_text":false})),
    )
    .await;
    assert_eq!(
        ok(&app, user, "GET", "/layer/read/all", None).await[locked.to_string()]["restrict_free_text"],
        false
    );
}
#[tokio::test]
async fn input_policy_is_rechecked_after_concurrent_setting_change() {
    let (pool, path) = common::file_test_pool().await;
    let user = test_user(&pool, "policy-race").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let l = layer(&app, user, "race").await;
    let m = marker(&app, user, l).await;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query(
        r#"
        UPDATE layer_model
        SET
            restrict_free_text = true
        WHERE id = $1
        "#,
    )
    .bind(l.to_string())
    .execute(&mut *tx)
    .await
    .unwrap();
    let mut request = tokio::spawn(async move {
        call(
            &app,
            Some(user),
            "PUT",
            &format!("/marker/update/{m}"),
            Some(json!({"name":"施設","detail":"stale edit","layer_id":l})),
        )
        .await
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut request)
            .await
            .is_err()
    );
    tx.commit().await.unwrap();
    assert_eq!(request.await.unwrap().0, StatusCode::BAD_REQUEST);
    let detail: String = sqlx::query_scalar(
        r#"
        SELECT
            detail
        FROM marker_info_model
        WHERE id = $1
        "#,
    )
    .bind(m.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(detail, "");
    common::close_file_test_pool(pool, path).await;
}

async fn owner_post(app: &Router, user: Uuid, kind: &str, target: Uuid, n: &str) {
    let input = ok(
        app,
        user,
        "GET",
        &format!("/{kind}/{target}/form/input"),
        None,
    )
    .await;
    let payload = json!({"config_token":input["config_token"],"values":{"n":n,"flag":true}});
    let body = format!(
        "--edit\r\nContent-Disposition: form-data; name=\"submission\"\r\n\r\n{payload}\r\n--edit--\r\n"
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/{kind}/{target}/form/submissions"))
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
                .header("content-type", "multipart/form-data; boundary=edit")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
async fn correct(
    app: &Router,
    user: Uuid,
    kind: &str,
    id: Uuid,
    payload: Value,
) -> (StatusCode, Value) {
    let body = format!(
        "--edit\r\nContent-Disposition: form-data; name=\"submission\"\r\n\r\n{payload}\r\n--edit--\r\n"
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/form-answers/{kind}/{id}"))
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
                .header("content-type", "multipart/form-data; boundary=edit")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn answer_correction_preserves_identity_latest_order_and_body_integrity() {
    let (pool, temporary_path) = common::file_test_pool().await;
    let user = test_user(&pool, "correct-owner").await;
    let other = test_user(&pool, "correct-other").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let l = layer(&app, user, "correct").await;
    let m = marker(&app, user, l).await;
    let g = shape(&app, user, l).await;
    ok(
        &app,
        user,
        "PUT",
        &format!("/marker/update/{m}"),
        Some(json!({"name":"施設","detail":"自由記述\n","layer_id":l})),
    )
    .await;
    for (kind, target) in [("marker", m), ("shape", g)] {
        let mut cfg = definition("投稿時のフォーム");
        cfg["enabled"] = json!(true);
        let cfg = save_config(&app, user, kind, target, cfg).await;
        assert_eq!(
            post_public(&app, cfg["public_path"].as_str().unwrap(), None, None).await,
            StatusCode::OK
        );
        owner_post(&app, user, kind, target, "42").await;
        let id: String = sqlx::query_scalar(&format!(
            r#"
            SELECT
                id
            FROM {kind}_form_submission_model
            WHERE {kind}_id = $1
            ORDER BY create_at, id
            LIMIT 1
            "#,
        ))
        .bind(target.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        let id = Uuid::parse_str(&id).unwrap();
        let before: (String, String) = sqlx::query_as(&format!(
            r#"
            SELECT
                create_at,
                form_snapshot
            FROM {kind}_form_submission_model
            WHERE id = $1
            "#
        ))
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        let mut next = definition("現在の別フォーム");
        next["form_schema"]["fields"] = json!([{"id":"different","type":"text","label":"別項目"}]);
        save_config(&app, user, kind, target, next).await;
        let edit = ok(
            &app,
            user,
            "GET",
            &format!("/form-answers/{kind}/{id}"),
            None,
        )
        .await;
        assert_eq!(edit["form_title"], "投稿時のフォーム");
        assert_eq!(edit["body_info"]["sync_required"], false);
        assert_eq!(
            call(
                &app,
                Some(other),
                "GET",
                &format!("/form-answers/{kind}/{id}"),
                None
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let request =
            json!({"revision":edit["revision"],"values":{"n":"9007199254740993","flag":false}});
        assert_eq!(
            correct(&app, other, kind, id, request.clone()).await.0,
            StatusCode::NOT_FOUND
        );
        let (status, result) = correct(&app, user, kind, id, request.clone()).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        let body = if kind == "marker" {
            result["object"]["detail"].as_str().unwrap()
        } else {
            result["object"]["geojson"]["properties"]["memo"]
                .as_str()
                .unwrap()
        };
        assert!(body.contains("9007199254740993"));
        assert!(body.contains("42"));
        assert!(body.contains(if kind == "marker" {
            "自由記述"
        } else {
            "元のメモ"
        }));
        if kind == "shape" {
            assert_eq!(
                result["object"]["geojson"]["geometry"]["coordinates"],
                json!([[139, 35], [140, 36]])
            );
            assert_eq!(
                result["object"]["geojson"]["properties"]["style"]["weight"],
                4
            );
        }
        assert_eq!(
            correct(&app, user, kind, id, request).await.0,
            StatusCode::CONFLICT
        );
        let after: (String, String, i64, bool) = sqlx::query_as(&format!(
            r#"
            SELECT
                create_at,
                form_snapshot,
                revision,
                edited_at IS NOT NULL
            FROM {kind}_form_submission_model
            WHERE id = $1
            "#,
        ))
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!((after.0, after.1), before);
        assert_eq!(after.2, 2);
        assert!(after.3);
        for mode in ["history", "latest"] {
            let page = ok(
                &app,
                user,
                "POST",
                "/form-answers/search",
                Some(json!({"mode":mode,"target_type":kind,"target_id":target})),
            )
            .await;
            assert_eq!(page["editing_supported"], true);
            assert_eq!(page["total"], if mode == "history" { 2 } else { 1 });
            if mode == "latest" {
                assert_eq!(page["rows"][0]["submitted_values"]["n"], 42);
            }
        }
        ok(
            &app,
            user,
            "PUT",
            &format!("/layer/{l}/input-policy"),
            Some(json!({"restrict_free_text":true})),
        )
        .await;
        assert_eq!(
            correct(
                &app,
                user,
                kind,
                id,
                json!({"revision":2,"values":{"n":"17","flag":false}})
            )
            .await
            .0,
            StatusCode::OK
        );
        ok(
            &app,
            user,
            "PUT",
            &format!("/layer/{l}/input-policy"),
            Some(json!({"restrict_free_text":false})),
        )
        .await;
    }
    common::close_file_test_pool(pool, temporary_path).await;
}
#[tokio::test]
async fn ambiguous_legacy_answers_require_explicit_reconciliation_and_recheck_body() {
    let (pool, temporary_path) = common::file_test_pool().await;
    let user = test_user(&pool, "legacy-correction").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let l = layer(&app, user, "legacy").await;
    let m = marker(&app, user, l).await;
    save_config(&app, user, "marker", m, definition("重複回答")).await;
    owner_post(&app, user, "marker", m, "20").await;
    owner_post(&app, user, "marker", m, "20").await;
    let id: String = sqlx::query_scalar(
        r#"
        SELECT
            id
        FROM marker_form_submission_model
        WHERE marker_id = $1
        ORDER BY create_at, id
        LIMIT 1
        "#,
    )
    .bind(m.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let id = Uuid::parse_str(&id).unwrap();
    // New submissions already carry stable IDs, even when their rendered texts are identical.
    assert_eq!(
        correct(
            &app,
            user,
            "marker",
            id,
            json!({"revision":1,"values":{"n":"20","flag":true}})
        )
        .await
        .0,
        StatusCode::OK
    );
    sqlx::query(
        r#"
        UPDATE marker_info_model
        SET
            form_body_parts = NULL
        WHERE id = $1
        "#,
    )
    .bind(m.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let meta = ok(
        &app,
        user,
        "GET",
        &format!("/form-answers/marker/{id}"),
        None,
    )
    .await;
    assert_eq!(meta["body_info"]["sync_required"], true);
    assert_eq!(
        correct(
            &app,
            user,
            "marker",
            id,
            json!({"revision":2,"values":{"n":"99","flag":true}})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    owner_post(&app, user, "marker", m, "30").await;
    let stale = json!({"revision":2,"values":{"n":"99","flag":true},"reconcile":{"free_text":"保持する自由記述\n","token":meta["body_info"]["body_token"]}});
    assert_eq!(
        correct(&app, user, "marker", id, stale).await.0,
        StatusCode::CONFLICT
    );
    let fresh = ok(
        &app,
        user,
        "GET",
        &format!("/form-answers/marker/{id}"),
        None,
    )
    .await;
    let (status,saved)=correct(&app,user,"marker",id,json!({"revision":2,"values":{"n":"99","flag":true},"reconcile":{"free_text":"保持する自由記述\n","token":fresh["body_info"]["body_token"]}})).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let text = saved["object"]["detail"].as_str().unwrap();
    assert_eq!(text.matches("保持する自由記述").count(), 1);
    assert!(text.contains("99") && text.contains("30"));
    assert_eq!(
        ok(&app, user, "GET", &format!("/marker/{m}/form/body"), None).await["sync_required"],
        false
    );
    assert_eq!(
        call(
            &app,
            Some(user),
            "PUT",
            &format!("/marker/update/{m}"),
            Some(json!({"name":"施設","detail":"上書き","layer_id":l}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    sqlx::query(
        r#"
        UPDATE marker_form_submission_model
        SET
            submitted_values = json_set(submitted_values, '$.unmapped', 'preserve')
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        call(
            &app,
            Some(user),
            "GET",
            &format!("/form-answers/marker/{id}"),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        correct(
            &app,
            user,
            "marker",
            id,
            json!({"revision":3,"values":{"n":"123","flag":false}})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    sqlx::query(
        r#"
        UPDATE marker_form_submission_model
        SET
            form_snapshot = NULL
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        call(
            &app,
            Some(user),
            "GET",
            &format!("/form-answers/marker/{id}"),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    common::close_file_test_pool(pool, temporary_path).await;
}

async fn correct_image(app: &Router, user: Uuid, id: Uuid, request: Value) -> (StatusCode, Value) {
    let mut cursor = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(8, 8)
        .write_to(&mut cursor, image::ImageFormat::Png)
        .unwrap();
    let mut body=format!("--image\r\nContent-Disposition: form-data; name=\"submission\"\r\n\r\n{request}\r\n--image\r\nContent-Disposition: form-data; name=\"image__pic\"; filename=\"correction.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
    body.extend(cursor.into_inner());
    body.extend(b"\r\n--image--\r\n");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/form-answers/marker/{id}"))
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
                .header("content-type", "multipart/form-data; boundary=image")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn correction_images_preserve_keep_remove_and_rollback_with_the_body() {
    let (pool, temporary_path) = common::file_test_pool().await;
    let user = test_user(&pool, "image-correction").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let l = layer(&app, user, "image").await;
    let m = marker(&app, user, l).await;
    let mut definition = definition("画像回答");
    definition["form_schema"]["fields"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"pic","type":"image","label":"写真"}));
    save_config(&app, user, "marker", m, definition).await;
    owner_post(&app, user, "marker", m, "1").await;
    let id: String = sqlx::query_scalar(
        r#"
        SELECT
            id
        FROM marker_form_submission_model
        WHERE marker_id = $1
        "#,
    )
    .bind(m.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let id = Uuid::parse_str(&id).unwrap();
    let (status, saved) = correct_image(
        &app,
        user,
        id,
        json!({"revision":1,"values":{"n":"2","flag":true},"image_actions":{"pic":"replace"}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let answer = ok(
        &app,
        user,
        "GET",
        &format!("/form-answers/marker/{id}"),
        None,
    )
    .await;
    let reference = answer["values"]["pic"].clone();
    let url = reference["url"].as_str().unwrap();
    let filename = url.trim_start_matches("/static/images/");
    let path = std::path::Path::new("target/handler-tests")
        .join(&filename[..5])
        .join(filename);
    assert!(path.exists());
    let (status, saved) = correct(
        &app,
        user,
        "marker",
        id,
        json!({"revision":2,"values":{"n":"3","flag":false},"image_actions":{"pic":"keep"}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert!(saved["object"]["detail"].as_str().unwrap().contains(url));
    let (status, saved) = correct(
        &app,
        user,
        "marker",
        id,
        json!({"revision":3,"values":{"n":"4","flag":false},"image_actions":{"pic":"remove"}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert!(!saved["object"]["detail"].as_str().unwrap().contains(url));
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM image_model
        WHERE user_id = $1
        "#,
    )
    .bind(user.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    let before: (String, String, i64) = sqlx::query_as(
        r#"
        SELECT
            s.submitted_values,
            m.detail,
            s.revision
        FROM marker_form_submission_model s
        JOIN marker_info_model m ON m.id = s.marker_id
        WHERE s.id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        r#"
        CREATE TRIGGER correction_failure
        BEFORE UPDATE OF detail ON marker_info_model
        BEGIN
            SELECT RAISE(ABORT, 'test body failure');
        END;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        correct_image(
            &app,
            user,
            id,
            json!({"revision":4,"values":{"n":"9","flag":true},"image_actions":{"pic":"replace"}})
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let after: (String, String, i64) = sqlx::query_as(
        r#"
        SELECT
            s.submitted_values,
            m.detail,
            s.revision
        FROM marker_form_submission_model s
        JOIN marker_info_model m ON m.id = s.marker_id
        WHERE s.id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT
            count(*)
        FROM image_model
        WHERE user_id = $1
        "#,
    )
    .bind(user.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    common::close_file_test_pool(pool, temporary_path).await;
}
#[tokio::test]
async fn shape_correction_length_limit_rolls_back_answer_and_projection() {
    let (pool, temporary_path) = common::file_test_pool().await;
    let user = test_user(&pool, "limit-correction").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let l = layer(&app, user, "limit").await;
    let g = shape(&app, user, l).await;
    save_config(&app, user, "shape", g, definition("長さ制限")).await;
    owner_post(&app, user, "shape", g, "1").await;
    let (id, markdown): (String, String) = sqlx::query_as(
        r#"
        SELECT
            id,
            rendered_markdown
        FROM shape_form_submission_model
        WHERE shape_id = $1
        "#,
    )
    .bind(g.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let memo = format!(
        "{}{}",
        "a".repeat(9999 - markdown.chars().count()),
        markdown
    );
    let id = Uuid::parse_str(&id).unwrap();
    sqlx::query(
        r#"
        UPDATE shape_model
        SET
            geojson = json_set(geojson, '$.properties.memo', $1),
            form_body_parts = NULL
        WHERE id = $2
        "#,
    )
    .bind(&memo)
    .bind(g.to_string())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        correct(
            &app,
            user,
            "shape",
            id,
            json!({"revision":1,"values":{"n":"9007199254740993","flag":true}})
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let (revision, value): (i64, String) = sqlx::query_as(
        r#"
        SELECT
            revision,
            CAST(submitted_values ->> 'n' AS TEXT)
        FROM shape_form_submission_model
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(revision, 1);
    assert_eq!(value, "1");
    let body: String = sqlx::query_scalar(
        r#"
        SELECT
            geojson -> 'properties' ->> 'memo'
        FROM shape_model
        WHERE id = $1
        "#,
    )
    .bind(g.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(body, memo);
    common::close_file_test_pool(pool, temporary_path).await;
}

#[tokio::test]
async fn concurrent_answer_corrections_do_not_overwrite_each_other() {
    let (pool, temporary_path) = common::file_test_pool().await;
    let user = test_user(&pool, "edit-race").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let l = layer(&app, user, "race").await;
    let m = marker(&app, user, l).await;
    save_config(&app, user, "marker", m, definition("競合回答")).await;
    owner_post(&app, user, "marker", m, "1").await;
    let id: String = sqlx::query_scalar(
        r#"
        SELECT
            id
        FROM marker_form_submission_model
        WHERE marker_id = $1
        "#,
    )
    .bind(m.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let id = Uuid::parse_str(&id).unwrap();
    let (left, right) = tokio::join!(
        correct(
            &app,
            user,
            "marker",
            id,
            json!({"revision":1,"values":{"n":"2","flag":true}})
        ),
        correct(
            &app,
            user,
            "marker",
            id,
            json!({"revision":1,"values":{"n":"3","flag":false}})
        )
    );
    let mut statuses = vec![left.0, right.0];
    statuses.sort();
    assert_eq!(statuses, vec![StatusCode::OK, StatusCode::CONFLICT]);
    let doc = ok(
        &app,
        user,
        "GET",
        &format!("/form-answers/marker/{id}"),
        None,
    )
    .await;
    assert_eq!(doc["revision"], 2);
    assert_eq!(doc["body_info"]["sync_required"], false);
    let text = doc["body_info"]["body"].as_str().unwrap();
    assert!(text.contains(doc["values"]["n"].as_str().unwrap()));
    common::close_file_test_pool(pool, temporary_path).await;
}
async fn stored_shape(pool: &SqlitePool, id: Uuid) -> Value {
    sqlx::query_scalar(
        r#"
        SELECT
            json_object(
                'id',
                id,
                'user_id',
                user_id,
                'layer_id',
                layer_id,
                'shape_type',
                shape_type,
                'name',
                name,
                'geojson',
                json(geojson),
                'created_at',
                created_at,
                'updated_at',
                updated_at,
                'form_body_parts',
                json(form_body_parts)
            )
        FROM shape_model
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(pool)
    .await
    .unwrap()
}
fn vertex_request(shape: &Value, coordinates: Value, next_type: &str) -> Value {
    json!({"base_shape_type":shape["shape_type"],"base_geometry":shape["geojson"]["geometry"],"shape_type":next_type,"coordinates":coordinates})
}

#[tokio::test]
async fn vertex_updates_keep_latest_form_answers_and_reject_mixed_writes() {
    let (pool, temporary_path) = common::file_test_pool().await;
    let user = test_user(&pool, "vertex-owner").await;
    let other = test_user(&pool, "vertex-other").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let l = layer(&app, user, "vertices").await;
    let id = shape(&app, user, l).await;
    let initial = stored_shape(&pool, id).await;
    save_config(&app, user, "shape", id, definition("記録")).await;
    ok(
        &app,
        user,
        "PUT",
        &format!("/layer/{l}/input-policy"),
        Some(json!({"restrict_free_text":true})),
    )
    .await;
    // The vertex editor starts before another form answer is saved/corrected.
    owner_post(&app, user, "shape", id, "1").await;
    owner_post(&app, user, "shape", id, "2").await;
    let answer: String = sqlx::query_scalar(
        r#"
        SELECT
            id
        FROM shape_form_submission_model
        WHERE shape_id = $1
        ORDER BY create_at, id
        LIMIT 1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let answer = Uuid::parse_str(&answer).unwrap();
    assert_eq!(
        correct(
            &app,
            user,
            "shape",
            answer,
            json!({"revision":1,"values":{"n":"3","flag":true}})
        )
        .await
        .0,
        StatusCode::OK
    );
    let before = stored_shape(&pool, id).await;
    let answers: Value = sqlx::query_scalar(
        r#"
        SELECT
            json_group_array(
                json_object(
                    'id',
                    id,
                    'shape_id',
                    shape_id,
                    'submitted_values',
                    json(submitted_values),
                    'rendered_markdown',
                    rendered_markdown,
                    'create_at',
                    create_at,
                    'source_form',
                    json(source_form),
                    'form_snapshot',
                    json(form_snapshot),
                    'revision',
                    revision,
                    'edited_at',
                    edited_at
                )
            )
        FROM (
            SELECT
                *
            FROM shape_form_submission_model
            WHERE shape_id = $1
            ORDER BY create_at, id
        )
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let mut request = vertex_request(
        &initial,
        json!([[139, 35], [139.5, 35.5], [140, 36]]),
        "polyline",
    );
    // JS/JSON may spell stored integer coordinates as decimals or exponents.
    request["base_geometry"] =
        serde_json::from_str(r#"{"coordinates":[[139.0,35e0],[140,36.00]],"type":"LineString"}"#)
            .unwrap();
    let path = format!("/shape/{id}/geometry");
    let saved = ok(&app, user, "PUT", &path, Some(request.clone())).await;
    assert_eq!(
        saved["geojson"]["properties"],
        before["geojson"]["properties"]
    );
    assert_eq!(saved["name"], before["name"]);
    assert_eq!(saved["layer_id"], before["layer_id"]);
    let after = stored_shape(&pool, id).await;
    assert_eq!(after["form_body_parts"], before["form_body_parts"]);
    let after_answers: Value = sqlx::query_scalar(
        r#"
        SELECT
            json_group_array(
                json_object(
                    'id',
                    id,
                    'shape_id',
                    shape_id,
                    'submitted_values',
                    json(submitted_values),
                    'rendered_markdown',
                    rendered_markdown,
                    'create_at',
                    create_at,
                    'source_form',
                    json(source_form),
                    'form_snapshot',
                    json(form_snapshot),
                    'revision',
                    revision,
                    'edited_at',
                    edited_at
                )
            )
        FROM (
            SELECT
                *
            FROM shape_form_submission_model
            WHERE shape_id = $1
            ORDER BY create_at, id
        )
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(answers, after_answers);
    let page = ok(
        &app,
        user,
        "POST",
        "/form-answers/search",
        Some(json!({"target_type":"shape","target_id":id})),
    )
    .await;
    assert_eq!(page["total"], 2);
    assert!(
        page["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["submitted_values"]["n"] == 3)
    );
    // A stale geometry cannot overwrite a newer geometry.
    assert_eq!(
        call(&app, Some(user), "PUT", &path, Some(request)).await.0,
        StatusCode::CONFLICT
    );
    let current = vertex_request(&after, json!([[139, 35], [140, 36]]), "polyline");
    assert_eq!(
        call(&app, Some(other), "PUT", &path, Some(current.clone()))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert!(
        !call(&app, None, "PUT", &path, Some(current.clone()))
            .await
            .0
            .is_success()
    );
    for field in [
        "geojson",
        "memo",
        "free_text",
        "body_token",
        "style",
        "name",
        "layer_id",
    ] {
        let mut mixed = current.clone();
        mixed[field] = json!("injected");
        assert_eq!(
            call(&app, Some(user), "PUT", &path, Some(mixed)).await.0,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{field}"
        );
    }
    let invalid = vertex_request(&after, json!([[139, 35]]), "polyline");
    assert_eq!(
        call(&app, Some(user), "PUT", &path, Some(invalid)).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut mixed_body = after["geojson"].clone();
    mixed_body["properties"]["memo"] = json!("直接入力");
    assert_eq!(
        call(
            &app,
            Some(user),
            "PUT",
            &format!("/shape/{id}"),
            Some(json!({"name":"変更","geojson":mixed_body}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut modified_style = after["geojson"].clone();
    modified_style["properties"]["style"]["weight"] = json!(8);
    assert_eq!(
        call(
            &app,
            Some(user),
            "PUT",
            &format!("/shape/{id}"),
            Some(json!({"name":"変更","geojson":modified_style}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(stored_shape(&pool, id).await, after);
    common::close_file_test_pool(pool, temporary_path).await;
}

#[tokio::test]
async fn vertex_updates_validate_types_limits_and_rectangle_conversion() {
    let (pool, temporary_path) = common::file_test_pool().await;
    let user = test_user(&pool, "vertex-types").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let l = layer(&app, user, "types").await;
    for restricted in [false, true] {
        ok(
            &app,
            user,
            "PUT",
            &format!("/layer/{l}/input-policy"),
            Some(json!({"restrict_free_text":restricted})),
        )
        .await;
        for kind in ["polyline", "polygon", "rectangle", "circle"] {
            let geometry = match kind {
                "polyline" => json!({"type":"LineString","coordinates":[[139,35],[140,36]]}),
                "circle" => json!({"type":"Point","coordinates":[139,35]}),
                _ => {
                    json!({"type":"Polygon","coordinates":[[[139,35],[140,35],[140,36],[139,36],[139,35]]]})
                },
            };
            let created=ok(&app,user,"POST","/shape",Some(json!({"layer_id":l,"shape_type":kind,"name":"対象","geojson":{"type":"Feature","properties":{"memo":"","radius":100},"geometry":geometry}}))).await;
            let id = Uuid::parse_str(created["id"].as_str().unwrap()).unwrap();
            let original = stored_shape(&pool, id).await;
            let coords = match kind {
                "polyline" => json!([[139, 35], [139.5, 35.5], [140, 36]]),
                "circle" => json!([139.5, 35.5]),
                _ => json!([[
                    [139, 35],
                    [140, 35],
                    [140, 36],
                    [139, 36],
                    [139, 35.5],
                    [139, 35]
                ]]),
            };
            let next_type = if kind == "rectangle" { "polygon" } else { kind };
            let path = format!("/shape/{id}/geometry");
            let req = vertex_request(&original, coords, next_type);
            if kind == "circle" {
                assert_eq!(
                    call(&app, Some(user), "PUT", &path, Some(req)).await.0,
                    StatusCode::BAD_REQUEST
                );
                continue;
            }
            let added = ok(&app, user, "PUT", &path, Some(req)).await;
            assert_eq!(added["shape_type"], next_type);
            assert_eq!(
                added["geojson"]["properties"],
                original["geojson"]["properties"]
            );
            let minimum = if kind == "polyline" {
                json!([[139, 35], [140, 36]])
            } else {
                json!([[[139, 35], [140, 35], [140, 36], [139, 35]]])
            };
            let deleted = ok(
                &app,
                user,
                "PUT",
                &path,
                Some(vertex_request(&added, minimum, next_type)),
            )
            .await;
            let too_small = if kind == "polyline" {
                json!([[139, 35]])
            } else {
                json!([[[139, 35], [140, 35], [139, 35]]])
            };
            assert_eq!(
                call(
                    &app,
                    Some(user),
                    "PUT",
                    &path,
                    Some(vertex_request(&deleted, too_small, next_type))
                )
                .await
                .0,
                StatusCode::BAD_REQUEST
            );
            let mut invalid = vertex_request(
                &deleted,
                deleted["geojson"]["geometry"]["coordinates"].clone(),
                "circle",
            );
            assert_eq!(
                call(&app, Some(user), "PUT", &path, Some(invalid.clone()))
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
            invalid["shape_type"] = json!(next_type);
            invalid["coordinates"] = json!([[999, 35], [140, 36]]);
            assert_eq!(
                call(&app, Some(user), "PUT", &path, Some(invalid)).await.0,
                StatusCode::BAD_REQUEST
            );
            assert_eq!(stored_shape(&pool, id).await["geojson"], deleted["geojson"]);
        }
    }
    common::close_file_test_pool(pool, temporary_path).await;
}

#[tokio::test]
async fn concurrent_vertices_and_form_posts_preserve_each_others_data() {
    let (pool, temporary_path) = common::file_test_pool().await;
    let user = test_user(&pool, "vertex-concurrency").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let l = layer(&app, user, "concurrent-vertices").await;
    let id = shape(&app, user, l).await;
    save_config(&app, user, "shape", id, definition("点検")).await;
    ok(
        &app,
        user,
        "PUT",
        &format!("/layer/{l}/input-policy"),
        Some(json!({"restrict_free_text":true})),
    )
    .await;
    let initial = stored_shape(&pool, id).await;
    let path = format!("/shape/{id}/geometry");
    let a = vertex_request(
        &initial,
        json!([[139, 35], [139.4, 35.4], [140, 36]]),
        "polyline",
    );
    let b = vertex_request(
        &initial,
        json!([[139, 35], [139.6, 35.6], [140, 36]]),
        "polyline",
    );
    let (a, b) = tokio::join!(
        call(&app, Some(user), "PUT", &path, Some(a)),
        call(&app, Some(user), "PUT", &path, Some(b))
    );
    assert!(matches!(
        (a.0, b.0),
        (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
    ));
    let current = stored_shape(&pool, id).await;
    assert_eq!(
        current["geojson"]["properties"],
        initial["geojson"]["properties"]
    );
    let coords = json!([[139, 35], [139.7, 35.7], [140, 36]]);
    let request = vertex_request(&current, coords.clone(), "polyline");
    let (_, saved) = tokio::join!(
        owner_post(&app, user, "shape", id, "9"),
        call(&app, Some(user), "PUT", &path, Some(request))
    );
    assert_eq!(saved.0, StatusCode::OK);
    let final_shape = stored_shape(&pool, id).await;
    assert_eq!(final_shape["geojson"]["geometry"]["coordinates"], coords);
    assert_eq!(
        final_shape["geojson"]["properties"]["style"],
        initial["geojson"]["properties"]["style"]
    );
    let info = ok(&app, user, "GET", &format!("/shape/{id}/form/body"), None).await;
    assert_eq!(info["sync_required"], false);
    assert_eq!(info["free_text"].as_str().unwrap().trim(), "元のメモ");
    assert!(info["managed_markdown"].as_str().unwrap().contains('9'));
    assert_eq!(info["body"], final_shape["geojson"]["properties"]["memo"]);
    common::close_file_test_pool(pool, temporary_path).await;
}

#[tokio::test]
async fn risk_layer_icon_ownership_and_invalid_updates_preserve_saved_layer() {
    let pool = common::test_pool().await;
    let owner = test_user(&pool, "risk-layer-owner").await;
    let other = test_user(&pool, "risk-layer-other").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let id = layer(&app, owner, "original").await;
    let own_icon = Uuid::new_v4();
    let foreign_icon = Uuid::new_v4();
    for (icon, user) in [(own_icon, owner), (foreign_icon, other)] {
        sqlx::query(
            r#"
            INSERT INTO marker_icon_model (
                id,
                user_id,
                filename,
                uuid_filename,
                create_at
            ) VALUES ($1, $2, 'icon.png', $3, '2026-01-01 00:00:00')
            "#,
        )
        .bind(icon.to_string())
        .bind(user.to_string())
        .bind(format!("{icon}.png"))
        .execute(&pool)
        .await
        .unwrap();
    }
    ok(
        &app,
        owner,
        "PUT",
        &format!("/layer/update/{id}"),
        Some(json!({"name":"original","marker_icon_id":own_icon,"update_marker_icon":true})),
    )
    .await;
    let before: Value = sqlx::query_scalar(
        r#"
        SELECT
            json_object(
                'id',
                id,
                'user_id',
                user_id,
                'layer_name',
                layer_name,
                'is_master',
                is_master,
                'create_at',
                create_at,
                'update_at',
                update_at,
                'marker_icon_id',
                marker_icon_id,
                'common_form_id',
                common_form_id,
                'common_form_version',
                common_form_version,
                'form_binding_revision',
                form_binding_revision,
                'restrict_free_text',
                restrict_free_text
            )
        FROM layer_model
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    for (actor, body, expected) in [
        (
            owner,
            json!({"name":"  ","update_marker_icon":true,"marker_icon_id":null}),
            StatusCode::BAD_REQUEST,
        ),
        (
            owner,
            json!({"name":"changed","update_marker_icon":true,"marker_icon_id":foreign_icon}),
            StatusCode::BAD_REQUEST,
        ),
        (
            owner,
            json!({"name":"changed","update_marker_icon":true,"marker_icon_id":Uuid::new_v4()}),
            StatusCode::BAD_REQUEST,
        ),
        (other, json!({"name":"changed"}), StatusCode::BAD_REQUEST),
    ] {
        let (status, result) = call(
            &app,
            Some(actor),
            "PUT",
            &format!("/layer/update/{id}"),
            Some(body),
        )
        .await;
        assert_eq!(status, expected, "{result}");
        let after: Value = sqlx::query_scalar(
            r#"
            SELECT
                json_object(
                    'id',
                    id,
                    'user_id',
                    user_id,
                    'layer_name',
                    layer_name,
                    'is_master',
                    is_master,
                    'create_at',
                    create_at,
                    'update_at',
                    update_at,
                    'marker_icon_id',
                    marker_icon_id,
                    'common_form_id',
                    common_form_id,
                    'common_form_version',
                    common_form_version,
                    'form_binding_revision',
                    form_binding_revision,
                    'restrict_free_text',
                    restrict_free_text
                )
            FROM layer_model
            WHERE id = $1
            "#,
        )
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, before, "rejected layer update changed stored state");
    }
    ok(
        &app,
        owner,
        "PUT",
        &format!("/layer/update/{id}"),
        Some(json!({"name":" renamed ","update_marker_icon":true,"marker_icon_id":null})),
    )
    .await;
    let saved: (String, Option<String>) = sqlx::query_as(
        r#"
        SELECT
            layer_name,
            marker_icon_id
        FROM layer_model
        WHERE id = $1
        "#,
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(saved, ("renamed".into(), None));
}

#[tokio::test]
async fn risk_invalid_shape_destinations_preserve_geometry_body_answers_and_config() {
    let pool = common::test_pool().await;
    let owner = test_user(&pool, "risk-shape-owner").await;
    let other = test_user(&pool, "risk-shape-other").await;
    let app = geocode_web_single::router::build_router(
        pool.clone(),
        geocode_web_single::build_tera_extension().unwrap(),
        None,
    );
    let source = layer(&app, owner, "source").await;
    let foreign = layer(&app, other, "foreign").await;
    let id = shape(&app, owner, source).await;
    save_config(&app, owner, "shape", id, definition("preserved")).await;
    owner_post(&app, owner, "shape", id, "1").await;
    let before = stored_shape(&pool, id).await;
    let config_before = config(&app, owner, "shape", id).await;
    let answers_before = saved_answer_rows(&pool, id).await;
    for destination in [foreign, Uuid::new_v4()] {
        let (status, body) = call(
            &app,
            Some(owner),
            "PUT",
            &format!("/shape/{id}"),
            Some(json!({"name":"changed","layer_id":destination})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(stored_shape(&pool, id).await, before);
        assert_eq!(config(&app, owner, "shape", id).await, config_before);
        let answers_after = saved_answer_rows(&pool, id).await;
        assert_eq!(answers_after, answers_before);
    }
}

async fn saved_answer_rows(pool: &SqlitePool, id: Uuid) -> Vec<Vec<String>> {
    use sqlx::{Row, ValueRef};
    sqlx::query(
        r#"
        SELECT
            *
        FROM shape_form_submission_model
        WHERE shape_id = $1
        ORDER BY id
        "#,
    )
    .bind(id.to_string())
    .fetch_all(pool)
    .await
    .unwrap()
    .iter()
    .map(|row| {
        (0..row.len())
            .map(|i| {
                if row.try_get_raw(i).unwrap().is_null() {
                    "NULL".to_string()
                } else {
                    format!(
                        "{:?}",
                        row.try_get::<String, _>(i)
                            .unwrap_or_else(|_| row.get::<i64, _>(i).to_string())
                    )
                }
            })
            .collect()
    })
    .collect()
}
