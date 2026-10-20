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
    let rows:Vec<(Value,Value)>=sqlx::query_as("SELECT source_form,form_snapshot FROM marker_form_submission_model WHERE marker_id=$1 ORDER BY create_at,id").bind(id.to_string()).fetch_all(&pool).await.unwrap();
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
    let detail: String = sqlx::query_scalar("SELECT detail FROM marker_info_model WHERE id=$1")
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
        sqlx::query_scalar::<_, String>("SELECT detail FROM marker_info_model WHERE id=$1")
            .bind(id.to_string())
            .fetch_one(&pool)
            .await
            .unwrap(),
        detail
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM marker_form_submission_model WHERE marker_id=$1"
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
    sqlx::query("WITH RECURSIVE series(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM series WHERE i<10001) INSERT INTO marker_info_model(id,user_id,layer_id,marker_name,latitude,longitude,detail,create_at,update_at) SELECT printf('%08x-0000-4000-8000-%012x',i,i),$1,$2,'bulk',35,139,'',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM series").bind(user.to_string()).bind(layer.to_string()).execute(&pool).await.unwrap();
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
            "SELECT count(*) FROM marker_form_config_model WHERE managed_layer_id=$1"
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
    sqlx::query("UPDATE marker_form_config_model SET password_hash='legacy-hash',enabled=true WHERE marker_id=$1").bind(id.to_string()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO marker_form_submission_model(id,marker_id,submitted_values,rendered_markdown,create_at) VALUES($1,$2,'{\"n\":0,\"flag\":false}','legacy markdown',CURRENT_TIMESTAMP)").bind(Uuid::new_v4().to_string()).bind(id.to_string()).execute(&pool).await.unwrap();
    sqlx::raw_sql("DROP INDEX idx_layer_common_form; DROP INDEX idx_marker_form_managed_layer; DROP INDEX idx_shape_form_managed_layer; ALTER TABLE marker_form_config_model DROP COLUMN managed_layer_id; ALTER TABLE shape_form_config_model DROP COLUMN managed_layer_id; ALTER TABLE layer_model DROP COLUMN common_form_version; ALTER TABLE layer_model DROP COLUMN common_form_id; ALTER TABLE layer_model DROP COLUMN form_binding_revision; ALTER TABLE common_form_model DROP COLUMN password_hash; DELETE FROM schema_migrations WHERE version=18;").execute(&pool).await.unwrap();
    let before:(String,String,String,bool)=sqlx::query_as("SELECT public_id,form_schema,password_hash,enabled FROM marker_form_config_model WHERE marker_id=$1").bind(id.to_string()).fetch_one(&pool).await.unwrap();
    geocode_web_single::db::run_migrations(&pool).await.unwrap();
    geocode_web_single::db::run_migrations(&pool).await.unwrap();
    let after:(String,String,String,bool)=sqlx::query_as("SELECT public_id,form_schema,password_hash,enabled FROM marker_form_config_model WHERE marker_id=$1").bind(id.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(before, after);
    let after = config(&app, user, "marker", id).await;
    assert_eq!(cfg["public_path"], after["public_path"]);
    assert!(after["managed_layer_id"].is_null());
    let answer: Value = sqlx::query_scalar(
        "SELECT submitted_values FROM marker_form_submission_model WHERE marker_id=$1",
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(answer, json!({"n":0,"flag":false}));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM schema_migrations WHERE version=18")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
