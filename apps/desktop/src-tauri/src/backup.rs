use crate::paths::scoped_path;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_FILES: usize = 100_000;
const MAX_BYTES: u64 = 50 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub directory: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inventory {
    pub schema_version: u32,
    pub operation_id: String,
    pub operation: String,
    pub created_at: String,
    pub scopes: Vec<String>,
    pub entries: Vec<Entry>,
    pub total_bytes: u64,
}

pub struct OperationLock {
    _file: File,
}
impl OperationLock {
    pub fn acquire(app_root: &Path) -> Result<Self, String> {
        let path = scoped_path(app_root, Path::new("operation.lock"))
            .map_err(|_| "Unsafe operation lock path")?;
        let file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|_| "Cannot open operation lock")?;
        file.try_lock()
            .map_err(|_| "Another ii Engine operation is active")?;
        Ok(Self { _file: file })
    }
}

pub fn allowed(relative: &str, approved_bootstrap: &[String]) -> bool {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return false;
    }
    let first = path
        .components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().into_owned());
    matches!(first.as_deref(), Some("BepInEx" | "iisStupidMenu"))
        || (matches!(relative, "winhttp.dll" | "doorstop_config.ini")
            && approved_bootstrap.iter().any(|p| p == relative))
}

fn hash_file_once(path: &Path) -> Result<(u64, String), String> {
    let mut file = File::open(path).map_err(|_| "Cannot read file for verification")?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut count = 0u64;
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| "File verification interrupted")?;
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > MAX_BYTES {
            return Err("File exceeds backup limit".into());
        }
        hash.update(&buffer[..n]);
    }
    Ok((count, hex::encode(hash.finalize())))
}

pub fn hash_file(path: &Path) -> Result<(u64, String), String> {
    let mut last_error = String::from("Cannot read file for verification");
    for attempt in 0..4 {
        match hash_file_once(path) {
            Ok(result) => return Ok(result),
            Err(error) => {
                last_error = error;
                if !path.exists() {
                    break;
                }
                if attempt == 3 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100 * (1 << attempt)));
            }
        }
    }
    Err(last_error)
}

fn walk(
    root: &Path,
    relative: &Path,
    entries: &mut Vec<Entry>,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 || entries.len() >= MAX_FILES {
        return Err("Backup inventory exceeds scan limits".into());
    }
    let path = scoped_path(root, relative)
        .map_err(|_| "Backup scope contains an unsafe path or junction")?;
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Cannot inspect backup scope".into()),
    };
    let name = relative
        .to_str()
        .ok_or("Filename cannot be represented in the backup inventory")?
        .replace('\\', "/");
    if meta.is_dir() {
        entries.push(Entry {
            path: name,
            size: 0,
            sha256: String::new(),
            directory: true,
        });
        let mut children = fs::read_dir(path)
            .map_err(|_| "Cannot read backup directory")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Cannot read backup entry")?;
        children.sort_by_key(|e| e.file_name());
        for child in children {
            walk(root, &relative.join(child.file_name()), entries, depth + 1)?;
        }
    } else if meta.is_file() {
        let (size, sha256) = hash_file(&path).map_err(|error| {
            if error == "Cannot read file for verification"
                || error == "File verification interrupted"
            {
                format!("Antivirus is locking {name} for verification.")
            } else {
                error
            }
        })?;
        entries.push(Entry {
            path: name,
            size,
            sha256,
            directory: false,
        });
    } else {
        return Err("Unsupported backup file type".into());
    }
    Ok(())
}

