use crate::{
    backup::{self, Inventory},
    baseline, discovery, health,
    paths::scoped_path,
    transaction,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};

struct PreparedRestore {
    game: PathBuf,
    backup_id: String,
    safety_preview: Inventory,
}

#[derive(Default)]
pub struct RecoveryState(Mutex<HashMap<String, PreparedRestore>>);

#[derive(Serialize)]
pub struct BackupView {
    pub id: String,
    pub created_at: String,
    pub operation: String,
    pub total_bytes: u64,
    pub file_count: usize,
    pub scopes: Vec<String>,
    pub verified: bool,
    pub completed: bool,
    pub recoverable: bool,
}

#[derive(Serialize)]
pub struct RestorePreview {
    pub token: String,
    pub backup_id: String,
    pub backup_created_at: String,
    pub backup_bytes: u64,
    pub safety_snapshot_bytes: u64,
    pub file_count: usize,
    pub scopes: Vec<String>,
}

#[derive(Serialize)]
pub struct RestoreResult {
    pub restored_backup_id: String,
    pub safety_backup_id: String,
}

fn roots(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot resolve ii Engine local data directory")?;
    let backups = root.join("Backups");
    fs::create_dir_all(&backups).map_err(|_| "Cannot create backup directory")?;
    Ok((root, backups))
}

fn approved_bootstrap() -> Vec<String> {
    baseline::APPROVED_BOOTSTRAP
        .iter()
        .map(|value| (*value).into())
        .collect()
}

fn valid_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|c| c.is_ascii_hexdigit())
}

fn backup_directory(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid backup ID".into());
    }
    scoped_path(root, Path::new(id)).map_err(|_| "Unsafe backup directory".into())
}

#[tauri::command]
pub fn list_backups(app: AppHandle) -> Result<Vec<BackupView>, String> {
    let (_, root) = roots(&app)?;
    let mut result = Vec::new();
    for entry in fs::read_dir(&root).map_err(|_| "Cannot inspect backups")? {
        let entry = entry.map_err(|_| "Cannot inspect backup entry")?;
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !valid_id(&id) || !entry.path().is_dir() {
            continue;
        }
        let Ok(inventory) = backup::read_inventory(&entry.path()) else {
            continue;
        };
        if inventory.operation_id != id {
            continue;
        }
        let verified = backup::verify(&entry.path(), &inventory).is_ok();
        let completed = backup::completed(&entry.path(), &id);
        let recoverable = !completed && entry.path().join("journal.json").is_file();
        result.push(BackupView {
            id,
            created_at: inventory.created_at,
            operation: inventory.operation,
            total_bytes: inventory.total_bytes,
            file_count: inventory
                .entries
                .iter()
                .filter(|item| !item.directory)
                .count(),
            scopes: inventory.scopes,
            verified,
            completed,
            recoverable,
        });
    }
    result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(result)
}

#[tauri::command]
pub fn prepare_restore(
    app: AppHandle,
    state: State<'_, RecoveryState>,
    game_path: String,
    backup_id: String,
) -> Result<RestorePreview, String> {
    if health::running() {
        return Err("Close Gorilla Tag before preparing a restore".into());
    }
    let game = fs::canonicalize(&game_path).map_err(|_| "Cannot resolve selected game folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    let (_, root) = roots(&app)?;
    let directory = backup_directory(&root, &backup_id)?;
    let inventory = backup::read_inventory(&directory)?;
    if inventory.operation_id != backup_id {
        return Err("Backup identity mismatch".into());
    }
    backup::verify(&directory, &inventory)?;
    let approved = approved_bootstrap();
    let safety_preview = backup::preview(&game, &inventory.scopes, &approved, "restore-safety")?;
    let token = hex::encode(rand::random::<[u8; 16]>());
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Restore review state unavailable")?;
    if pending.len() >= 3 {
        return Err("Too many pending restore reviews; restart ii Engine".into());
    }
    pending.insert(
        token.clone(),
        PreparedRestore {
            game,
            backup_id: backup_id.clone(),
            safety_preview: safety_preview.clone(),
        },
    );
    Ok(RestorePreview {
        token,
        backup_id,
        backup_created_at: inventory.created_at,
        backup_bytes: inventory.total_bytes,
        safety_snapshot_bytes: safety_preview.total_bytes,
        file_count: inventory
            .entries
            .iter()
            .filter(|item| !item.directory)
            .count(),
        scopes: inventory.scopes,
    })
}

#[tauri::command]
pub async fn execute_restore(
    app: AppHandle,
    state: State<'_, RecoveryState>,
    token: String,
) -> Result<RestoreResult, String> {
    let prepared = state
        .0
        .lock()
        .map_err(|_| "Restore review state unavailable")?
        .remove(&token)
        .ok_or("Restore review expired; prepare it again")?;
    let (app_root, backups) = roots(&app)?;
    let approved = approved_bootstrap();
    tauri::async_runtime::spawn_blocking(move || {
        if health::running() {
            return Err("Close Gorilla Tag before restoring files".into());
        }
        let safety_backup_id = transaction::restore(
            &app_root,
            &prepared.game,
            &backups,
            &prepared.backup_id,
            &prepared.safety_preview,
            &approved,
        )?;
        Ok(RestoreResult {
            restored_backup_id: prepared.backup_id,
            safety_backup_id,
        })
    })
    .await
    .map_err(|_| "Restore worker stopped unexpectedly".to_string())?
}

#[tauri::command]
pub async fn resume_operation(
    app: AppHandle,
    game_path: String,
    operation_id: String,
) -> Result<(), String> {
    let game = fs::canonicalize(&game_path).map_err(|_| "Cannot resolve selected game folder")?;
    if !discovery::validate_game(&game).valid {
        return Err("Select a valid Gorilla Tag installation".into());
    }
    let (app_root, backups) = roots(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if health::running() {
            return Err("Close Gorilla Tag before resuming recovery".into());
        }
        transaction::resume(&app_root, &game, &backups, &operation_id)
    })
    .await
    .map_err(|_| "Recovery worker stopped unexpectedly".to_string())?
}
