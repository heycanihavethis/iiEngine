use crate::{
    backup::{self, Entry, Inventory, OperationLock},
    health,
    paths::scoped_path,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    schema_version: u32,
    game_root: PathBuf,
    original: Inventory,
    desired: Inventory,
    approved_bootstrap: Vec<String>,
}

fn ensure_idle() -> Result<(), String> {
    if health::running() {
        Err("Close Gorilla Tag before changing files".into())
    } else {
        Ok(())
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file =
        File::create_new(path).map_err(|_| "Cannot create operation journal or marker")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot flush operation journal or marker".into())
}

fn subset(inventory: &Inventory, scope: &str) -> Vec<Entry> {
    inventory
        .entries
        .iter()
        .filter(|entry| entry.path == scope || entry.path.starts_with(&(scope.to_owned() + "/")))
        .cloned()
        .collect()
}

fn contents(root: &Path, scope: &str, approved: &[String]) -> Result<Vec<Entry>, String> {
    Ok(backup::preview(root, &[scope.into()], approved, "verify")?.entries)
}

fn copy_inventory(source: &Path, destination: &Path, inventory: &Inventory) -> Result<(), String> {
    for entry in &inventory.entries {
        let to = scoped_path(destination, Path::new(&entry.path))
            .map_err(|_| "Unsafe staged destination")?;
        if entry.directory {
            fs::create_dir_all(&to).map_err(|_| "Cannot create staged directory")?;
        } else {
            let from =
                scoped_path(source, Path::new(&entry.path)).map_err(|_| "Unsafe staged source")?;
            fs::create_dir_all(to.parent().ok_or("Invalid stage parent")?)
                .map_err(|_| "Cannot create stage parent")?;
            let mut input = File::open(from).map_err(|_| "Cannot read verified stage source")?;
            let mut output = File::create_new(&to).map_err(|_| "Cannot create staged file")?;
            std::io::copy(&mut input, &mut output)
                .map_err(|_| "Staging failed; original game files are unchanged")?;
            output.sync_all().map_err(|_| "Cannot flush staged file")?;
            if backup::hash_file(&to)? != (entry.size, entry.sha256.clone()) {
                return Err("Staged checksum mismatch".into());
            }
        }
    }
    Ok(())
}

fn stage_root(journal: &Journal) -> Result<PathBuf, String> {
    let relative = format!("ii Engine/stage/{}", journal.original.operation_id);
    let path = scoped_path(&journal.game_root, Path::new(&relative))
        .map_err(|_| String::from("Unsafe operation stage path"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| String::from("Cannot create ii Engine stage folder"))?;
    }
    Ok(path)
}

fn apply(backup_dir: &Path, journal: &Journal) -> Result<(), String> {
    if journal.schema_version != 1 || journal.original.scopes != journal.desired.scopes {
        return Err("Invalid repair journal".into());
    }
    backup::verify(backup_dir, &journal.original)?;
    if scoped_path(backup_dir, Path::new("completed.json"))
        .map_err(|_| "Unsafe completion marker")?
        .exists()
    {
        return Ok(());
    }
    ensure_idle()?;
    let stage = stage_root(journal)?;
    let old_root =
        scoped_path(&stage, Path::new("old")).map_err(|_| "Unsafe rollback directory")?;
    let new_root = scoped_path(&stage, Path::new("new")).map_err(|_| "Unsafe staged directory")?;
    if !old_root.is_dir() || !new_root.is_dir() {
        return Err("Staged files are missing. Preserve the backup and use restore after reviewing a new preview.".into());
    }
    for scope in &journal.original.scopes {
        if !backup::allowed(scope, &journal.approved_bootstrap) {
            return Err("Journal scope is outside approved game components".into());
        }
        let original = subset(&journal.original, scope);
        let desired = subset(&journal.desired, scope);
        let current = contents(&journal.game_root, scope, &journal.approved_bootstrap)?;
        let old = contents(&old_root, scope, &journal.approved_bootstrap)?;
        let new = contents(&new_root, scope, &journal.approved_bootstrap)?;
        if current == desired && new.is_empty() && (old == original || original.is_empty()) {
            continue;
        }
        if !old.is_empty() && old != original {
            return Err("Rollback copy changed; stop and preserve operation files".into());
        }
        if new != desired {
            return Err("Verified stage changed; restore from the preserved backup".into());
        }
        let target =
            scoped_path(&journal.game_root, Path::new(scope)).map_err(|_| "Game scope changed")?;
        let rollback =
            scoped_path(&old_root, Path::new(scope)).map_err(|_| "Rollback scope changed")?;
        let staged =
            scoped_path(&new_root, Path::new(scope)).map_err(|_| "Staged scope changed")?;
        if old.is_empty() && !original.is_empty() {
            if current != original {
                return Err(
                    "Game files changed since preview. No further paths were changed.".into(),
                );
            }
            fs::create_dir_all(rollback.parent().ok_or("Invalid rollback parent")?)
                .map_err(|_| "Cannot create rollback parent")?;
            ensure_idle()?;
            fs::rename(&target,&rollback).map_err(|_| "Could not move original files to rollback staging. Keep the backup and resume after closing other programs.")?;
        } else if !current.is_empty() {
            return Err(
                "Unexpected files occupy the repair target; stop and review recovery".into(),
            );
        }
        if !desired.is_empty() {
            fs::create_dir_all(target.parent().ok_or("Invalid target parent")?)
                .map_err(|_| "Cannot create target parent")?;
            ensure_idle()?;
            fs::rename(&staged,&target).map_err(|_| "Could not activate staged files. Keep the backup and resume the interrupted operation.")?;
        }
        if contents(&journal.game_root, scope, &journal.approved_bootstrap)? != desired {
            return Err(
                "Installed files changed unexpectedly. Preserve the backup and stage for recovery."
                    .into(),
            );
        }
    }
    write_new(&backup_dir.join("completed.json"),serde_json::to_string(&serde_json::json!({
        "operation_id":journal.original.operation_id,"completed_at":chrono::Utc::now().to_rfc3339()
    })).map_err(|_| "Cannot encode completion marker")?.as_bytes())
}

pub fn execute(
    app_root: &Path,
    game: &Path,
    backup_root: &Path,
    preview: &Inventory,
    verified_source: &Path,
    approved_bootstrap: &[String],
) -> Result<String, String> {
    let _lock = OperationLock::acquire(app_root)?;
    ensure_idle()?;
    let desired = backup::preview(
        verified_source,
        &preview.scopes,
        approved_bootstrap,
        &preview.operation,
    )?;
    let backup_dir = backup::create(game, backup_root, preview, approved_bootstrap)?;
    let journal = Journal {
        schema_version: 1,
        game_root: fs::canonicalize(game).map_err(|_| "Cannot resolve game root")?,
        original: preview.clone(),
        desired,
        approved_bootstrap: approved_bootstrap.to_vec(),
    };
    let stage = stage_root(&journal)?;
    fs::create_dir_all(&stage)
        .map_err(|_| "Cannot create same-volume stage; game files remain unchanged")?;
    fs::create_dir_all(stage.join("old")).map_err(|_| "Cannot create rollback stage")?;
    fs::create_dir_all(stage.join("new")).map_err(|_| "Cannot create replacement stage")?;
    copy_inventory(verified_source, &stage.join("new"), &journal.desired)?;
    write_new(
        &backup_dir.join("journal.json"),
        &serde_json::to_vec_pretty(&journal).map_err(|_| "Cannot encode repair intent")?,
    )?;
    apply(&backup_dir, &journal)?;
    let _ = fs::remove_dir_all(&stage);
    Ok(preview.operation_id.clone())
}

pub fn resume(
    app_root: &Path,
    selected_game: &Path,
    backup_root: &Path,
    operation_id: &str,
) -> Result<(), String> {
    let _lock = OperationLock::acquire(app_root)?;
    if operation_id.len() != 32 || !operation_id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid operation ID".into());
    }
    let directory = scoped_path(backup_root, Path::new(operation_id))
        .map_err(|_| "Unsafe recovery directory")?;
    let path = scoped_path(&directory, Path::new("journal.json"))
        .map_err(|_| "Unsafe recovery journal")?;
    if fs::metadata(&path)
        .map_err(|_| "Recovery journal is missing")?
        .len()
        > 32 * 1024 * 1024
    {
        return Err("Recovery journal exceeds limit".into());
    }
    let journal: Journal =
        serde_json::from_slice(&fs::read(path).map_err(|_| "Cannot read recovery journal")?)
            .map_err(|_| "Recovery journal is incomplete; use verified backup restore")?;
    if journal.original.operation_id != operation_id {
        return Err("Recovery journal identity mismatch".into());
    }
    if fs::canonicalize(selected_game).map_err(|_| "Selected game directory is unavailable")?
        != fs::canonicalize(&journal.game_root)
            .map_err(|_| "Journal game directory is unavailable")?
    {
        return Err("Recovery journal belongs to a different game directory".into());
    }
    apply(&directory, &journal)
}