pub fn preview(
    root: &Path,
    scopes: &[String],
    approved_bootstrap: &[String],
    operation: &str,
) -> Result<Inventory, String> {
    if scopes.is_empty() || scopes.len() > MAX_FILES {
        return Err("Invalid repair scope".into());
    }
    let mut checked: Vec<String> = Vec::new();
    for scope in scopes {
        if !allowed(scope, approved_bootstrap) {
            return Err("Repair scope is outside approved game components".into());
        }
        scoped_path(root, Path::new(scope)).map_err(|_| "Unsafe repair scope")?;
        let normalized = scope.replace('\\', "/");
        if checked.iter().any(|other| {
            normalized.eq_ignore_ascii_case(other)
                || normalized
                    .to_lowercase()
                    .starts_with(&(other.to_lowercase() + "/"))
                || other
                    .to_lowercase()
                    .starts_with(&(normalized.to_lowercase() + "/"))
        }) {
            return Err("Repair scopes overlap".into());
        }
        checked.push(normalized);
    }
    let mut entries = Vec::new();
    for scope in &checked {
        walk(root, Path::new(scope), &mut entries, 0)?;
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let total_bytes = entries
        .iter()
        .try_fold(0u64, |sum, e| sum.checked_add(e.size))
        .ok_or("Backup size overflow")?;
    if total_bytes > MAX_BYTES {
        return Err("Backup exceeds 50 GiB limit; no files changed".into());
    }
    Ok(Inventory {
        schema_version: 1,
        operation_id: hex::encode(rand::random::<[u8; 16]>()),
        operation: operation.into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        scopes: checked,
        entries,
        total_bytes,
    })
}

pub fn same_contents(a: &Inventory, b: &Inventory) -> bool {
    a.scopes == b.scopes && a.entries == b.entries
}

fn validate_inventory(inventory: &Inventory) -> Result<(), String> {
    if inventory.schema_version != 1
        || inventory.entries.len() > MAX_FILES
        || inventory.operation_id.len() != 32
        || !inventory
            .operation_id
            .bytes()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Err("Invalid backup inventory".into());
    }
    let mut paths = BTreeSet::new();
    let mut bytes = 0u64;
    for entry in &inventory.entries {
        if !paths.insert(entry.path.to_lowercase()) {
            return Err("Duplicate backup inventory path".into());
        }
        if entry.directory {
            if entry.size != 0 || !entry.sha256.is_empty() {
                return Err("Invalid directory inventory".into());
            }
        } else if entry.sha256.len() != 64 || !entry.sha256.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid backup digest".into());
        }
        bytes = bytes
            .checked_add(entry.size)
            .ok_or("Backup size overflow")?;
    }
    if bytes != inventory.total_bytes || bytes > MAX_BYTES {
        return Err("Invalid backup size".into());
    }
    Ok(())
}

pub fn verify(backup_dir: &Path, inventory: &Inventory) -> Result<(), String> {
    validate_inventory(inventory)?;
    let payload =
        scoped_path(backup_dir, Path::new("files")).map_err(|_| "Unsafe backup payload")?;
    if !payload.is_dir() {
        return Err("Backup payload is missing".into());
    }
    for entry in &inventory.entries {
        let path = scoped_path(&payload, Path::new(&entry.path))
            .map_err(|_| "Unsafe backup inventory path")?;
        if entry.directory {
            if !path.is_dir() {
                return Err("Backup directory is missing".into());
            }
        } else if hash_file(&path)? != (entry.size, entry.sha256.clone()) {
            return Err("Backup checksum mismatch; preserve it for manual recovery".into());
        }
    }
    Ok(())
}

