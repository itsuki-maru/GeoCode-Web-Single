use super::*;
use chrono::{Duration, FixedOffset};

fn id(value: u128) -> String {
    Uuid::from_u128(value).to_string()
}

struct Fixture {
    pool: SqlitePool,
    user: String,
    marker: String,
    second_marker: String,
    form: String,
    foreign_form: String,
    layer: String,
    foreign_layer: String,
    at: DateTime<Utc>,
}

async fn fixture() -> Fixture {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    // Only the source columns are needed here. Existing integration tests use
    // the complete migrated schema; this fixture isolates projection behavior.
    sqlx::raw_sql(
        r#"
        CREATE TABLE layer_model (id TEXT PRIMARY KEY, user_id TEXT, layer_name TEXT);

        CREATE TABLE common_form_model (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            form_title TEXT,
            deleted BOOLEAN
        );

        CREATE TABLE marker_info_model (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            marker_name TEXT,
            layer_id TEXT
        );

        CREATE TABLE shape_model (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, layer_id TEXT);

        CREATE TABLE marker_form_submission_model (
            id TEXT PRIMARY KEY,
            marker_id TEXT,
            create_at TEXT,
            edited_at TEXT,
            revision INTEGER,
            submitted_values TEXT,
            form_snapshot TEXT,
            source_form TEXT
        );

        CREATE TABLE shape_form_submission_model (
            id TEXT PRIMARY KEY,
            shape_id TEXT,
            create_at TEXT,
            edited_at TEXT,
            revision INTEGER,
            submitted_values TEXT,
            form_snapshot TEXT,
            source_form TEXT
        );
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let f = Fixture {
        pool,
        user: id(1),
        marker: id(10),
        second_marker: id(11),
        form: id(20),
        foreign_form: id(21),
        layer: id(30),
        foreign_layer: id(31),
        at: DateTime::parse_from_rfc3339("2026-10-01T00:00:05Z")
            .unwrap()
            .with_timezone(&Utc),
    };
    for (layer, owner) in [(&f.layer, f.user.clone()), (&f.foreign_layer, id(2))] {
        sqlx::query(
            r#"
            INSERT INTO layer_model
            VALUES ($1, $2, 'レイヤ表示名')
            "#,
        )
        .bind(layer)
        .bind(owner)
        .execute(&f.pool)
        .await
        .unwrap();
    }
    for (form, owner) in [(&f.form, f.user.clone()), (&f.foreign_form, id(2))] {
        sqlx::query(
            r#"
            INSERT INTO common_form_model
            VALUES ($1, $2, '現在のフォーム名', true)
            "#,
        )
        .bind(form)
        .bind(owner)
        .execute(&f.pool)
        .await
        .unwrap();
    }
    for (target, owner, name, layer) in [
        (f.marker.clone(), f.user.clone(), "Zone Aa%_", &f.layer),
        (
            f.second_marker.clone(),
            f.user.clone(),
            "Zone BB",
            &f.foreign_layer,
        ),
        (id(12), id(2), "他人の対象", &f.layer),
    ] {
        sqlx::query(
            r#"
            INSERT INTO marker_info_model
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(target)
        .bind(owner)
        .bind(name)
        .bind(layer)
        .execute(&f.pool)
        .await
        .unwrap();
    }
    // Target and submission IDs may both coincide across marker and shape.
    sqlx::query(
        r#"
        INSERT INTO shape_model
        VALUES ($1, $2, NULL, NULL)
        "#,
    )
    .bind(&f.marker)
    .bind(&f.user)
    .execute(&f.pool)
    .await
    .unwrap();
    let snapshot = json!({"form_title":"投稿時の名前","form_schema":{"fields":[
        {"id":"n","type":"number","label":"数値"},
        {"id":"note","type":"textarea","label":"記録"}
    ]}});
    let base = f.at - Duration::seconds(5);
    for (kind, target, answer_id, offset, source, definition, values) in [
        (
            "marker",
            f.marker.clone(),
            100,
            0,
            Some(json!({"id":f.form,"version":1})),
            Some(snapshot.clone()),
            json!({"n":5,"note":"旧回答"}),
        ),
        (
            "marker",
            f.marker.clone(),
            101,
            2,
            Some(json!({"id":f.form,"version":2})),
            Some(snapshot.clone()),
            json!({"n":20,"note":"全文".repeat(600)}),
        ),
        (
            "shape",
            f.marker.clone(),
            101,
            2,
            Some(json!({"id":f.form,"version":1})),
            Some(snapshot.clone()),
            json!({"n":9,"note":"同時刻の図形"}),
        ),
        (
            "marker",
            f.second_marker.clone(),
            102,
            1,
            Some(json!({"id":f.form,"version":1})),
            Some(snapshot.clone()),
            json!({"n":0,"note":""}),
        ),
        (
            "marker",
            f.marker.clone(),
            103,
            3,
            None,
            None,
            json!({"legacy":"旧形式"}),
        ),
        (
            "marker",
            f.marker.clone(),
            104,
            4,
            Some(json!({"id":f.foreign_form,"version":1})),
            Some(snapshot.clone()),
            json!({"n":30}),
        ),
        (
            "marker",
            id(12),
            105,
            5,
            Some(json!({"id":f.form,"version":1})),
            Some(snapshot.clone()),
            json!({"n":999}),
        ),
        (
            "shape",
            f.marker.clone(),
            106,
            6,
            Some(json!({"id":f.form,"version":2})),
            Some(snapshot),
            json!({"n":40}),
        ),
    ] {
        let at = base + Duration::seconds(offset);
        let timestamp = if kind == "shape" {
            at.with_timezone(&FixedOffset::east_opt(9 * 3600).unwrap())
                .to_rfc3339()
        } else {
            at.naive_utc().to_string()
        };
        sqlx::query(&format!(
            r#"
            INSERT INTO {kind}_form_submission_model
            VALUES ($1, $2, $3, $4, 2, $5, $6, $7)
            "#
        ))
        .bind(id(answer_id))
        .bind(target)
        .bind(timestamp)
        .bind((base + Duration::seconds(3)).naive_utc())
        .bind(values)
        .bind(definition)
        .bind(source)
        .execute(&f.pool)
        .await
        .unwrap();
    }
    // Exercise the existing limit=100 API and the extra pagination sentinel.
    for n in 0..110 {
        sqlx::query(
            r#"
            INSERT INTO marker_form_submission_model
            VALUES ($1, $2, $3, NULL, 1, $4, NULL, NULL)
            "#,
        )
        .bind(id(1000 + n))
        .bind(&f.second_marker)
        .bind((base - Duration::seconds(100 + n as i64)).naive_utc())
        .bind(json!({"legacy":format!("bulk{n}")}))
        .execute(&f.pool)
        .await
        .unwrap();
    }
    f
}

// This is the previous search path: full joined rows participate in both
// count and page selection. It is independent of the new ID/detail stages.
async fn full_search_page(f: &Fixture, q: &AnswerQuery) -> AnswerPage {
    let at = q.as_of.unwrap();
    let mut tx = super::super::answer_sqlite::begin_read(&f.pool)
        .await
        .unwrap();
    let (total, target_count) = build_query(&f.user, q, at)
        .push(
            r#"
            SELECT
                count(*),
                count(DISTINCT target_type || ':' || target_id)
            FROM filtered
            "#,
        )
        .build_query_as::<(i64, i64)>()
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let mut b = build_query(&f.user, q, at);
    append_page_query(&mut b, q, ROW_COLUMNS);
    let mut rows: Vec<AnswerRow> = b.build_query_as().fetch_all(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let next_cursor = if rows.len() > q.limit.unwrap_or(50) as usize {
        rows.truncate(q.limit.unwrap_or(50) as usize);
        rows.last().map(|r| AnswerCursor {
            at: r.create_at,
            id: r.id.clone(),
            target_type: r.target_type.clone(),
        })
    } else {
        None
    };
    AnswerPage {
        editing_supported: true,
        rows,
        total,
        target_count,
        as_of: at,
        next_cursor,
    }
}

async fn compare_search(f: &Fixture, q: AnswerQuery) -> AnswerPage {
    let expected = full_search_page(f, &q).await;
    let actual = search_answers_handler(
        Extension(f.user.clone()),
        Extension(f.pool.clone()),
        Json(q.clone()),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(
        serde_json::to_value(&actual).unwrap(),
        serde_json::to_value(&expected).unwrap(),
        "query: {q:?}"
    );
    actual
}

#[tokio::test]
async fn projected_search_matches_full_rows_for_filters_metadata_and_limits() {
    let f = fixture().await;
    for value in [
        json!({}),
        json!({"mode":"history"}),
        json!({"mode":"latest"}),
        json!({"common_form_id":f.form,"version":1}),
        json!({"mode":"latest","common_form_id":f.form,"version":1}),
        json!({"mode":"latest","common_form_id":f.form,"until":f.at - Duration::seconds(3)}),
        json!({"common_form_id":f.form,"from":f.at - Duration::seconds(4),"until":f.at - Duration::seconds(2)}),
        json!({"individual_only":true}),
        json!({"common_form_id":f.foreign_form}),
        json!({"layer_id":f.layer}),
        json!({"layer_id":f.foreign_layer}),
        json!({"target_name":"zone"}),
        json!({"target_name":"%_"}),
        json!({"target_name":"名称"}),
        json!({"target_type":"marker","target_id":f.marker}),
        json!({"target_type":"shape","target_id":f.marker}),
        json!({"target_type":"marker","target_id":id(999)}),
        json!({"target_type":"marker","target_id":f.second_marker,"individual_only":true,"conditions":[{"field_id":"legacy","field_type":"unknown","op":"contains","value":"bulk"}]}),
        json!({"mode":"latest","common_form_id":f.form,"conditions":[{"field_id":"n","field_type":"number","op":"gte","value":"10"}]}),
        json!({"common_form_id":f.form,"conditions":[{"field_id":"note","field_type":"textarea","op":"filled"}]}),
        json!({"limit":100}),
    ] {
        let mut q: AnswerQuery = serde_json::from_value(value).unwrap();
        q.as_of = Some(f.at);
        let page = compare_search(&f, q).await;
        assert!(page.rows.iter().all(|row| row.target_id != id(12)));
        for row in page.rows {
            if row.target_id == f.second_marker {
                assert!(row.layer_name.is_none());
            }
            if row
                .source_form
                .as_ref()
                .is_some_and(|source| source["id"] == f.foreign_form)
            {
                assert!(row.common_form_name.is_none());
                assert!(row.common_form_deleted.is_none());
            }
        }
    }
}

#[tokio::test]
async fn projected_search_preserves_tied_type_ids_across_cursor_pages() {
    let f = fixture().await;
    let mut q = AnswerQuery {
        common_form_id: Some(f.form.clone()),
        as_of: Some(f.at),
        limit: Some(1),
        ..Default::default()
    };
    let mut seen = Vec::new();
    loop {
        let page = compare_search(&f, q.clone()).await;
        seen.extend(page.rows.into_iter().map(|row| (row.target_type, row.id)));
        let Some(cursor) = page.next_cursor else {
            break;
        };
        q.cursor = Some(cursor);
    }
    assert_eq!(seen.len(), 4);
    assert_eq!(
        seen.iter()
            .filter(|(_, answer_id)| *answer_id == id(101))
            .count(),
        2
    );
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(seen.len(), unique.len());
}