pub fn restore(
    app_root: &Path,
    game: &Path,
    backup_root: &Path,
    selected_id: &str,
    safety_preview: &Inventory,
    approved_bootstrap: &[String],
) -> Result<String, String> {
    if selected_id.len() != 32 || !selected_id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid backup ID".into());
    }
    let directory =
        scoped_path(backup_root, Path::new(selected_id)).map_err(|_| "Unsafe restore source")?;
    let path = scoped_path(&directory, Path::new("inventory.json"))
        .map_err(|_| "Unsafe restore inventory")?;
    if fs::metadata(&path)
        .map_err(|_| "Backup inventory is missing")?
        .len()
        > 32 * 1024 * 1024
    {
        return Err("Inventory exceeds limit".into());
    }
    let inventory: Inventory =
        serde_json::from_slice(&fs::read(path).map_err(|_| "Cannot read backup inventory")?)
            .map_err(|_| "Invalid backup inventory")?;
    if inventory.operation_id != selected_id || inventory.scopes != safety_preview.scopes {
        return Err("Restore scope does not match the reviewed safety snapshot".into());
    }
    backup::verify(&directory, &inventory)?;
    let payload =
        scoped_path(&directory, Path::new("files")).map_err(|_| "Unsafe backup payload")?;
    let actual = backup::preview(&payload, &inventory.scopes, approved_bootstrap, "restore")?;
    if actual.entries != inventory.entries {
        return Err("Backup contains unexpected or changed files".into());
    }
    execute(
        app_root,
        game,
        backup_root,
        safety_preview,
        &payload,
        approved_bootstrap,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replace_then_restore_with_safety_snapshot_and_idempotent_resume() {
        let app = tempfile::tempdir().unwrap();
        let game = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let backups = app.path().join("Backups");
        fs::create_dir(&backups).unwrap();
        for root in [game.path(), source.path()] {
            fs::create_dir_all(root.join("BepInEx/plugins")).unwrap();
        }
        fs::write(game.path().join("BepInEx/plugins/menu.dll"), b"old fixture").unwrap();
        fs::write(
            source.path().join("BepInEx/plugins/menu.dll"),
            b"new fixture",
        )
        .unwrap();
        fs::write(game.path().join("Gorilla Tag.exe"), b"untouched").unwrap();
        let review =
            backup::preview(game.path(), &["BepInEx".into()], &[], "fixture-repair").unwrap();
        let id = execute(
            app.path(),
            game.path(),
            &backups,
            &review,
            source.path(),
            &[],
        )
        .unwrap();
        assert_eq!(
            fs::read(game.path().join("BepInEx/plugins/menu.dll")).unwrap(),
            b"new fixture"
        );
        resume(app.path(), game.path(), &backups, &id).unwrap();
        let safety = backup::preview(game.path(), &["BepInEx".into()], &[], "restore").unwrap();
        let safety_id = restore(app.path(), game.path(), &backups, &id, &safety, &[]).unwrap();
        assert_ne!(id, safety_id);
        assert_eq!(
            fs::read(game.path().join("BepInEx/plugins/menu.dll")).unwrap(),
            b"old fixture"
        );
        assert_eq!(
            fs::read(game.path().join("Gorilla Tag.exe")).unwrap(),
            b"untouched"
        );
    }
    #[test]
    fn resumes_between_original_and_replacement_rename() {
        let app = tempfile::tempdir().unwrap();
        let game = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let backups = app.path().join("Backups");
        fs::create_dir(&backups).unwrap();
        for (root, bytes) in [(game.path(), b"old"), (source.path(), b"new")] {
            fs::create_dir(root.join("iisStupidMenu")).unwrap();
            fs::write(root.join("iisStupidMenu/settings"), bytes).unwrap();
        }
        let original =
            backup::preview(game.path(), &["iisStupidMenu".into()], &[], "fixture").unwrap();
        let desired = backup::preview(source.path(), &original.scopes, &[], "fixture").unwrap();
        let directory = backup::create(game.path(), &backups, &original, &[]).unwrap();
        let journal = Journal {
            schema_version: 1,
            game_root: game.path().to_path_buf(),
            original,
            desired,
            approved_bootstrap: vec![],
        };
        let stage = stage_root(&journal).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::create_dir(stage.join("new")).unwrap();
        fs::create_dir(stage.join("old")).unwrap();
        copy_inventory(source.path(), &stage.join("new"), &journal.desired).unwrap();
        write_new(
            &directory.join("journal.json"),
            &serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        fs::rename(
            game.path().join("iisStupidMenu"),
            stage.join("old/iisStupidMenu"),
        )
        .unwrap();
        resume(
            app.path(),
            game.path(),
            &backups,
            &journal.original.operation_id,
        )
        .unwrap();
        assert_eq!(
            fs::read(game.path().join("iisStupidMenu/settings")).unwrap(),
            b"new"
        );
    }
}