pub fn create(
    root: &Path,
    backup_root: &Path,
    inventory: &Inventory,
    approved_bootstrap: &[String],
) -> Result<PathBuf, String> {
    validate_inventory(inventory)?;
    let current = preview(
        root,
        &inventory.scopes,
        approved_bootstrap,
        &inventory.operation,
    )?;
    if !same_contents(inventory, &current) {
        return Err("Game files changed after preview; review a fresh preview".into());
    }
    let destination = scoped_path(backup_root, Path::new(&inventory.operation_id))
        .map_err(|_| "Unsafe backup destination")?;
    fs::create_dir(&destination)
        .map_err(|_| "Cannot create a new backup; no game files changed")?;
    let payload = destination.join("files");
    fs::create_dir(&payload).map_err(|_| "Cannot create backup payload")?;
    for entry in &inventory.entries {
        let target =
            scoped_path(&payload, Path::new(&entry.path)).map_err(|_| "Unsafe backup target")?;
        if entry.directory {
            fs::create_dir_all(&target).map_err(|_| "Cannot create backup directory")?;
        } else {
            let source = scoped_path(root, Path::new(&entry.path))
                .map_err(|_| "Game path changed during backup")?;
            fs::create_dir_all(target.parent().ok_or("Missing backup parent")?)
                .map_err(|_| "Cannot create backup parent")?;
            let mut input = File::open(source).map_err(|_| "Cannot open backup source")?;
            let mut output = File::create_new(&target).map_err(|_| "Cannot create backup file")?;
            std::io::copy(&mut input, &mut output)
                .map_err(|_| "Backup copy failed; no game files changed")?;
            output.sync_all().map_err(|_| "Cannot flush backup")?;
        }
    }
    let bytes = serde_json::to_vec_pretty(inventory).map_err(|_| "Cannot encode inventory")?;
    let mut file = File::create_new(destination.join("inventory.json"))
        .map_err(|_| "Cannot write inventory")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot flush inventory")?;
    verify(&destination, inventory)?;
    let after = preview(
        root,
        &inventory.scopes,
        approved_bootstrap,
        &inventory.operation,
    )?;
    if !same_contents(inventory, &after) {
        return Err("Game files changed during backup; stop and review again".into());
    }
    Ok(destination)
}

pub fn read_inventory(directory: &Path) -> Result<Inventory, String> {
    let path = scoped_path(directory, Path::new("inventory.json"))
        .map_err(|_| "Unsafe backup inventory path")?;
    if fs::metadata(&path)
        .map_err(|_| "Backup inventory is missing")?
        .len()
        > 32 * 1024 * 1024
    {
        return Err("Backup inventory exceeds limit".into());
    }
    let inventory: Inventory =
        serde_json::from_slice(&fs::read(path).map_err(|_| "Cannot read backup inventory")?)
            .map_err(|_| "Invalid backup inventory")?;
    validate_inventory(&inventory)?;
    Ok(inventory)
}

pub fn completed(directory: &Path, id: &str) -> bool {
    let Ok(path) = scoped_path(directory, Path::new("completed.json")) else {
        return false;
    };
    if fs::metadata(&path).map(|m| m.len() > 4096).unwrap_or(true) {
        return false;
    }
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    value.get("operation_id").and_then(|v| v.as_str()) == Some(id)
        && value
            .get("completed_at")
            .and_then(|v| v.as_str())
            .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
}

