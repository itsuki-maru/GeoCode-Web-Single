//! Opt-in browser fixture: real authenticated SQLite API, isolated temporary database.
//! Start with cargo test --test map_presets_browser -- --ignored --nocapture,
//! then run node scripts/check-map-presets-sqlite.mjs.
#[allow(dead_code)]
mod common;

use axum::routing::get;
use geocode_web_single::{auth::create_token, build_tera_extension, router::build_router};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::{Mutex, oneshot};
use uuid::Uuid;

#[tokio::test]
#[ignore = "manual browser check; waits for the browser harness to shut down"]
async fn serve_sqlite_map_presets_browser_fixture() {
    let (pool, database) = common::file_test_pool().await;
    let owner = common::create_test_user(&pool, "browser-owner").await;
    let other = common::create_test_user(&pool, "browser-other").await;
    let layer = common::master_layer_id(&pool, &owner).await;
    let form = Uuid::new_v4().to_string();
    let schema = json!({"fields":[{"id":"n","type":"number","label":"耐用年数"}]});
    sqlx::query(
        r#"
        INSERT INTO common_form_model (
            id,
            user_id,
            version,
            form_title,
            form_description,
            form_schema,
            create_at,
            update_at
        ) VALUES ($1, $2, 1, '設備点検', '', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(&form)
    .bind(&owner)
    .bind(&schema)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO common_form_revision_model (
            form_id,
            version,
            form_schema
        ) VALUES ($1, 1, $2)
        "#,
    )
    .bind(&form)
    .bind(&schema)
    .execute(&pool)
    .await
    .unwrap();
    for index in 0..10 {
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
                $4,
                35.68,
                139.76,
                '',
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            )
            "#,
        )
        .bind(&marker)
        .bind(&owner)
        .bind(&layer)
        .bind(format!("設備{}", index + 1))
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
                create_at,
                source_form,
                form_snapshot
            ) VALUES ($1, $2, $3, '', CURRENT_TIMESTAMP, $4, $5)
            "#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&marker)
        .bind(json!({"n":if index < 9 {60}else{20}}))
        .bind(json!({"id":form,"version":1}))
        .bind(json!({"form_title":"設備点検","form_schema":schema}))
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query(
        r#"
        DELETE FROM tileserver_model
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO tileserver_model (
            id,
            layer_name,
            label,
            url,
            attribution,
            include_foreign_tiles,
            min_zoom,
            max_zoom,
            create_at,
            updated_at
        ) VALUES (
            1,
            '検証地図',
            '検証地図',
            '/sqlite-check-tile.svg',
            'SQLite TEST',
            1,
            0,
            20,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (send, receive) = oneshot::channel();
    let shutdown = Arc::new(Mutex::new(Some(send)));
    let app = build_router(pool.clone(), build_tera_extension().unwrap(), None).route(
        "/__browser_check_shutdown",
        get(move || {
            let shutdown = shutdown.clone();
            async move {
                if let Some(send) = shutdown.lock().await.take() {
                    let _ = send.send(());
                }
                "done"
            }
        }),
    );
    let manifest = std::path::Path::new("target/preset-browser-ready.json");
    std::fs::write(
        manifest,
        serde_json::to_vec(&json!({
            "origin":format!("http://{address}"), "form_id":form,
            "owner_token":create_token(&owner, 30, "access_token", 0).unwrap(),
            "other_token":create_token(&other, 30, "access_token", 0).unwrap()
        }))
        .unwrap(),
    )
    .unwrap();
    println!("SQLite browser fixture is ready on {address}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(300), receive).await;
        })
        .await
        .unwrap();
    std::fs::remove_file(manifest).unwrap();
    common::close_file_test_pool(pool, database).await;
}
