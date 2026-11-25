//! 旧版の管理GUIで中断した移設を完了してから、新しい保存先設定に引き継ぐ。
use super::storage::{Locations, maps, validate_roots};
use super::*;
use crate::init;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MovePlan {
    config: PathBuf,
    old: Locations,
    next: Locations,
    files: BTreeMap<String, PathBuf>,
    binding: Signed<Plan>,
}
#[derive(Serialize, Deserialize)]
struct Pending {
    plan: Signed<MovePlan>,
    after: Snapshot,
    config_after: String,
}
pub(crate) fn pending_path(config: &Path) -> PathBuf {
    config.with_added_extension("relocation-pending.json")
}

// 元のカタログも残っている場合は、同じ登録・履歴を引き継いでいることを確認する。
fn check_old_catalog(
    old: &Locations,
    ctx: &Context,
    plan: &Plan,
    control: &mut Control<'_>,
) -> Result<(Vec<File>, Option<File>)> {
    if !old.catalog.try_exists().map_err(message)? || same(&binding(&old.catalog)?, &ctx.catalog) {
        return Ok((Vec::new(), None));
    }
    let pins = pin(&old.catalog, true)?;
    let owner = acquire_catalog_owner(&old.catalog, false)?;
    let db = open_readonly(&old.catalog)?;
    if stored_binding(&db)? != plan.previous
        || snapshot(&db, true, control)? != plan.catalog_contents
    {
        return Err(
            "選択したカタログと元のカタログで、対応先・地図登録・履歴が一致しません。".into(),
        );
    }
    Ok((pins, owner))
}

fn update_catalog(db: &Connection, plan: &MovePlan) -> Result<()> {
    let binding = &plan.binding.payload;
    if !same(&binding.previous, &binding.target) {
        db.execute(
            r#"
        UPDATE tile_catalog_binding
        SET app_database_path = ?1, app_file_id = ?2
        WHERE id = 1
    "#,
            (
                &binding.target.path.to_string_lossy(),
                &binding.target.file_id,
            ),
        )
        .map_err(message)?;
    }
    for (id, path) in &plan.files {
        let real = path.canonicalize().map_err(message)?;
        let root = super::super::physical_path(&plan.next.datasets)?;
        let (kind, location) = match real.strip_prefix(root) {
            Ok(relative) => ("managed", relative),
            Err(_) => ("external", real.as_path()),
        };
        let n = db
            .execute(
                r#"
            UPDATE local_tile_datasets
            SET storage_kind = ?1, database_path = ?2
            WHERE id = ?3
        "#,
                (kind, location.to_string_lossy(), id),
            )
            .map_err(message)?;
        if n != 1 {
            return Err("対象の地図登録が変更されました。".into());
        }
    }
    Ok(())
}
// 旧版がカタログ確定前に残した署名済み記録を最後まで回収する。
// 新しい保存先の選択には、実ファイルIDや移設記録を使用しない。
pub(super) fn recover(config: &Path) -> Result<Value> {
    let cancel = CancellationToken::new();
    let control = &mut Control {
        cancellation: &cancel,
        progress: &mut |_, _| Ok(()),
    };
    let _lock = init::lock_configuration(config).map_err(message)?;
    let pending = pending_path(config);
    let settings = init::read_relocation_settings(config).map_err(message)?;
    let raw = fs::read(config).map_err(message)?;
    let document: Value = serde_json::from_slice(&raw).map_err(message)?;
    let key = signing_key(&document, &settings)?;
    let journal: Signed<Pending> = read_document(&pending)?;
    verify(&key, "gui-pending", &journal)?;
    let saved = journal.payload;
    verify(&key, "gui-move", &saved.plan)?;
    let plan = &saved.plan.payload;
    verify(&key, "plan", &plan.binding)?;
    let core = &plan.binding.payload;
    if config.canonicalize().map_err(message)? != plan.config {
        return Err("別の設定ファイルの中断記録です。".into());
    }
    let config_hash = bytes_hash(&raw);
    let config_done = config_hash == saved.config_after;
    if !config_done && config_hash != core.config_sha256 {
        return Err("中断後に設定が変更されました。保存先を確認してください。".into());
    }
    let mut ctx = Context::with_locations(config, OpenFor::Maintenance, Some(&plan.next))?;
    if !same(&ctx.target, &core.target) || !same(&ctx.catalog, &core.catalog) {
        return Err("中断後に本体DBまたはカタログが置換されました。".into());
    }
    let _owner = acquire_owner(&ctx, true)?;
    let _old_catalog = check_old_catalog(&plan.old, &ctx, core, control)?;
    let _roots = validate_roots(&plan.next, &mut Vec::new(), &settings)?;
    let _original = verify_application(&ctx, core, control)?;
    let mut db = Connection::open_with_flags(&ctx.catalog.path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(message)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(message)?;
    let current = stored_binding(&tx)?;
    let contents = snapshot(&tx, true, control)?;
    let done = same(&current, &core.target) && contents == saved.after;
    if !done && (current != core.previous || contents != core.catalog_contents) {
        return Err("中断後にカタログが変更されました。".into());
    }
    let (maps, _pins) = maps(&tx, &plan.old, &plan.next, &plan.files)?;
    if let Some(map) = maps.iter().find(|m| m.error.is_some()) {
        return Err(format!(
            "「{}」の完成DBを確認してください。 {}",
            map.name,
            map.path.display()
        ));
    }
    let root = ctx
        .catalog
        .path
        .with_file_name(format!("catalog-relocation-{}", core.id));
    let _root = pin_directory(&root)?;
    let backup_db = open_readonly(&root.join("catalog.before.sqlite"))?;
    if stored_binding(&backup_db)? != core.previous
        || snapshot(&backup_db, true, control)? != core.catalog_contents
        || bytes_hash(&fs::read(root.join("settings.before.json")).map_err(message)?)
            != core.config_sha256
    {
        return Err("移設前のバックアップを検証できません。".into());
    }
    if !done {
        update_catalog(&tx, plan)?;
    }
    if snapshot(&tx, true, control)? != saved.after {
        return Err("中断記録と更新後のカタログが一致しません。".into());
    }
    let mut next_doc = document;
    if !config_done {
        next_doc = plan
            .next
            .document(&plan.old, next_doc, &settings.database_url)?;
        if (plan.old.database != plan.next.database || plan.old.catalog != plan.next.catalog)
            && ctx.replacement.as_ref().is_some_and(|rule| {
                !rule.matches(&ctx.target.path, &ctx.catalog.path, &ctx.catalog.file_id)
            })
        {
            next_doc
                .as_object_mut()
                .ok_or("設定JSONの形式が不正です。")?
                .remove("tile_database_replacement");
        }
        let mut bytes = serde_json::to_vec_pretty(&next_doc).map_err(message)?;
        bytes.push(b'\n');
        if bytes_hash(&bytes) != saved.config_after {
            return Err("中断記録と更新後の設定が一致しません。".into());
        }
    }
    ctx.recheck()?;
    tx.commit().map_err(message)?;
    if !config_done {
        ctx.config_pins.clear();
        init::write_to_json_file(config.to_owned(), &next_doc).map_err(message)?;
    }
    fs::remove_file(&pending).map_err(message)?;
    Ok(json!({"state":"succeeded","backup":root,"current":plan.next,"maps":maps}))
}