pub fn prune_successful(backup_root: &Path) -> Result<usize, String> {
    let mut usable = Vec::new();
    for entry in fs::read_dir(backup_root).map_err(|_| "Cannot inspect backup retention")? {
        let entry = entry.map_err(|_| "Cannot inspect backup entry")?;
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let Ok(path) = scoped_path(backup_root, Path::new(&id)) else {
            continue;
        };
        if !path.is_dir() || !completed(&path, &id) {
            continue;
        }
        let Ok(inventory) = read_inventory(&path) else {
            continue;
        };
        if inventory.operation_id != id || verify(&path, &inventory).is_err() {
            continue;
        }
        let Ok(date) = chrono::DateTime::parse_from_rfc3339(&inventory.created_at) else {
            continue;
        };
        usable.push((date, id));
    }
    usable.sort_by(|a, b| b.cmp(a));
    let mut count = 0;
    for (_, id) in usable.into_iter().skip(3) {
        let path = scoped_path(backup_root, Path::new(&id))
            .map_err(|_| "Backup path changed before retention")?;
        let mut entries = Vec::new();
        walk(backup_root, Path::new(&id), &mut entries, 0)?;
        if entries.iter().any(|e| {
            let relative = e.path.strip_prefix(&(id.clone() + "/")).unwrap_or("");
            !relative.is_empty()
                && relative != "files"
                && !relative.starts_with("files/")
                && !["inventory.json", "journal.json", "completed.json"].contains(&relative)
        }) {
            continue;
        }
        fs::remove_dir_all(&path).map_err(|_| {
            "Old backup could not be pruned; all current recovery copies are preserved"
        })?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_snapshot_preserves_unknown_mods_and_detects_corruption() {
        let game = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();
        fs::create_dir_all(game.path().join("BepInEx/plugins")).unwrap();
        fs::write(
            game.path().join("BepInEx/plugins/unrelated.dll"),
            b"inert fixture",
        )
        .unwrap();
        fs::write(game.path().join("Gorilla Tag.exe"), b"never include").unwrap();
        let scopes = vec!["BepInEx".into()];
        let inventory = preview(game.path(), &scopes, &[], "full-repair").unwrap();
        assert_eq!(inventory.total_bytes, 13);
        assert!(inventory
            .entries
            .iter()
            .all(|e| e.path.starts_with("BepInEx")));
        let saved = create(game.path(), backups.path(), &inventory, &[]).unwrap();
        verify(&saved, &inventory).unwrap();
        fs::write(
            saved.join("files/BepInEx/plugins/unrelated.dll"),
            b"damaged",
        )
        .unwrap();
        assert!(verify(&saved, &inventory).is_err());
        assert!(game.path().join("Gorilla Tag.exe").is_file());
    }
    #[test]
    fn refuses_scope_escape_overlap_and_changed_preview() {
        let game = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();
        for scope in [
            "../outside",
            "Gorilla Tag_Data",
            "Gorilla Tag.exe",
            "UnityPlayer.dll",
        ] {
            assert!(preview(game.path(), &[scope.into()], &[], "repair").is_err());
        }
        assert!(preview(
            game.path(),
            &["BepInEx".into(), "BepInEx/plugins".into()],
            &[],
            "repair"
        )
        .is_err());
        fs::create_dir(game.path().join("iisStupidMenu")).unwrap();
        let inventory = preview(game.path(), &["iisStupidMenu".into()], &[], "repair").unwrap();
        fs::write(game.path().join("iisStupidMenu/settings.txt"), b"changed").unwrap();
        assert!(create(game.path(), backups.path(), &inventory, &[]).is_err());
        assert_eq!(fs::read_dir(backups.path()).unwrap().count(), 0);
    }
    #[test]
    fn lock_releases_on_drop_without_stale_lock_files() {
        let root = tempfile::tempdir().unwrap();
        let lock = OperationLock::acquire(root.path()).unwrap();
        assert!(OperationLock::acquire(root.path()).is_err());
        drop(lock);
        assert!(OperationLock::acquire(root.path()).is_ok());
    }

    #[test]
    fn hash_file_reads_regular_files_and_names_missing_paths() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("plugin.dll");
        fs::write(&path, b"ii-reborn-fixture").unwrap();
        let (size, digest) = hash_file(&path).unwrap();
        assert_eq!(size, 17);
        assert_eq!(digest.len(), 64);
        let missing = hash_file(&root.path().join("missing.dll")).unwrap_err();
        assert!(missing.contains("Cannot read file for verification"));
    }
    #[test]
    fn keeps_three_successful_backups_and_preserves_failed_operations() {
        let game = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();
        fs::create_dir(game.path().join("iisStupidMenu")).unwrap();
        let mut ids = Vec::new();
        for day in 1..=5 {
            let mut inventory =
                preview(game.path(), &["iisStupidMenu".into()], &[], "fixture").unwrap();
            inventory.created_at = format!("2026-09-{day:02}T00:00:00Z");
            let directory = create(game.path(), backups.path(), &inventory, &[]).unwrap();
            fs::write(directory.join("completed.json"),serde_json::to_vec(&serde_json::json!({"operation_id":inventory.operation_id,"completed_at":inventory.created_at})).unwrap()).unwrap();
            ids.push(inventory.operation_id);
        }
        let failed = preview(game.path(), &["iisStupidMenu".into()], &[], "incomplete").unwrap();
        create(game.path(), backups.path(), &failed, &[]).unwrap();
        assert_eq!(prune_successful(backups.path()).unwrap(), 2);
        assert!(ids[2..].iter().all(|id| backups.path().join(id).exists()));
        assert!(backups.path().join(failed.operation_id).exists());
        assert_eq!(prune_successful(backups.path()).unwrap(), 0);
    }
}
